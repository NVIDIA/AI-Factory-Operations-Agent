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


if __name__ == '__main__':
    unittest.main()
