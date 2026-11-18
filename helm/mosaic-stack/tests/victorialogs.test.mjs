// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {registerVictoriaLogsTools} from '../files/openclaw-seed/extensions/observability/victorialogs.ts';
import {toolRequiresEdit} from '../files/openclaw-seed/extensions/automation-context.ts';

function tools(config) {
  const result = {};
  registerVictoriaLogsTools(config, tool => {result[tool.name] = params => tool.execute('test', params);});
  return result;
}

test('VictoriaLogs is opt-in, validates endpoint and tenant configuration, and works in View mode', () => {
  assert.deepEqual(tools({}), {});
  for (const url of ['ftp://logs.example.com', 'https://user:secret@logs.example.com', 'https://logs.example.com?token=secret', 'https://logs.example.com/#secret']) {
    assert.throws(() => tools({victoriaLogsUrl:url}));
  }
  for (const value of ['-1', 'abc', '4294967296', '1.5']) {
    assert.throws(() => tools({victoriaLogsUrl:'http://localhost', victoriaLogsAccountId:value}));
  }
  for (const name of Object.keys(tools({victoriaLogsUrl:'http://localhost'}))) assert.equal(toolRequiresEdit(name), false);
});

test('discovery and LogsQL preserve source, time, fields and aggregates using bounded read-only requests', async t => {
  const requests = [];
  let mode = 'normal';
  const rows = [{_time:'2026-11-01T00:00:01.123456789Z', _msg:'example event', host:'worker-a'}, {service:'scheduler', events:'321'}];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({url, headers:req.headers, method:req.method});
    if (mode === 'error') {res.writeHead(403); return res.end('private response');}
    if (mode === 'redirect') {res.writeHead(302, {Location:'/other'}); return res.end();}
    if (mode === 'oversize') return res.end('x'.repeat(2 * 1024 * 1024 + 1));
    if (mode === 'invalid') return res.end('invalid json');
    res.end(url.pathname.endsWith('/query') ? rows.map(row => JSON.stringify(row)).join('\n') + '\n'
      : JSON.stringify({values:[{value:url.searchParams.has('field') ? 'worker-a' : 'host', hits:42}]}));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  const previous = process.env.MOSAIC_VICTORIALOGS_AUTHORIZATION;
  process.env.MOSAIC_VICTORIALOGS_AUTHORIZATION = 'Bearer test-only';
  t.after(() => {if (previous === undefined) delete process.env.MOSAIC_VICTORIALOGS_AUTHORIZATION; else process.env.MOSAIC_VICTORIALOGS_AUTHORIZATION = previous;});
  const api = tools({victoriaLogsUrl:`http://127.0.0.1:${server.address().port}/proxy/`, victoriaLogsAccountId:'12', victoriaLogsProjectId:'0'});
  const window = {start:'2026-11-01T00:00:00Z', end:'2026-11-01T01:00:00Z'};
  const fields = (await api.observability_victorialogs_fields(window)).details;
  assert.deepEqual(fields.values, [{value:'host', hits:42}]);
  const values = (await api.observability_victorialogs_fields({...window, field:'host', query:'service:="scheduler"'})).details;
  assert.deepEqual(values.values, [{value:'worker-a', hits:42}]);
  const query = 'service:="scheduler" | stats by (host) count() as events';
  assert.deepEqual((await api.observability_victorialogs_query({...window, query})).details.rows, rows);
  const limited = (await api.observability_victorialogs_query({...window, query, limit:1})).details;
  assert.equal(limited.returned, 1);
  assert.equal(limited.limitReached, true);
  assert.equal(limited.rows[0]._time, rows[0]._time);
  assert.deepEqual(requests.map(({url}) => url.pathname), ['/proxy/select/logsql/field_names', '/proxy/select/logsql/field_values', '/proxy/select/logsql/query', '/proxy/select/logsql/query']);
  for (const {url, headers, method} of requests) {
    assert.equal(method, 'GET');
    assert.equal(headers.authorization, 'Bearer test-only');
    assert.equal(headers.accountid, '12');
    assert.equal(headers.projectid, '0');
    assert.equal(url.searchParams.get('start'), '2026-11-01T00:00:00.000Z');
    assert.equal(url.searchParams.get('end'), '2026-11-01T01:00:00.000Z');
  }
  assert.equal(requests[1].url.searchParams.get('field'), 'host');
  assert.equal(requests[2].url.searchParams.get('query'), query);
  const before = requests.length;
  for (const params of [{query:''}, {limit:1001}, {limit:0}, {limit:1.5}, {start:'bad'}, {start:'2026-01-01', end:'2026-01-03'}, {start:window.end, end:window.start}]) {
    await assert.rejects(api.observability_victorialogs_query({query, ...params}));
  }
  assert.equal(requests.length, before);
  for (const [value, message] of [['error', /HTTP 403/], ['redirect', /fetch failed/], ['oversize', /2 MiB/], ['invalid', /invalid JSON/]]) {
    mode = value;
    await assert.rejects(api.observability_victorialogs_query({query}), error => message.test(error.message) && !error.message.includes('private response'));
  }
});

test('VictoriaLogs registers alongside Loki without metrics and honors tool selection', async () => {
  const hooks = registerHooks({resolve(specifier, context, next) {
    return specifier === 'openclaw/plugin-sdk/plugin-entry'
      ? {url:'data:text/javascript,export const definePluginEntry = x => x;', shortCircuit:true} : next(specifier, context);
  }});
  try {
    const {default:plugin} = await import('../files/openclaw-seed/extensions/observability/index.ts');
    const names = config => {
      const result = [];
      plugin.register({pluginConfig:{grafanaEnabled:false, ...config}, registerTool:tool => result.push(tool.name)});
      return result;
    };
    assert.deepEqual(names({}), []);
    const config = {victoriaLogsUrl:'http://vl.example.com', lokiUrl:'http://loki.example.com'};
    assert.equal(names(config).length, 4);
    assert.deepEqual(names({...config, enabledTools:['observability_victorialogs_fields']}), ['observability_victorialogs_fields']);
    assert.ok(!names({...config, disabledTools:['observability_victorialogs_query']}).includes('observability_victorialogs_query'));
  } finally {hooks.deregister();}
});

test('live VictoriaLogs discovery and LogsQL', {skip:!process.env.VICTORIALOGS_TEST_URL}, async () => {
  const api = tools({victoriaLogsUrl:process.env.VICTORIALOGS_TEST_URL});
  const fields = (await api.observability_victorialogs_fields({limit:10})).details;
  assert.ok(fields.values.some(field => field.value === '_msg'));
  const values = (await api.observability_victorialogs_fields({field:'_stream', limit:2})).details;
  assert.ok(values.values.length > 0);
  const logs = (await api.observability_victorialogs_query({query:'*', limit:2})).details;
  assert.ok(logs.rows.length > 0 && logs.rows.length <= 2);
  assert.ok(logs.rows[0]._time);
  const aggregate = (await api.observability_victorialogs_query({query:'* | stats count() as events'})).details;
  assert.ok(Number(aggregate.rows[0].events) > 0);
});
