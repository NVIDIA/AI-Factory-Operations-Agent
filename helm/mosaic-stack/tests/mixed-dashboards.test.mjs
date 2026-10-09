import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {registerHooks} from 'node:module';
import test from 'node:test';
import {registerGrafanaTools} from '../files/openclaw-seed/extensions/observability/grafana.ts';

const hooks=registerHooks({resolve(s,c,next){return s==='openclaw/plugin-sdk/plugin-entry'?{url:'data:text/javascript,export const definePluginEntry = x => x;',shortCircuit:true}:next(s,c);}});
const {default:plugin}=await import('../files/openclaw-seed/extensions/grafana/index.ts');
hooks.deregister();
for(const [register,name] of [[registerGrafanaTools,'dashboard_create'],[plugin.register,'grafana_dashboard_create']]) {
 test(`${name} routes mixed panels to their datasources and rejects failed validation`,async t=>{
  const saved=[];const queries=[];let fail=false;
  const server=createServer(async(req,res)=>{
   let body='';for await(const part of req)body+=part;
   const data=body?JSON.parse(body):{};
   const path=new URL(req.url,'http://local').pathname.replace('/monitoring','');
   let output;
   if(path==='/api/datasources')output=[{uid:'metrics-test',type:'prometheus'},{uid:'logs-test',type:'loki'}];
   else if(path==='/api/v1/query') {assert.equal(new URL(req.url,'http://local').searchParams.get('query'),'up');output={data:{result:[{value:[1,'1']}]}};}
   else if(path.endsWith('/api/ds/query')){
    queries.push(data.queries[0]);output={results:{A:fail?{error:'query rejected'}:{frames:[{data:{values:[[1],['entry']]}}]}}};
   }else if(path==='/api/dashboards/db'){saved.push(data.dashboard);output={uid:'test-board',url:'/monitoring/d/test-board'};}
   else {res.writeHead(404);res.end();return;}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(output));
  }).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>{server.closeAllConnections();server.close()});
  const url=`http://127.0.0.1:${server.address().port}`;
  const tools={};register({pluginConfig:{grafanaEnabled:true,grafanaUrl:url+'/monitoring',prometheusUrl:url,uiUrl:url,datasourceUid:'metrics-test'},registerTool:x=>tools[x.name]=x});
  const panels=[{title:'Health',query:'up',visualization:'stat'},{title:'Events',query:'{service="example"}',visualization:'logs',datasource:{uid:'logs-test',type:'loki'}}];
  const result=await tools[name].execute('test',{title:'Correlation',panels,openInUi:false});
  assert.equal(result.details.created,true);
  assert.ok(result.details.iframeUrl.startsWith('/api/grafana/proxy/d/test-board?'));
  assert.equal(result.details.dashboardUrl,url+'/monitoring/d/test-board');
  assert.deepEqual(saved[0].panels.map(p=>p.datasource),[{type:'prometheus',uid:'metrics-test'},{type:'loki',uid:'logs-test'}]);
  assert.equal(saved[0].panels[1].type,'logs');
  assert.ok(queries.some(q=>q.datasource.uid==='logs-test'&&q.expr===panels[1].query));
  fail=true;
  assert.equal((await tools[name].execute('test',{panels,openInUi:false,requireData:false})).details.created,false);
  assert.equal(saved.length,1);
  fail=false;
  const invalid=[{...panels[1],datasource:{type:'loki',uid:'missing'}}];
  assert.equal((await tools[name].execute('test',{panels:invalid,openInUi:false})).details.created,false);
  assert.equal(saved.length,1);
 });
}
