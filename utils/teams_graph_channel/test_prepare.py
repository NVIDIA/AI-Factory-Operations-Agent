# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import json
import unittest
from prepare import render

BINDING = {'stage': 'bound', 'chatType': 'oneOnOne', 'chatId': 'fixture-chat',
           'recipient': '33333333-3333-3333-3333-333333333333',
           'sender': {'id': '22222222-2222-2222-2222-222222222222',
                      'userPrincipalName': 'service@example.invalid'}}


class DeploymentTest(unittest.TestCase):
    def test_private_chat_needs_no_webhook_secret_or_listener(self):
        doc = render(BINDING, namespace='ops', storage_class='fast', ui_secret='ui-auth')
        self.assertTrue(all(i['metadata']['namespace'] == 'ops' for i in doc['items']))
        self.assertNotIn('Secret', [i['kind'] for i in doc['items']])
        self.assertNotIn('Service', [i['kind'] for i in doc['items']])
        dep = next(i for i in doc['items'] if i['kind'] == 'Deployment')['spec']['template']['spec']
        self.assertNotIn('webhook-auth', [v['name'] for v in dep['volumes']])
        self.assertFalse(dep['automountServiceAccountToken'])
        self.assertEqual(next(v for v in dep['volumes'] if v['name'] == 'ui-auth')['secret']['secretName'], 'ui-auth')

    def test_optional_webhook_is_bound_to_one_simulation_cluster(self):
        doc = render(BINDING, alert_cluster='test-cluster')
        config = json.loads(doc['items'][0]['data']['channel.json'])
        self.assertEqual(config['webhook']['matchLabels']['simulation'], 'true')
        self.assertEqual(config['webhook']['matchLabels']['cluster'], 'test-cluster')
        self.assertIn('Service', [i['kind'] for i in doc['items']])
        with self.assertRaises(ValueError):
            render(BINDING, alert_cluster='bad cluster')

    def test_unverified_or_self_chat_cannot_generate_a_deployment(self):
        for b in [{**BINDING, 'stage': 'failed'}, {**BINDING, 'chatType': 'group'},
                  {**BINDING, 'recipient': BINDING['sender']['id']}]:
            with self.assertRaises(ValueError):
                render(b)

    def test_group_has_distinct_state_session_and_resources_but_reuses_credentials(self):
        binding = {**BINDING, 'chatType': 'group', 'chatId': 'existing-group',
                   'allowedUserIds': [BINDING['recipient']]}
        doc = render(binding)
        config = json.loads(doc['items'][0]['data']['channel.json'])
        name = doc['items'][0]['metadata']['name']
        self.assertTrue(name.startswith('mosaic-teams-group-'))
        self.assertTrue(all(x['metadata']['name'] == name for x in doc['items']))
        self.assertNotIn('recipientId', config)
        self.assertTrue(config['requireMention'])
        self.assertEqual(config['allowedUserIds'], binding['allowedUserIds'])
        self.assertNotEqual(config['sessionKey'], json.loads(render(BINDING)['items'][0]['data']['channel.json'])['sessionKey'])
        dep = next(x for x in doc['items'] if x['kind'] == 'Deployment')['spec']
        self.assertEqual(dep['selector']['matchLabels']['app'], name)
        pod = dep['template']
        self.assertEqual(pod['metadata']['labels']['app'], name)
        volumes = {v['name']: v for v in pod['spec']['volumes']}
        self.assertEqual(volumes['config']['configMap']['name'], name)
        self.assertEqual(volumes['state']['persistentVolumeClaim']['claimName'], name)
        self.assertEqual(volumes['credentials']['secret']['secretName'], 'mosaic-teams-graph')
        self.assertNotIn('Service', [i['kind'] for i in doc['items']])
        for kwargs in [{'name': 'mosaic-teams-graph'}, {'alert_cluster': 'prod'}]:
            with self.assertRaises(ValueError):
                render(binding, **kwargs)

    def test_group_allowlist_cannot_be_empty_wildcard_duplicate_or_service_identity(self):
        for allowed in [[], ['*'], [BINDING['sender']['id']], [BINDING['recipient']] * 2]:
            with self.assertRaises(ValueError):
                render({**BINDING, 'chatType': 'group', 'allowedUserIds': allowed})

    def test_group_quote_trigger_requires_opt_in(self):
        group = {**BINDING, 'chatType': 'group', 'allowedUserIds': [BINDING['recipient']]}
        original = render(group)
        enabled = render(group, allow_quoted_replies=True)
        original_config = json.loads(original['items'][0]['data']['channel.json'])
        enabled_config = json.loads(enabled['items'][0]['data']['channel.json'])
        self.assertEqual(enabled_config, {**original_config, 'allowQuotedReplies': True})
        old_deployment = next(item for item in original['items'] if item['kind'] == 'Deployment')
        new_deployment = next(item for item in enabled['items'] if item['kind'] == 'Deployment')
        self.assertNotEqual(old_deployment['spec']['template']['metadata']['annotations'],
                            new_deployment['spec']['template']['metadata']['annotations'])
        with self.assertRaises(ValueError):
            render(BINDING, allow_quoted_replies=True)


if __name__ == '__main__':
    unittest.main()
