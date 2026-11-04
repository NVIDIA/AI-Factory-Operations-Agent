# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the real one-shot runner without SSH, Kubernetes or real credentials."""
from pathlib import Path
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('teams_probe_runner', Path(__file__).with_name('run.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def fixture(self, root):
        p = Path(root) / 'account.env'
        p.write_text('TEAMS_USERNAME=service@example.invalid\nTEAMS_PASSWORD=synthetic-quote"slash\\=value\n'
                     'TEAMS_CLIENT_ID=11111111-1111-1111-1111-111111111111\n')
        p.chmod(0o600)
        return p

    def test_private_file_and_default_identity_payload(self):
        with tempfile.TemporaryDirectory() as root:
            p = self.fixture(root)
            arguments = ['run.py', '--ssh-target', 'operator@example.invalid', '--context', 'test-context',
                         '--credentials-file', str(p), '--output-dir', str(Path(root) / 'evidence')]
            calls = []

            def ssh(args, **kwargs):
                payload = json.loads(kwargs['input'])
                calls.append(payload)
                self.assertNotIn(payload['credentials']['password'], '\n'.join(args))
                self.assertEqual(payload['credentials']['password'], 'synthetic-quote"slash\\=value')
                return subprocess.CompletedProcess(args, 0, json.dumps({
                    'success': True, 'podPhase': 'Succeeded', 'probeEvents': [], 'cleanup': []}), '')

            with mock.patch.object(sys, 'argv', arguments), mock.patch.object(subprocess, 'run', ssh), contextlib.redirect_stdout(io.StringIO()):
                previous_mask = os.umask(0o077)
                try:
                    self.assertEqual(runner.main(), 0)
                finally:
                    os.umask(previous_mask)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]['probeMode'], 'identity')
            self.assertEqual(calls[0]['context'], 'test-context')
            output = next((Path(root) / 'evidence').glob('*.json'))
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)

    def test_group_readable_credentials_never_reach_ssh(self):
        with tempfile.TemporaryDirectory() as root:
            p = self.fixture(root)
            p.chmod(0o640)
            args = ['run.py', '--ssh-target', 'operator@example.invalid', '--context', 'test-context', '--credentials-file', str(p)]
            with mock.patch.object(sys, 'argv', args), mock.patch.object(subprocess, 'run') as ssh:
                with self.assertRaisesRegex(SystemExit, 'private regular file'):
                    runner.main()
                ssh.assert_not_called()

    def test_send_requires_a_recipient_before_reading_credentials(self):
        args = ['run.py', '--ssh-target', 'operator@example.invalid', '--context', 'test-context', '--send']
        with mock.patch.object(sys, 'argv', args), mock.patch.object(subprocess, 'run') as ssh, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                runner.main()
            ssh.assert_not_called()

    def remote(self, scenario):
        payload = {'credentials': {'username': 'service@example.invalid', 'password': 'synthetic-only-password',
                                  'clientId': '11111111-1111-1111-1111-111111111111', 'clientSecret': ''},
                   'runId': 'fixture-run', 'context': 'test-context', 'namespace': 'mosaic',
                   'serviceAccount': 'openclaw', 'ownerToken': 'fixture-owner', 'kubectl': 'kubectl',
                   'image': 'example.invalid/probe:test', 'recipientId': '', 'probeMode': 'identity', 'script': '// fixture'}
        deleted = []

        def kubectl(args, **kwargs):
            out, code = '', 0
            if 'get' in args:
                kind = args[args.index('get') + 1]
                if args[-1] == 'name':
                    out = 'pod/preexisting' if scenario == 'existing' else ''
                elif scenario == 'partial' and kind == 'pod':
                    out = ''
                else:
                    foreign = (scenario == 'foreign-pod' and kind == 'pod') or (scenario == 'foreign-secret' and kind == 'secret')
                    owner = 'other-owner' if foreign else 'fixture-owner'
                    out = json.dumps({'metadata': {'uid': 'uid-' + kind, 'labels': {'mosaic-test-owner': owner}},
                                      'status': {'phase': 'Succeeded'}})
            elif 'create' in args:
                manifest = json.loads(kwargs['input'])
                self.assertFalse(manifest['items'][2]['spec']['automountServiceAccountToken'])
                self.assertEqual(manifest['items'][2]['spec']['containers'][0]['securityContext']['readOnlyRootFilesystem'], True)
                if scenario == 'partial' and '--dry-run=server' not in args:
                    code = 1
            elif 'logs' in args:
                out = json.dumps({'stage': 'identity_verified'})
            elif 'delete' in args:
                url = args[args.index('--raw') + 1]
                options = json.loads(kwargs['input'])
                deleted.append((url, options['preconditions']['uid']))
                if scenario == 'cleanup-failure' and len(deleted) == 1:
                    code = 1
            else:
                raise AssertionError(args)
            return subprocess.CompletedProcess(args, code, out, '')

        output = io.StringIO()
        with mock.patch.object(sys, 'stdin', io.StringIO(json.dumps(payload))), mock.patch.object(subprocess, 'run', kubectl), contextlib.redirect_stdout(output):
            exec(runner.REMOTE, {'__name__': 'teams_probe_fake_remote'})
        text = output.getvalue()
        self.assertNotIn(payload['credentials']['password'], text)
        return json.loads(text), deleted

    def test_existing_objects_are_not_modified(self):
        result, deleted = self.remote('existing')
        self.assertFalse(result['success'])
        self.assertEqual(deleted, [])

    def test_partial_create_cleans_only_created_uids(self):
        result, deleted = self.remote('partial')
        self.assertFalse(result['success'])
        self.assertEqual({uid for _, uid in deleted}, {'uid-secret', 'uid-configmap'})

    def test_foreign_racing_pod_is_never_deleted(self):
        result, deleted = self.remote('foreign-pod')
        self.assertEqual(result['failure'], 'resource_ownership_mismatch')
        self.assertEqual({uid for _, uid in deleted}, {'uid-secret', 'uid-configmap'})

    def test_foreign_first_object_does_not_hide_later_owned_resources(self):
        result, deleted = self.remote('foreign-secret')
        self.assertEqual(result['failure'], 'resource_ownership_mismatch')
        self.assertEqual({uid for _, uid in deleted}, {'uid-configmap', 'uid-pod'})

    def test_cleanup_failure_is_not_reported_as_success(self):
        result, deleted = self.remote('cleanup-failure')
        self.assertFalse(result['success'])
        self.assertEqual(len(deleted), 3)

    def test_successful_probe_deletes_all_own_resources_by_uid(self):
        result, deleted = self.remote('success')
        self.assertTrue(result['success'])
        self.assertEqual({uid for _, uid in deleted}, {'uid-secret', 'uid-configmap', 'uid-pod'})


if __name__ == '__main__':
    unittest.main()
