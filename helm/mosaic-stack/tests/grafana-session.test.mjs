// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { registerGrafanaTools } from '../files/openclaw-seed/extensions/observability/grafana.ts';

const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'openclaw/plugin-sdk/plugin-entry'
    ? { url: 'data:text/javascript,export const definePluginEntry = x => x;', shortCircuit: true }
    : next(specifier, context);
} });
const { default: plugin } = await import('../files/openclaw-seed/extensions/grafana/index.ts');
hooks.deregister();

for (const [register, prefix] of [[registerGrafanaTools, 'dashboard'], [plugin.register, 'grafana_dashboard']]) {
  test(`${prefix} notifications use the originating tool context across concurrent sessions`, async t => {
    const notifications = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const data = body ? JSON.parse(body) : {};
      const path = new URL(request.url, 'http://local').pathname;
      let result;
      if (path === '/api/datasources') result = [{ uid: 'metrics', type: 'prometheus', name: 'Metrics' }];
      else if (path === '/api/v1/query') result = { data: { result: [{ value: [1, '1'] }] } };
      else if (path.endsWith('/api/ds/query')) result = { results: { A: { frames: [{ data: { values: [[1], [1]] } }] } } };
      else if (path === '/api/dashboards/db') result = { uid: data.dashboard.uid, url: `/d/${data.dashboard.uid}/overview` };
      else if (path === '/api/ui/actions') { notifications.push(data); result = { success: true, event: data }; }
      else { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(result));
    }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const definitions = new Map();
    register({
      pluginConfig: { grafanaEnabled: true, grafanaUrl: url, prometheusUrl: url, uiUrl: url, datasourceUid: 'metrics' },
      registerTool(definition, options) { definitions.set(options?.name || definition.name, definition); },
    });
    const sessionKeys = ['agent:default:investigation-a', 'agent:default:investigation-b', undefined];
    await Promise.all(sessionKeys.map(async sessionKey => {
      for (const action of ['create', 'open']) {
        const definition = definitions.get(`${prefix}_${action}`);
        const tool = typeof definition === 'function' ? definition({ sessionKey }) : definition;
        const result = await tool.execute('call', {
          title: sessionKey || 'Global dashboard', uid: 'existing-board',
          panels: [{ title: 'Service health', query: 'up' }], sessionKey: 'untrusted-tool-argument',
        });
        assert.equal(result.details.uiNotification.event.sessionKey, sessionKey);
      }
    }));
    assert.equal(notifications.length, 6);
    for (const sessionKey of sessionKeys) assert.equal(notifications.filter(event => event.sessionKey === sessionKey).length, 2);
  });
}
