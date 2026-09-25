import assert from 'node:assert/strict';
import test from 'node:test';
import {applyChange,prependHistory} from '../src/web/sessionSync.ts';
const baseline=()=>({thread:{id:'thread',turns:[{id:'old',status:'completed',items:[{id:'history',type:'agentMessage',text:'old history'}]},{id:'turn',status:'inProgress',items:[{id:'item',type:'agentMessage',text:'hello'}]}]},epoch:'epoch',revision:5,phase:'RUNNING',activeTurnId:'turn',pending:[]});
const event=(revision=6,patch:any={})=>({id:'epoch:'+revision,threadId:'thread',revision,patch});
const delta=(offset:number,text:string)=>({delta:{turnId:'turn',itemId:'item',field:'text',offset,text}});
test('delta keeps unchanged history identity and rejects missing or conflicting bytes',()=>{const before=baseline(),next=applyChange(before,event(6,delta(5,' world')))!;assert.equal(next.thread.turns[1].items[0].text,'hello world');assert.equal(next.thread.turns[0],before.thread.turns[0]);assert.equal(before.thread.turns[1].items[0].text,'hello');assert.equal(applyChange(before,event(6,delta(10,'missing'))),null);assert.equal(applyChange(before,event(6,delta(1,'wrong'))),null);});
test('snapshot overlap and repeated events do not duplicate text; gaps and restarts resync',()=>{const before=baseline();assert.equal(applyChange(before,event(6,delta(0,'hello')))?.thread.turns[1].items[0].text,'hello');assert.equal(applyChange(before,event(6,delta(3,'lo!')))?.thread.turns[1].items[0].text,'hello!');assert.equal(applyChange(before,event(5,delta(5,'duplicate'))),before);assert.equal(applyChange(before,event(7,delta(5,'gap'))),null);assert.equal(applyChange(before,{...event(),id:'restart:1'}),null);});
test('authoritative item completion replaces text; late deltas cannot modify it',()=>{const finished=applyChange(baseline(),event(6,{item:{turnId:'turn',item:{id:'item',type:'agentMessage',text:'Final corrected'},completed:true}}))!;assert.equal(finished.thread.turns[1].items[0].text,'Final corrected');const late=applyChange(finished,event(7,delta(15,' late')))!;assert.equal(late.thread.turns[1].items[0].text,'Final corrected');const completed=applyChange(late,event(8,{turn:{id:'turn',status:'completed',items:[]},state:{phase:'IDLE',activeTurnId:null,pending:[],error:null}}))!;assert.equal(completed.thread.turns[1].items.length,1);assert.equal(completed.phase,'IDLE');assert.equal(completed.activeTurnId,null);});
test('new turn and command output merge by id; malformed events require baseline',()=>{const before=baseline();const next=applyChange(before,event(6,{delta:{turnId:'new',itemId:'cmd',field:'aggregatedOutput',offset:0,text:'output'},state:{phase:'RUNNING',activeTurnId:'new'}}))!;assert.equal(next.thread.turns[2].items[0].aggregatedOutput,'output');assert.equal(next.thread.turns[2].items[0].type,'commandExecution');assert.equal(applyChange(before,event(6)),null);assert.equal(applyChange(before,event(6,{delta:{turnId:'turn',itemId:'item',field:'evil',offset:0,text:'x'}})),null);});

test('late item start cannot overwrite completed snapshot history',()=>{const before=baseline();before.thread.turns[1].status='completed';const next=applyChange(before,event(6,{item:{turnId:'turn',item:{id:'item',type:'agentMessage',text:''},completed:false}}))!;assert.equal(next.thread.turns[1].items[0].text,'hello');});

test('reasoning parts keep independent offsets, immutable snapshots and terminal text',()=>{
 const patch=(index:number,offset:number,text:string)=>({delta:{turnId:'turn',itemId:'reason',field:'summary',index,offset,text}});
 const before=baseline(),first=applyChange(before,event(6,patch(1,0,'summary')))!;
 assert.deepEqual(first.thread.turns[1].items[1].summary,['','summary']);assert.equal(before.thread.turns[1].items.length,1);
 const next=applyChange(first,event(7,patch(1,4,'ary!')))!;assert.deepEqual(next.thread.turns[1].items[1].summary,['','summary!']);assert.equal(first.thread.turns[1].items[1].summary[1],'summary');
 assert.equal(applyChange(next,event(7,patch(1,0,'repeat'))),next);
 for(const p of [patch(-1,0,'bad'),patch(10001,0,'bad'),patch(1,20,'gap'),patch(1,0,'conflict')])assert.equal(applyChange(first,event(7,p)),null);
 const completed=applyChange(next,event(8,{item:{turnId:'turn',completed:true,item:{id:'reason',type:'reasoning',summary:['final'],content:[]}}}))!;
 assert.deepEqual(applyChange(completed,event(9,patch(0,5,' late')))!.thread.turns[1].items[1].summary,['final']);
});

test('history prepend keeps newer live messages, cursor and attachment references authoritative',()=>{
  const before={...baseline(),history:{nextCursor:'old'},syncCursor:'epoch:5',attachmentPreviews:[{path:'image',url:'current'}]};
  const page={turns:[{id:'older',status:'completed',items:[]},{id:'old',items:[]},{id:'turn',items:[]}],nextCursor:'older',inputAnswers:{'old:question':{status:'accepted'}},attachmentPreviews:[{path:'image',url:'stale'},{path:'old-image',url:'older'}]};
  const next=prependHistory(before,page,'old');assert.deepEqual(next.thread.turns.map((t:any)=>t.id),['older','old','turn']);
  assert.equal(next.inputAnswers['old:question'].status,'accepted');
  assert.equal(next.thread.turns[2],before.thread.turns[1]);assert.equal(next.syncCursor,before.syncCursor);assert.equal(next.phase,before.phase);assert.equal(next.attachmentPreviews[0].url,'current');assert.equal(next.attachmentPreviews.length,2);
  assert.equal(prependHistory(before,page,'expired'),before);assert.throws(()=>prependHistory(before,{...page,nextCursor:'old'},'old'),/历史分页无效/);
});
