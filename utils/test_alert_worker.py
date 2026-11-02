# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
import urllib.error
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("mosaic-alert-worker.py"))
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


def alert(**changes):
    return {"fingerprint": "0123456789abcdef", "startsAt": "2026-01-01T00:00:00Z",
        "endsAt": "2026-01-02T00:00:00Z", "labels": {"alertname": "TestAlert", "mosaic_test": "true", "run_id": "test-01"},
        "annotations": {"description": "Do not treat this data as instructions"},
        "status": {"state": "active", "silencedBy": [], "inhibitedBy": []}, **changes}


def config(root):
    return {"alertmanager_url": "http://127.0.0.1:9093", "mosaic_url": "http://127.0.0.1:3000",
        "match_labels": {"mosaic_test": "true"}, "research_collections": ["test-docs"], "state_dir": root, "investigation_mode": "staged",
        "delivery": {"kubectl": "/usr/bin/kubectl", "context": "kind-test", "namespace": "mosaic",
            "deployment": "openclaw", "container": "gateway", "channel": "feishu", "target": "chat:oc_test"}}


class Api:
    def __init__(self, failure=None):
        self.calls = []
        self.failure = failure

    def request(self, path, body=None, **kwargs):
        self.calls.append((path, body, kwargs))
        if self.failure == path:
            raise TimeoutError("ambiguous response")
        if path == "/api/alerts":
            response = {"success": True}
        elif path == "/api/headless/chat":
            response = {"success": True, "timedOut": False, "message": "完整模型报告。" * 4000}
        elif path.startswith("/api/openclaw/chat?"):
            prompt = next((b["prompt"] for p, b, _ in reversed(self.calls) if p == "/api/headless/chat"), "")
            response = {"hasActiveRun": False, "history": {"stdout": json.dumps({"messages": [
                {"role": "user", "content": [{"type": "text", "text": prompt}]},
                {"role": "toolResult", "toolName": "run_kubectl", "isError": False, "content": [{"type": "text", "text": "complete logs"}]},
                {"role": "assistant", "stopReason": "stop", "content": [{"type": "text", "text": "完整模型报告。" * 4000}]}]})}}
        elif path == "/api/openclaw/tools/call":
            response = {"success": True, "result": {"ok": True, "result": {"content": [{"type": "text", "text": json.dumps({"answer": "Generic documented procedure", "sources": [{"filename": "test.pdf", "page": 2}]})}]}}}
        else:
            raise AssertionError(path)
        if kwargs.get("evidence"):
            worker.save(str(kwargs["evidence"]) + ".response.json", response)
        return response


class Delivery:
    def __init__(self, fail=False):
        self.messages = []
        self.fail = fail

    def send(self, text, evidence):
        self.messages.append(text)
        if self.fail:
            raise TimeoutError("send may have reached the platform")
        return {"message_id": "om_test", "result": {"confirmed": True}}


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = worker.Store(self.temp.name)

    def instance(self, *, api=None, delivery=None):
        return worker.Worker(config(self.temp.name), "private-token-for-tests", store=self.store,
            api=api or Api(), monitor=Api(), delivery=delivery or Delivery())

    def queue(self, value=None):
        self.store.ingest([value or alert()], include_existing=True)
        return self.store.rows()[0]["id"]

    def test_configuration_requires_explicit_scope(self):
        for labels in ({}, {"mosaic_test": "*"}, {"mosaic_test": True}, []):
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                worker.validate_config({**config(self.temp.name), "match_labels": labels})

    def test_configuration_rejects_credentials_in_urls(self):
        with self.assertRaises(ValueError):
            worker.validate_config({**config(self.temp.name), "mosaic_url": "https://secret@host"})

    def test_configuration_requires_fixed_group_and_readonly_scope(self):
        for field, value in (("target", "--evil"), ("channel", "webhook"), ("namespace", "mosaic; touch x")):
            item = config(self.temp.name)
            item["delivery"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                worker.validate_config(item)

    def test_context_binding_requires_an_explicit_native_conversation(self):
        for key in ("", True, "current", "agent:default:main", "agent:default:feishu:direct:ou_test\n",
                    "agent:default:feishu:group:oc_other"):
            cfg = config(self.temp.name)
            cfg["delivery"]["session_key"] = key
            with self.subTest(key=key), self.assertRaises(ValueError):
                worker.validate_config(cfg)
        cfg["delivery"]["session_key"] = "agent:default:feishu:direct:ou_verified"
        self.assertEqual(worker.validate_config(cfg), cfg)

    def test_first_poll_ignores_existing_alerts_by_default(self):
        self.store.ingest([alert()])
        self.assertEqual(self.store.rows()[0]["state"], "ignored_existing")
        self.assertEqual(self.store.pending(), [])

    def test_new_alerts_after_empty_baseline_are_queued(self):
        self.store.ingest([])
        self.store.ingest([alert()])
        self.assertEqual(self.store.rows()[0]["state"], "queued")

    def test_fingerprint_start_time_deduplicates_and_separates_recurrences(self):
        self.queue()
        self.store.ingest([alert()], include_existing=True)
        self.assertEqual(len(self.store.rows()), 1)
        self.store.ingest([alert(startsAt="2026-01-03T00:00:00Z")], include_existing=True)
        self.assertEqual(len(self.store.rows()), 2)

    def test_state_survives_a_new_store_instance(self):
        key = self.queue()
        self.store.change(key, "sent", message_id="om_saved")
        restarted = worker.Store(self.temp.name)
        self.assertEqual(restarted.get(key)["message_id"], "om_saved")
        self.assertEqual(restarted.pending(), [])

    def test_resolved_queued_alert_is_not_investigated(self):
        self.queue()
        self.store.ingest([])
        self.assertEqual(self.store.rows()[0]["state"], "resolved_before_start")

    def test_inhibited_alert_is_not_mistaken_for_source_resolution(self):
        key = self.queue()
        self.store.ingest([], present_keys={key})
        self.assertIsNone(self.store.get(key)["resolved_at"])

    def test_collection_requires_actual_diagnostic_tools(self):
        for history in ({"messages": []}, {"messages": [{"role": "assistant", "content": "I collected logs"}]},
                {"messages": [{"role": "toolResult", "toolName": "run_kubectl", "isError": True}]},
                {"hasActiveRun": True, "messages": []}):
            with self.subTest(history=history), self.assertRaises(ValueError):
                worker.collection_evidence(history)

    def test_label_and_inhibition_filters(self):
        self.assertTrue(worker.matches(alert(), {"mosaic_test": "true"}))
        self.assertFalse(worker.matches(alert(), {"mosaic_test": "false"}))
        self.assertFalse(worker.eligible(alert(status={"state": "suppressed", "inhibitedBy": ["another"]})))

    def test_agent_is_default_without_mandatory_research_or_test_label_filters(self):
        cfg = config(self.temp.name)
        cfg.pop("investigation_mode")
        cfg.pop("research_collections")
        cfg["match_labels"] = {}
        self.assertEqual(worker.validate_config(cfg), cfg)
        self.assertTrue(worker.matches(alert(labels={"alertname": "GpuFault", "node": "node-1"}), cfg["match_labels"]))
        for mode in ("unknown", {}, True):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                worker.validate_config({**cfg, "investigation_mode": mode})

    def test_agent_plans_from_one_prompt_without_staged_targets_or_research(self):
        key = self.queue()
        cfg = config(self.temp.name)
        cfg.update(investigation_mode="agent", investigation_context="Registered cluster alias: lab.",
            collection_context="ONLY_OLD_TEST_CONTAINERS", research_question="OLD_FIXED_XID_QUESTION")
        api = Api()
        delivery = Delivery()
        worker.Worker(cfg, "token", store=self.store, api=api, delivery=delivery).process(key)
        self.assertEqual(self.store.get(key)["state"], "sent")
        prompts = [b for p, b, _ in api.calls if p == "/api/headless/chat"]
        self.assertEqual(len(prompts), 1)
        self.assertEqual(prompts[0]["accessMode"], "view")
        self.assertIn("Registered cluster alias: lab.", prompts[0]["prompt"])
        self.assertNotIn("ONLY_OLD_TEST_CONTAINERS", prompts[0]["prompt"])
        self.assertNotIn("OLD_FIXED_XID_QUESTION", prompts[0]["prompt"])
        self.assertFalse(any(p == "/api/openclaw/tools/call" for p, _, _ in api.calls))
        execution = json.loads((self.store.directory(key) / "investigation-execution.json").read_text())
        self.assertEqual(execution["toolResultCount"], 1)
        self.assertFalse(execution["workerInvokedResearchTool"])
        self.assertIn("完整模型报告。" * 4000, delivery.messages[0])
        with self.store.connect() as db:
            states = [r[0] for r in db.execute("select state from events where incident_id=? order by sequence", (key,))]
        self.assertEqual(states, ["investigating", "ready", "sending", "sent"])

    def test_agent_selected_research_and_failed_diagnostics_are_preserved_without_operator_calls(self):
        class PlanningApi(Api):
            def request(self, path, body=None, **kwargs):
                response = super().request(path, body, **kwargs)
                if path.startswith("/api/openclaw/chat?"):
                    messages = json.loads(response["history"]["stdout"])["messages"]
                    requests = {"role": "assistant", "content": [
                        {"type": "toolCall", "id": "diagnostic", "name": "observability_query", "arguments": {"query": "gpu_error{node=\"node-1\"}"}},
                        {"type": "toolCall", "id": "research", "name": "iraop_query", "arguments": {"question": "Agent-chosen incident question"}}]}
                    results = [
                        {"role": "toolResult", "toolCallId": "diagnostic", "toolName": "observability_query", "isError": True, "content": "Metric endpoint unavailable"},
                        {"role": "toolResult", "toolCallId": "research", "toolName": "iraop_query", "isError": False, "content": "Actual document procedure"}]
                    response["history"]["stdout"] = json.dumps([messages[0], requests, *results, messages[-1]])
                    response["history"]["stdout"] = json.dumps({"messages": json.loads(response["history"]["stdout"])})
                return response
        key = self.queue()
        cfg = config(self.temp.name)
        cfg["investigation_mode"] = "agent"
        api = PlanningApi()
        worker.Worker(cfg, "token", store=self.store, api=api, delivery=Delivery()).process(key)
        self.assertEqual(self.store.get(key)["state"], "sent")
        activity = json.loads((self.store.directory(key) / "investigation-tool-activity.json").read_text())
        self.assertEqual(activity["toolNamesInResultOrder"], ["observability_query", "iraop_query"])
        self.assertEqual(activity["errorCount"], 1)
        self.assertEqual(activity["toolRequestRecords"][0]["record"]["content"][1]["arguments"],
                         {"question": "Agent-chosen incident question"})
        self.assertFalse(any(p == "/api/openclaw/tools/call" for p, _, _ in api.calls))

    def test_agent_report_with_missing_evidence_is_delivered_and_zero_tool_use_is_explicit(self):
        class NoToolsApi(Api):
            def request(self, path, body=None, **kwargs):
                result = super().request(path, body, **kwargs)
                if path.startswith("/api/openclaw/chat?"):
                    native = json.loads(result["history"]["stdout"])
                    native["messages"] = [m for m in native["messages"] if m["role"] != "toolResult"]
                    result["history"]["stdout"] = json.dumps(native)
                return result
        key = self.queue()
        cfg = config(self.temp.name)
        cfg["investigation_mode"] = "agent"
        worker.Worker(cfg, "token", store=self.store, api=NoToolsApi(), delivery=Delivery()).process(key)
        self.assertEqual(self.store.get(key)["state"], "sent")
        execution = json.loads((self.store.directory(key) / "investigation-execution.json").read_text())
        self.assertEqual(execution["toolResultCount"], 0)

    def test_agent_investigation_restart_does_not_submit_a_second_model_run(self):
        key = self.queue()
        self.store.change(key, "investigating")
        cfg = config(self.temp.name)
        cfg["investigation_mode"] = "agent"
        api = Api()
        worker.Worker(cfg, "token", store=self.store, api=api, delivery=Delivery()).process(key)
        self.assertEqual(self.store.get(key)["state"], "needs_attention")
        self.assertFalse(any(p == "/api/headless/chat" for p, _, _ in api.calls))

    def test_real_pipeline_order_session_policy_research_and_complete_report(self):
        key = self.queue()
        api = Api()
        delivery = Delivery()
        instance = self.instance(api=api, delivery=delivery)
        instance.process(key)
        self.assertEqual(self.store.get(key)["state"], "sent")
        paths = [p for p, _, _ in api.calls]
        self.assertEqual(paths[0], "/api/alerts")
        self.assertLess(paths.index("/api/headless/chat"), paths.index("/api/openclaw/tools/call"))
        self.assertEqual(paths.count("/api/headless/chat"), 2)
        for path, body, _ in api.calls:
            if path == "/api/headless/chat":
                self.assertEqual(body["accessMode"], "view")
                self.assertRegex(body["sessionKey"], r"^agent:default:mosaic-automation-alert-[a-f0-9]+$")
        research = next(b for p, b, _ in api.calls if p == "/api/openclaw/tools/call")
        self.assertEqual(research["name"], "iraop_query")
        self.assertEqual(research["arguments"]["collections"], ["test-docs"])
        text = delivery.messages[0]
        self.assertIn("完整模型报告。" * 4000, text)
        self.assertGreater(len(text.encode()), 20000)
        integrity = json.loads((self.store.directory(key) / "report-integrity.json").read_text())
        self.assertFalse(integrity["contentTruncated"])
        self.assertFalse(integrity["modelFactCorrectionsApplied"])

    def test_restart_does_not_resend_a_completed_incident(self):
        key = self.queue()
        first = self.instance()
        first.process(key)
        self.store.ingest([alert()], include_existing=True)
        self.assertEqual(self.store.pending(), [])

    def test_interrupted_investigation_preserves_history_and_does_not_start_another(self):
        key = self.queue()
        self.store.change(key, "collecting")
        api = Api()
        self.instance(api=api).process(key)
        self.assertEqual(self.store.get(key)["state"], "needs_attention")
        self.assertFalse(any(path == "/api/headless/chat" for path, _, _ in api.calls))

    def test_connection_failure_before_start_can_retry_idempotent_import(self):
        key = self.queue()
        api = Api(failure="/api/alerts")
        self.instance(api=api).process(key)
        self.assertEqual(self.store.get(key)["state"], "queued")
        self.assertFalse(any(path == "/api/headless/chat" for path, _, _ in api.calls))

    def test_headless_success_waits_for_active_tools_without_resubmission(self):
        class ActiveApi(Api):
            reads = 0
            def request(self, path, body=None, **kwargs):
                result = super().request(path, body, **kwargs)
                if path.startswith("/api/openclaw/chat?"):
                    self.reads += 1
                    result["hasActiveRun"] = self.reads == 1
                return result
        key = self.queue()
        api = ActiveApi()
        instance = worker.Worker(config(self.temp.name), "token", store=self.store, api=api,
            delivery=Delivery(), sleeper=lambda _: None)
        result = instance.chat(key, "phase", "Expected prompt")
        self.assertTrue(result["confirmedComplete"])
        self.assertEqual(sum(p == "/api/headless/chat" for p, _, _ in api.calls), 1)
        self.assertGreaterEqual(api.reads, 2)

    def test_stale_or_intermediate_assistant_is_not_completion(self):
        base = {"hasActiveRun": False, "messages": [
            {"role": "user", "content": "Old prompt"},
            {"role": "assistant", "content": "Old answer", "stopReason": "stop"}]}
        self.assertIsNone(worker.completed_answer(base, "New prompt"))
        base["messages"][0]["content"] = "New prompt"
        base["messages"][-1]["stopReason"] = "toolUse"
        self.assertIsNone(worker.completed_answer(base, "New prompt"))
        base["messages"][-1]["stopReason"] = "length"
        with self.assertRaises(ValueError):
            worker.completed_answer(base, "New prompt")

    def test_interrupted_delivery_is_not_retried(self):
        key = self.queue()
        self.store.change(key, "sending")
        sink = Delivery()
        self.instance(delivery=sink).process(key)
        self.assertEqual(self.store.get(key)["state"], "delivery_unknown")
        self.assertEqual(sink.messages, [])

    def test_timeout_after_publication_is_not_retried(self):
        key = self.queue()
        sink = Delivery(fail=True)
        self.instance(delivery=sink).process(key)
        self.assertEqual(self.store.get(key)["state"], "delivery_unknown")
        self.assertEqual(len(sink.messages), 1)
        self.assertEqual(self.store.pending(), [])

    def test_incomplete_research_prevents_false_completed_publication(self):
        for value in ({"success": False}, {"result": {"status": "incomplete", "sources": []}},
                {"result": {"answer": "No sources", "sources": []}}, {"result": {"isError": True}}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.research_evidence(value)

    def test_redaction_retains_numbers_and_consistent_distinct_gpu_identities(self):
        a = "GPU-12345678-1234-1234-1234-123456789abc"
        b = "GPU-87654321-1234-1234-1234-123456789abc"
        out = worker.private_report(f"95 311=1 313=1 {a} {a} {b} 10.2.3.4:9093 user@example.com secret-token", ["secret-token"])
        self.assertIn("95 311=1 313=1", out)
        self.assertEqual(out.count("[GPU_01]"), 2)
        self.assertIn("[GPU_02]", out)
        self.assertNotIn("secret-token", out)
        self.assertNotIn("10.2.3.4", out)
        self.assertNotIn("user@example.com", out)

    def test_native_cli_uses_fixed_argument_array_and_requires_receipt(self):
        sink = worker.NativeDelivery(config(self.temp.name)["delivery"])
        text = 'test "message"; $(touch /tmp/never-executed)'
        response = subprocess.CompletedProcess([], 0, stdout=b'plugin logs\n{"payload":{"messageId":"om_native"}}\n', stderr=b'')
        with patch.object(worker.subprocess, "run", return_value=response) as run:
            receipt = sink.send(text, Path(self.temp.name) / "native")
        self.assertEqual(receipt["message_id"], "om_native")
        args = run.call_args.args[0]
        self.assertEqual(args[args.index("--message") + 1], text)
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_native_cli_rejects_http_like_success_without_message_id(self):
        sink = worker.NativeDelivery(config(self.temp.name)["delivery"])
        response = subprocess.CompletedProcess([], 0, stdout=b'{"ok":true}', stderr=b'')
        with patch.object(worker.subprocess, "run", return_value=response), self.assertRaises(RuntimeError):
            sink.send("message", Path(self.temp.name) / "native")

    def test_gateway_hands_full_report_to_real_agent_input_before_unchanged_delivery(self):
        cfg = config(self.temp.name)["delivery"]
        cfg["session_key"] = "agent:default:feishu:direct:ou_verified"
        text = '完整报告\n230=95 / 311=1 / 313=1\n$(touch /tmp/never-executed)\n' * 500
        transferred = {}
        def transport(args, **kwargs):
            method = args[args.index("call") + 1]
            params = json.loads(args[args.index("--params") + 1])
            if method == "agent":
                transferred.update(params)
                response = {"status": "ok", "runId": "handoff-run"}
            elif method == "chat.history":
                self.assertGreaterEqual(params["maxChars"], len(transferred["message"]))
                response = {"sessionKey": cfg["session_key"], "messages": [
                    {"role": "user", "content": [{"type": "text", "text": transferred["message"]}],
                     "__openclaw": {"id": "context-message"}}]}
            elif method == "send":
                self.assertEqual(params["message"], text)
                response = {"messageId": "om_native"}
            else:
                self.fail(method)
            return subprocess.CompletedProcess([], 0, json.dumps(response).encode(), b'')
        with patch.object(worker.subprocess, "run", side_effect=transport) as run:
            receipt = worker.NativeDelivery(cfg).send(text, Path(self.temp.name) / "native")
        self.assertEqual(receipt["message_id"], "om_native")
        self.assertEqual(receipt["context_message_id"], "context-message")
        self.assertIn(text, transferred["message"])
        self.assertFalse(transferred["deliver"])
        self.assertTrue(transferred["disableMessageTool"])
        self.assertIn("--expect-final", run.call_args_list[0].args[0])
        self.assertEqual([c.args[0][c.args[0].index("call") + 1] for c in run.call_args_list],
                         ["agent", "chat.history", "send"])
        args = run.call_args_list[2].args[0]
        params = json.loads(args[args.index("--params") + 1])
        self.assertEqual(params["message"], text)
        self.assertEqual(params["sessionKey"], cfg["session_key"])
        self.assertEqual(params["to"], cfg["target"])
        self.assertIn("send", args)
        self.assertNotIn("shell", run.call_args_list[0].kwargs)
        proof = json.loads((Path(self.temp.name) / "native.context-verification.json").read_text())
        self.assertTrue(proof["completeReportMatches"])

    def test_transcript_only_mirrors_or_incomplete_context_prevent_external_publication(self):
        for history in ({"sessionKey": "agent:default:feishu:direct:ou_other", "messages": []},
                {"sessionKey": "agent:default:feishu:direct:ou_verified", "messages": [
                    {"role": "assistant", "provider": "openclaw", "model": "delivery-mirror", "content": "complete report"}]},
                {"sessionKey": "agent:default:feishu:direct:ou_verified", "messages": [
                    {"role": "user", "content": "truncated report"}]}):
            with self.subTest(history=history):
                cfg = config(self.temp.name)["delivery"]
                cfg["session_key"] = "agent:default:feishu:direct:ou_verified"
                outputs = [subprocess.CompletedProcess([], 0, b'{"status":"ok"}', b''),
                           subprocess.CompletedProcess([], 0, json.dumps(history).encode(), b'')]
                with patch.object(worker.subprocess, "run", side_effect=outputs) as run:
                    with self.assertRaises(RuntimeError):
                        worker.NativeDelivery(cfg).send("complete report", Path(self.temp.name) / "native")
                    self.assertEqual(run.call_count, 2)
                    self.assertNotIn("send", [c.args[0][c.args[0].index("call") + 1] for c in run.call_args_list])

    def test_gateway_send_error_never_falls_back_to_an_untracked_second_send(self):
        cfg = config(self.temp.name)["delivery"]
        cfg["session_key"] = "agent:default:feishu:direct:ou_verified"
        for response in (subprocess.CompletedProcess([], 1, b'', b'timeout'),
                         subprocess.CompletedProcess([], 0, b'{"ok":true}', b'')):
            with self.subTest(response=response), patch.object(worker.subprocess, "run", return_value=response) as run:
                with self.assertRaises(RuntimeError):
                    worker.NativeDelivery(cfg).send("complete report", Path(self.temp.name) / "native")
                self.assertEqual(run.call_count, 1)

    def test_context_failure_quarantines_incident_across_restart(self):
        key = self.queue()
        cfg = config(self.temp.name)
        cfg["delivery"]["session_key"] = "agent:default:feishu:direct:ou_verified"
        history = {"sessionKey": cfg["delivery"]["session_key"], "messages": []}
        outputs = [subprocess.CompletedProcess([], 0, b'{"status":"ok"}', b''),
                   subprocess.CompletedProcess([], 0, json.dumps(history).encode(), b'')]
        with patch.object(worker.subprocess, "run", side_effect=outputs):
            worker.Worker(cfg, "token", store=self.store, api=Api(), monitor=Api()).process(key)
        self.assertEqual(self.store.get(key)["state"], "delivery_unknown")
        self.assertTrue((self.store.directory(key) / "native-delivery.context-handoff.response.json").exists())
        self.assertFalse((self.store.directory(key) / "native-delivery.gateway-receipt.json").exists())
        with patch.object(worker.subprocess, "run") as run:
            worker.Worker(cfg, "token", store=self.store, api=Api(), monitor=Api()).process(key)
            run.assert_not_called()

    def test_send_failure_after_real_context_is_not_retried_or_fallen_back(self):
        cfg = config(self.temp.name)["delivery"]
        cfg["session_key"] = "agent:default:feishu:direct:ou_verified"
        context = {}
        def transport(args, **kwargs):
            method = args[args.index("call") + 1]
            params = json.loads(args[args.index("--params") + 1])
            if method == "agent":
                context.update(params)
                result = {"status": "ok"}
            elif method == "chat.history":
                result = {"sessionKey": cfg["session_key"], "messages": [{"role": "user", "content": context["message"]}]}
            else:
                self.assertEqual(method, "send")
                return subprocess.CompletedProcess([], 1, b'', b'timeout after possible delivery')
            return subprocess.CompletedProcess([], 0, json.dumps(result).encode(), b'')
        with patch.object(worker.subprocess, "run", side_effect=transport) as run:
            with self.assertRaises(RuntimeError):
                worker.NativeDelivery(cfg).send("complete report", Path(self.temp.name) / "native")
            self.assertEqual(run.call_count, 3)
        self.assertTrue((Path(self.temp.name) / "native.context-verification.json").exists())

    def test_research_requires_a_real_filename_and_positive_page(self):
        for source in ({"filename": {}, "page": 1}, {"filename": "test.pdf", "page": 0}, {"filename": "test.pdf", "page": True}, {"filename": "test.pdf", "page": "unknown"}):
            with self.subTest(source=source), self.assertRaises(ValueError):
                worker.research_evidence({"result": {"answer": "Answer", "sources": [source]}})

    def test_actual_iraop_source_file_and_structured_content_envelopes(self):
        query = {"answer": "Document procedure", "sources": [
            {"source_file": "gpu-runbook.pdf", "page_number": 1, "collection": "approved", "doc_id": "gpu-runbook.pdf", "url": "/api/v1/documents/gpu-runbook.pdf"},
            {"source_file": "gpu-runbook.pdf", "page_number": 2, "collection": "approved", "doc_id": "gpu-runbook.pdf", "url": "/api/v1/documents/gpu-runbook.pdf"}]}
        for response in ({"success": True, "result": {"content": [{"type": "text", "text": "Evidence scope: documentation"}, {"type": "text", "text": json.dumps(query)}]}},
                {"success": True, "result": {"details": {"isError": False, "structuredContent": query}}}):
            with self.subTest(response=response):
                self.assertEqual(worker.research_evidence(response), query)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        outer = self
        self.api = Api()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def run(self):
                raw = self.rfile.read(int(self.headers.get("content-length", 0)))
                body = json.loads(raw) if raw else None
                outer.calls.append({"method": self.command, "path": self.path, "body": body, "authorization": self.headers.get("authorization")})
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("location", f"http://127.0.0.1:{self.server.server_port}/credential-leak")
                    self.end_headers()
                    return
                if self.path.startswith("/api/v2/alerts"):
                    response = [alert()]
                elif self.command == "DELETE":
                    response = {"success": True}
                else:
                    if self.headers.get("authorization") != "Bearer http-test-token":
                        self.send_error(401)
                        return
                    response = outer.api.request(self.path, body)
                data = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_DELETE = run

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def test_actual_http_pipeline_native_argv_and_restart_deduplication(self):
        cfg = config(self.temp.name)
        cfg.update(alertmanager_url=self.base, mosaic_url=self.base, include_existing=True)
        executable = Path(self.temp.name) / "kubectl"
        executable.write_text('#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps({"payload":{"messageId":"om_http"}}))\n')
        executable.chmod(0o700)
        cfg["delivery"]["kubectl"] = str(executable)
        instance = worker.Worker(cfg, "http-test-token")
        instance.poll()
        key = instance.store.pending()[0]["id"]
        instance.process(key)
        self.assertEqual(instance.store.get(key)["state"], "sent")
        self.assertEqual(instance.store.get(key)["message_id"], "om_http")
        instance.poll()
        self.assertEqual(instance.store.pending(), [])
        self.assertEqual(sum(x["path"] == "/api/headless/chat" for x in self.calls), 2)
        self.assertEqual(sum(x["path"] == "/api/openclaw/tools/call" for x in self.calls), 1)
        for request in self.calls:
            if not request["path"].startswith("/api/v2"):
                self.assertEqual(request["authorization"], "Bearer http-test-token")

    def test_http_redirect_is_rejected_without_forwarding_credentials(self):
        client = worker.Http(self.base, "http-test-token")
        with self.assertRaises(urllib.error.HTTPError):
            client.request("/redirect")
        self.assertFalse(any(x["path"] == "/credential-leak" for x in self.calls))

    def test_explicit_source_resolution_only_deletes_worker_owned_card(self):
        cfg = config(self.temp.name)
        cfg.update(alertmanager_url=self.base, mosaic_url=self.base, include_existing=True)
        instance = worker.Worker(cfg, "http-test-token", delivery=Delivery())
        instance.poll()
        key = instance.store.pending()[0]["id"]
        instance.process(key)

        class EmptyMonitor:
            def request(self, *_args, **_kwargs):
                return []

        instance.monitor = EmptyMonitor()
        instance.poll()
        self.assertIsNotNone(instance.store.get(key)["ui_cleared_at"])
        deleted = [x for x in self.calls if x["method"] == "DELETE"]
        self.assertEqual(len(deleted), 1)
        self.assertIn("alertmanager%3A0123456789abcdef", deleted[0]["path"])
        instance.poll()
        self.assertEqual(sum(x["method"] == "DELETE" for x in self.calls), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
