import assert from 'node:assert/strict';import test from 'node:test';import{turnActivity,turnElapsedMs}from'../src/web/turnActivity.ts';import * as activity from '../src/web/turnActivity.ts';
const agent=(id:string,phase?:string)=>({id,type:'agentMessage',phase}),tool=(id:string)=>({id,type:'commandExecution'}),blocks=(status:string,items:any[])=>turnActivity({id:'turn',status,items}).map(block=>({process:block.process,ids:block.items.map(item=>item.id)}));
test('live unknown and commentary messages join tools in original order without guessing a final',()=>{assert.deepEqual(blocks('inProgress',[agent('comment','commentary'),tool('cmd'),agent('live')]),[{process:true,ids:['comment','cmd','live']}]);});
test('sleep does not split continuous process or compact records and preserves native data',()=>{
  const wait={id:'wait',type:'sleep',durationMs:30000},items=[tool('before'),wait,{id:'think',type:'reasoning'},tool('after')];
  for(const status of ['inProgress','completed'])assert.deepEqual(blocks(status,items),[{process:true,ids:['before','wait','think','after']}]);
  const rows=activity.executionRows(items);assert.deepEqual(rows.map(row=>({records:row.records,ids:row.items.map(item=>item.id)})),[{records:true,ids:['before','wait','think','after']}]);assert.equal(rows[0].items[1],wait);assert.equal(wait.durationMs,30000);
});
test('sleep problems remain visible exceptions inside the process',()=>{
  for(const problem of [{status:'failed'},{status:'interrupted'},{status:'declined'},{error:{message:'wait failed'}}]){
    const wait={id:'wait',type:'sleep',...problem},items=[tool('before'),wait,tool('after')];
    assert.deepEqual(blocks('completed',items),[{process:true,ids:['before','wait','after']}]);
    assert.deepEqual(activity.executionRows(items).map(row=>({records:row.records,ids:row.items.map(item=>item.id)})),[{records:true,ids:['before']},{records:false,ids:['wait']},{records:true,ids:['after']}]);assert.ok(activity.executionIssue(wait));
  }
});
test('explicit final answers, user steering, async interaction and delivery images stay visible and split process boundaries',()=>{
  const items=[agent('a','commentary'),tool('cmd'),{id:'steer',type:'userMessage'},agent('b','commentary'),agent('first','final_answer'),agent('c','commentary'),agent('last','final_answer'),{...agent('question','commentary'),delivery:'async',questions:[{}]},{id:'gift',type:'imageGeneration'},{id:'unknown-tool',type:'futureTool'}];
  assert.deepEqual(blocks('completed',items),[{process:true,ids:['a','cmd']},{process:false,ids:['steer']},{process:true,ids:['b']},{process:false,ids:['first']},{process:true,ids:['c']},{process:false,ids:['last']},{process:false,ids:['question']},{process:false,ids:['gift']},{process:false,ids:['unknown-tool']}]);
});
test('old terminal records preserve only the last ordinary assistant fallback and do not promote progress if an explicit final exists',()=>{
  assert.deepEqual(blocks('completed',[agent('old-progress'),tool('cmd'),agent('old-answer'),{...agent('async'),delivery:'async'}]),[{process:true,ids:['old-progress','cmd']},{process:false,ids:['old-answer']},{process:false,ids:['async']}]);
  assert.deepEqual(blocks('completed',[agent('final','final_answer'),agent('late')]),[{process:false,ids:['final']},{process:true,ids:['late']}]);
});
for(const status of ['failed','interrupted'])test(status+' without a final keeps the last assistant explanation visible',()=>{assert.deepEqual(blocks(status,[tool('cmd'),agent('explanation','commentary')]),[{process:true,ids:['cmd']},{process:false,ids:['explanation']}]);});
for(const status of ['failed','interrupted'])test(status+' prefers the latest explanation over earlier legacy progress',()=>{assert.deepEqual(blocks(status,[agent('legacy-progress'),tool('cmd'),agent('explanation','commentary')]),[{process:true,ids:['legacy-progress','cmd']},{process:false,ids:['explanation']}]);});
test('completed explicit commentary without an answer stays a process; a final-only record needs no process',()=>{assert.deepEqual(blocks('completed',[agent('progress','commentary')]),[{process:true,ids:['progress']}]);assert.deepEqual(blocks('completed',[agent('answer','final_answer')]),[{process:false,ids:['answer']}]);});
test('native duration milliseconds win, timestamps are seconds, and running time uses only a valid start',()=>{
  assert.equal(turnElapsedMs({status:'completed',durationMs:3456,startedAt:100,completedAt:108}),3456);assert.equal(turnElapsedMs({status:'completed',startedAt:100,completedAt:108}),8000);assert.equal(turnElapsedMs({status:'completed',durationMs:0}),0);assert.equal(turnElapsedMs({status:'inProgress',durationMs:999,startedAt:100},103000),3000);
});
test('missing, future and invalid times do not manufacture a duration',()=>{for(const turn of [{status:'completed'},{status:'completed',startedAt:108,completedAt:100},{status:'inProgress',startedAt:108},{status:'completed',durationMs:-1},{status:'completed',startedAt:Infinity,completedAt:108},{status:'completed',startedAt:0,completedAt:108},{status:'completed',durationMs:NaN}])assert.equal(turnElapsedMs(turn,100000),undefined);});
test('image viewing joins process counts while generated images remain deliveries',()=>{assert.deepEqual(blocks('inProgress',[tool('a'),{id:'view',type:'imageView'},tool('b'),{id:'gift',type:'imageGeneration'}]),[{process:true,ids:['a','view','b']},{process:false,ids:['gift']}]);});
test('compact records preserve ordering and split at progress, image viewing and real exceptions',()=>{
  assert.equal(typeof activity.executionRows,'function','continuous mechanical records need a grouping function');
  const items=[{id:'empty',type:'reasoning',summary:[]},tool('a'),agent('progress','commentary'),tool('b'),{id:'view',type:'imageView'},tool('c'),{...tool('nonzero'),exitCode:1,status:'completed'},tool('d'),{id:'error',type:'mcpToolCall',status:'completed',error:{message:'tool error'}},{id:'decline',type:'fileChange',status:'declined'},{id:'interrupt',type:'subAgentActivity',kind:'interrupted'},tool('e')];
  assert.deepEqual(activity.executionRows(items).map(row=>({records:row.records,ids:row.items.map(item=>item.id)})),[{records:true,ids:['empty','a']},{records:false,ids:['progress']},{records:true,ids:['b']},{records:false,ids:['view']},{records:true,ids:['c','nonzero','d']},{records:false,ids:['error']},{records:false,ids:['decline']},{records:false,ids:['interrupt']},{records:true,ids:['e']}]);
});
for(const status of ['completed','failed'])test('exit code one with native '+status+' joins records without changing command details or its issue label',()=>{
  const command={...tool('one'),pluginId:null,scriptPath:null,command:"powershell -NoProfile -Command 'rg missing src'",cwd:'/project',processId:null,source:'agent',status,commandActions:[],aggregatedOutput:'no matching lines',exitCode:1,durationMs:30},items=[tool('before'),command,tool('after')],rows=activity.executionRows(items);
  assert.equal(rows.length,1);assert.equal(rows[0].records,true);assert.deepEqual(rows[0].items,items);assert.equal(rows[0].items[1],command);assert.equal(activity.executionIssue(command),'命令退出码 1');
});
test('other nonzero exits and explicit problems accompanying exit one remain separate exceptions',()=>{
  const problems=[{exitCode:2,status:'failed'},{exitCode:-1,status:'failed'},{exitCode:null,status:'failed'},{status:'failed'},{exitCode:1,status:'failed',error:{message:'failed to execute'}},{exitCode:1,status:'failed',isError:true},{exitCode:1,status:'failed',result:{isError:true}},{exitCode:1,status:'failed',success:false},{exitCode:1,status:'declined'},{exitCode:1,status:'interrupted'}];
  for(const problem of problems){const item={...tool('issue'),status:'completed',...problem};assert.deepEqual(activity.executionRows([tool('before'),item,tool('after')]).map(row=>({records:row.records,ids:row.items.map(item=>item.id)})),[{records:true,ids:['before']},{records:false,ids:['issue']},{records:true,ids:['after']}],JSON.stringify(problem));}
});
test('MCP result errors and dynamic tool unsuccessful responses remain visible exceptions',()=>{assert.deepEqual(activity.executionRows([{id:'mcp',type:'mcpToolCall',status:'completed',result:{isError:true}},{id:'dynamic',type:'dynamicToolCall',status:'completed',success:false}]).map(row=>row.records),[false,false]);});
