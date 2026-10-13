import assert from 'node:assert/strict';
import test from 'node:test';
import {Runtime} from '../src/codex/runtime.ts';

function fixture(t:any){
 const runtime=new Runtime({executable:process.execPath,cwd:process.cwd()}),internal=runtime as any,events:any[]=[];
 internal.state('thread').subagent=false;runtime.on('notification',event=>events.push(event));
 t.after(async()=>{internal.server=undefined;await runtime.close();});return {runtime,internal,events};
}
test('completion targets the final answer of its own merged turn and preserves the event key',t=>{
 const {internal,events}=fixture(t);
 internal.onNotification({method:'turn/started',params:{threadId:'thread',turn:{id:'turn:unparsed',status:'inProgress',items:[]}}});
 for(const item of [{id:'progress',type:'agentMessage',phase:'commentary',text:'working'},{id:'final',type:'agentMessage',phase:'final_answer',text:'done'}])internal.onNotification({method:'item/completed',params:{threadId:'thread',turnId:'turn:unparsed',item}});
 internal.onNotification({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn:unparsed',status:'completed',items:[]}}});
 assert.deepEqual(events,[{threadId:'thread',eventKey:'turn:turn:unparsed',kind:'complete',turnId:'turn:unparsed',itemId:'final'}]);
});
test('failed and legacy completion targets retain turn identity without inventing an item target',t=>{
 const {internal,events}=fixture(t);
 for(const [id,status] of [['legacy','completed'],['failure','failed']])internal.onNotification({method:'turn/completed',params:{threadId:'thread',turn:{id,status,items:[{id:'legacy-item',type:'agentMessage',phase:null,text:'legacy'}]}}});
 assert.deepEqual(events,[{threadId:'thread',eventKey:'turn:legacy',kind:'complete',turnId:'legacy'},{threadId:'thread',eventKey:'turn:failure',kind:'failed',turnId:'failure'}]);
});
test('approval and input use browser pending request identifiers, including numeric native RPC identifiers',t=>{
 const {internal,events}=fixture(t);internal.server={respondError(){throw Error('unexpected error response');}};
 internal.state('thread').activeTurnId='turn';
 for(const [id,method] of [[42,'item/commandExecution/requestApproval'],['native-input','item/tool/requestUserInput']]){
  internal.onRequest({id,method,params:{threadId:'thread',turnId:'turn',itemId:String(id)+'-item'}});
  const pending=[...internal.state('thread').pending.values()].at(-1) as any,event=events.at(-1);
  assert.equal(event.requestId,String(pending.requestId));assert.equal(event.turnId,'turn');assert.equal(event.itemId,String(id)+'-item');
  assert.equal(event.kind,method==='item/tool/requestUserInput'?'input':'approval');assert.notEqual(event.requestId,String(id));
 }
});
test('MCP input without a turn field uses the verified active turn and does not invent an item',t=>{
 const {internal,events}=fixture(t);internal.server={respondError(){throw Error('unexpected error response');}};internal.state('thread').activeTurnId='active';
 internal.onRequest({id:71,method:'mcpServer/elicitation/request',params:{threadId:'thread',mode:'url'}});
 assert.equal(events[0].turnId,'active');assert.equal(events[0].requestId,[...internal.state('thread').pending.keys()][0]);assert.equal(events[0].itemId,undefined);assert.equal(events[0].kind,'input');
});
