# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Render an optional Graph bridge for one bound chat. Never reads credential values."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent


def render(binding, namespace='mosaic', mosaic_url='http://mosaic-ui:3000',
           storage_class='standard', ui_secret='mosaic-ui-auth', alert_cluster=None,
           name=None, credential_secret='mosaic-teams-graph', allow_quoted_replies=False):
    guid = r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'
    sender = binding.get('sender', {})
    group = binding.get('chatType') == 'group'
    allowed = binding.get('allowedUserIds', [])
    if (binding.get('stage') != 'bound' or binding.get('chatType') not in ['oneOnOne', 'group']
            or not isinstance(binding.get('chatId'), str) or not binding['chatId']
            or not re.fullmatch(guid, sender.get('id', ''))
            or not sender.get('userPrincipalName')):
        raise ValueError('Use the successful bind output from teams_graph_probe/probe.cjs')
    if group:
        if (not isinstance(allowed, list) or not allowed
                or any(not isinstance(x, str) or not re.fullmatch(guid, x) for x in allowed)
                or len(set(x.lower() for x in allowed)) != len(allowed)
                or sender['id'].lower() in [x.lower() for x in allowed] or alert_cluster):
            raise ValueError('Groups require an explicit user allowlist and do not accept simulation webhooks')
        digest = hashlib.sha256(binding['chatId'].encode()).hexdigest()
        session = 'agent:default:mosaic-automation-alert-teams-group-' + digest[:24]
        name = name or 'mosaic-teams-group-' + digest[:12]
        if name == 'mosaic-teams-graph':
            raise ValueError('Use a separate group deployment and PVC; preserve the default DM')
    else:
        if allow_quoted_replies:
            raise ValueError('Quoted replies are an optional group trigger')
        if (not re.fullmatch(guid, binding.get('recipient', ''))
                or sender['id'].lower() == binding['recipient'].lower()):
            raise ValueError('A DM requires a distinct recipient GUID')
        session = 'agent:default:mosaic-automation-alert-teams-' + binding['recipient'].lower()
        name = name or 'mosaic-teams-graph'
    for value in [namespace, storage_class, ui_secret, name, credential_secret]:
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*', value):
            raise ValueError('Invalid Kubernetes name')
    config = {
        'chatId': binding['chatId'], 'chatType': binding['chatType'], 'senderId': sender['id'],
        'senderUpn': sender['userPrincipalName'], 'sessionKey': session,
        'mosaicUrl': mosaic_url, 'pollSeconds': 10,
        'credentialFile': '/credentials/credentials.json',
        'machineTokenFile': '/ui-auth/machineToken', 'stateDir': '/state',
    }
    if group:
        config.update(allowedUserIds=[x.lower() for x in allowed], requireMention=True)
        if allow_quoted_replies:
            config['allowQuotedReplies'] = True
    else:
        config['recipientId'] = binding['recipient']
    if alert_cluster:
        if not re.fullmatch(r'[A-Za-z0-9_-]+', alert_cluster):
            raise ValueError('Invalid target cluster name')
        config['webhook'] = {'port': 8789, 'tokenFile': '/webhook-auth/token',
            'matchLabels': {'teams_validation': 'true', 'mosaic_test': 'true',
                            'simulation': 'true', 'cluster': alert_cluster}}
    data = {name: (HERE / name).read_text() for name in ['channel.mjs', 'format.mjs', 'reformat.mjs']}
    data['channel.json'] = json.dumps(config, indent=2)
    manifest = json.loads((HERE / 'deployment.template.json').read_text())
    if not alert_cluster:
        manifest['items'] = [i for i in manifest['items'] if i['kind'] != 'Service']
    for item in manifest['items']:
        item['metadata']['namespace'] = namespace
        item['metadata']['name'] = name
        item['metadata']['labels']['app'] = name
        if item['kind'] == 'Service':
            item['spec']['selector']['app'] = name
        if item['kind'] == 'PersistentVolumeClaim':
            item['spec']['storageClassName'] = storage_class
        if item['kind'] != 'Deployment':
            continue
        pod = item['spec']['template']
        item['spec']['selector']['matchLabels']['app'] = name
        pod['metadata']['labels']['app'] = name
        pod['metadata']['annotations'] = {'mosaic-teams-code-sha256':
            hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()}
        for volume in pod['spec']['volumes']:
            if volume['name'] == 'ui-auth':
                volume['secret']['secretName'] = ui_secret
            elif volume['name'] == 'credentials':
                volume['secret']['secretName'] = credential_secret
            elif volume['name'] == 'config':
                volume['configMap']['name'] = name
            elif volume['name'] == 'state':
                volume['persistentVolumeClaim']['claimName'] = name
        if not alert_cluster:
            pod['spec']['volumes'] = [v for v in pod['spec']['volumes'] if v['name'] != 'webhook-auth']
            container = pod['spec']['containers'][0]
            container['volumeMounts'] = [v for v in container['volumeMounts'] if v['name'] != 'webhook-auth']
    manifest['items'].insert(0, {'apiVersion': 'v1', 'kind': 'ConfigMap',
        'metadata': {'name': name, 'namespace': namespace}, 'data': data})
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding', type=Path, required=True)
    parser.add_argument('--namespace', default='mosaic')
    parser.add_argument('--mosaic-url', default='http://mosaic-ui:3000')
    parser.add_argument('--storage-class', default='standard')
    parser.add_argument('--ui-secret', default='mosaic-ui-auth')
    parser.add_argument('--test-alert-cluster')
    parser.add_argument('--name', help='Separate Deployment/ConfigMap/PVC name; groups default to a chat-ID hash')
    parser.add_argument('--credential-secret', default='mosaic-teams-graph')
    parser.add_argument('--allow-quoted-replies', action='store_true',
                        help='Allow group replies that quote a message sent by this worker')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    manifest = render(json.loads(args.binding.read_text()), args.namespace, args.mosaic_url,
                      args.storage_class, args.ui_secret, args.test_alert_cluster,
                      args.name, args.credential_secret, args.allow_quoted_replies)
    os.umask(0o077)
    with args.output.open('w') as out:
        json.dump(manifest, out, indent=2)
        out.write('\n')
    print('Prepared ConfigMap, PVC and Deployment; credentials are supplied as a separate Secret.')
