// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {registerHooks} from 'node:module';
import test from 'node:test';

const hooks = registerHooks({resolve(specifier, context, next) {
  return specifier === 'openclaw/plugin-sdk/plugin-entry'
    ? {url:'data:text/javascript,export const definePluginEntry = x => x;', shortCircuit:true}
    : next(specifier, context);
}});
const {default:plugin} = await import('../files/openclaw-seed/extensions/observability/index.ts');
hooks.deregister();

function tools(base) {
  const registered = {};
  plugin.register({pluginConfig:{grafanaEnabled:false, prometheusUrl:base},
    registerTool:tool => { registered[tool.name] = params => tool.execute('test', params); }});
  return registered;
}

for (const prefix of ['', '/select/23/prometheus']) {
  test(`metrics discovery and queries preserve the configured API prefix (${prefix || 'root'})`, async t => {
    const requests = [];
    const expression = 'WITH (load = vector(3)) load * 2';
    const server = createServer((req,res) => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({url,method:req.method});
      const data = url.pathname.endsWith('/values') ? ['node_load1','node_memory_MemAvailable_bytes']
        : url.pathname.endsWith('/query_range')
          ? {resultType:'matrix',result:[{metric:{node:'worker-b'},values:[[1790812800,'6'],[1790812860,'8']]}]}
          : {resultType:'vector',result:[{metric:{node:'worker-b'},value:[1790812800,'6']}]};
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({status:'success',data}));
    }).listen(0,'127.0.0.1');
    await new Promise(resolve => server.once('listening',resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const api = tools(`http://127.0.0.1:${server.address().port}${prefix}/`);
    assert.equal((await api.observability_metric_names({})).details.names.length,2);
    const instant = (await api.observability_query({query:expression})).details;
    assert.deepEqual(instant.result[0],{metric:{node:'worker-b'},value:{timestamp:1790812800,value:6}});
    const range = (await api.observability_range_query({query:expression,start:'2026-10-01T00:00:00Z',end:'2026-10-01T00:05:00Z',stepSeconds:60})).details;
    assert.equal(range.result[0].values[1].value,8);
    assert.equal(requests[0].url.pathname, `${prefix}/api/v1/label/__name__/values`);
    for (const request of requests) assert.equal(request.method, 'GET');
    const primary = requests.filter(({url}) => url.searchParams.get('query') === expression);
    assert.ok(primary.some(({url}) => url.pathname === `${prefix}/api/v1/query`));
    assert.ok(primary.some(({url}) => url.pathname === `${prefix}/api/v1/query_range`));
    assert.ok(requests.some(({url}) => url.pathname === `${prefix}/api/v1/query_range`
      && url.searchParams.get('query') === `timestamp(${expression})`));
    assert.equal(requests[2].url.searchParams.get('step'),'60');
  });
}

test('VictoriaMetrics serves discovery, MetricsQL instant queries and historical queries', {
  skip:!process.env.VICTORIAMETRICS_TEST_URL,
}, async () => {
  const api = tools(process.env.VICTORIAMETRICS_TEST_URL);
  const names = (await api.observability_metric_names({})).details;
  assert.ok(names.names.length > 0);
  const query = 'WITH (x = vector(2)) x + 3';
  const instant = (await api.observability_query({query})).details;
  assert.equal(instant.resultType,'vector');
  assert.equal(instant.result[0].value.value,5);
  const range = (await api.observability_range_query({query,rangeMinutes:2,stepSeconds:30})).details;
  assert.equal(range.resultType,'matrix');
  assert.ok(range.result[0].values.length > 1);
  assert.ok(range.result[0].values.every(sample => sample.value === 5));
});
