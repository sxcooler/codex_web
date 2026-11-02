import {test,expect,type Page} from '@playwright/test';
const compact='Error running remote compact task: stream disconnected before completion: idle timeout waiting for SSE';
const failed=(id:string,items:any[]=[])=>({id,status:'failed',startedAt:1760000000,completedAt:1760000030,error:{message:compact,codexErrorInfo:'other'},items});
const user=(id:string)=>({id,type:'userMessage',content:[{type:'text',text:'Demo request '+id}]});
const command=(id:string,status='completed',exitCode=0)=>({id,type:'commandExecution',command:'echo demo',status,exitCode,aggregatedOutput:'Demo output'});
async function fixture(page:Page,turns:any[],initial?:any,initialRead?:Promise<void>){
 const calls:string[]=[],errors:string[]=[],reads={abortDenied:false,fail:false,gate:initialRead as Promise<void>|undefined,count:0};
 const state:any={thread:{id:'i18n-test',name:'Demo conversation',turns},epoch:'feedback',revision:0,syncCursor:'feedback:0',phase:'IDLE',activeTurnId:null,pending:[]};
 if(initial)await page.addInitScript(value=>(window as any).fixtureInitial=value,initial);
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{(window as any).sources=[];(window as any).copies=[];(window as any).copyFails=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{if((window as any).copyFails)throw Error('denied');(window as any).copies.push(text);}}});window.EventSource=class extends EventTarget{closed=false;constructor(){super();(window as any).sources.push(this);queueMicrotask(()=>{this.dispatchEvent(new Event('ready'));for(const change of (window as any).replayChanges??[])if(!this.closed)this.dispatchEvent(new MessageEvent('change',{data:JSON.stringify(change)}));});}close(){this.closed=true;}} as any;});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;calls.push(route.request().method()+' '+path);let data:any={};
  if(path==='/api/sessions/i18n-test'){reads.count++;if(reads.gate)await reads.gate;if(reads.fail){await route.fulfill({status:503,json:{error:'Fixture read failed'}});return;}data=state;}
  else if(path.endsWith('/status'))data={resync:false};
  else if(path==='/api/models')data={data:[]};
  else if(path==='/api/permission-modes')data={modes:[]};
  else if(path==='/api/account/usage')data={accountId:null};
  else if(path.endsWith('/abort')&&reads.abortDenied){await route.fulfill({status:409,json:{error:'Fixture stop was rejected'}});return;}
  else if(path.endsWith('/messages')){await route.abort('failed');return;}
  else if(path.endsWith('/history'))data={turns:[failed('historical',[user('history')])],nextCursor:null};
  await route.fulfill({json:data});
 });
 const update=async(patch:any)=>{Object.assign(state,patch);state.revision++;state.syncCursor='feedback:'+state.revision;const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sessions/i18n-test');await page.evaluate(()=>(window as any).sources.findLast((s:any)=>!s.closed).dispatchEvent(new MessageEvent('resync',{data:'{}'})));await response;await expect(page.locator('.session-actions-trigger')).toHaveAttribute('aria-busy','false');};
 await page.goto('/tests/turn-feedback.html');await expect(page.locator('#message')).toBeVisible();
 const change=async(patch:any)=>{await expect.poll(()=>page.evaluate(()=>(window as any).sources.some((s:any)=>!s.closed))).toBe(true);state.revision++;state.syncCursor='feedback:'+state.revision;await page.evaluate(value=>(window as any).sources.findLast((s:any)=>!s.closed).dispatchEvent(new MessageEvent('change',{data:JSON.stringify(value)})),{id:state.syncCursor,threadId:'i18n-test',revision:state.revision,patch});};
 return {state,calls,errors,update,reads,change};
}
for(const width of [1440,390])for(const english of [false,true])test('authoritative completion corrects a cached stopped turn '+width+' '+(english?'en':'zh'),async({page},info)=>{
 await page.setViewportSize({width,height:900});
 const answer={id:'answer',type:'agentMessage',phase:'final_answer',text:'Authoritative completed answer'};
 const stopped={id:'current',status:'interrupted',startedAt:1760000000,completedAt:1760000539,durationMs:539168,items:[user('current'),answer]};
 const f=await fixture(page,[{id:'history',status:'interrupted',items:[user('history')]},stopped]);
 if(english)await page.locator('#english').click();
 await expect(page.locator('#turn-outcome-current')).toBeVisible();
 await page.locator('#message').fill('Preserved terminal correction draft');
 const writes=f.calls.filter(c=>c.startsWith('POST ')),reads=f.reads.count;
 let release!:()=>void;f.reads.gate=new Promise(resolve=>release=resolve);
 f.state.thread.turns[1]={...stopped,status:'completed'};
 f.state.revision++;f.state.syncCursor='feedback:'+f.state.revision;
 await page.evaluate(value=>(window as any).sources.findLast((s:any)=>!s.closed).dispatchEvent(new MessageEvent('change',{data:JSON.stringify(value)})),{id:f.state.syncCursor,threadId:'i18n-test',kind:'resync',revision:f.state.revision,patch:{}});
 await expect.poll(()=>f.reads.count).toBe(reads+1);
 await expect(page.getByRole('button',{name:english?'Send':'发送',exact:true})).toBeDisabled();
 f.reads.gate=undefined;release();
 await expect(page.locator('#turn-outcome-current')).toHaveCount(0);
 await expect(page.locator('#turn-outcome-history')).toBeVisible();
 await expect(page.getByText('Authoritative completed answer',{exact:true})).toBeVisible();
 await expect(page.locator('.session-outcome-link')).toHaveCount(0);
 await expect(page.locator('#message')).toHaveValue('Preserved terminal correction draft');
 await expect(page.getByRole('button',{name:english?'Send':'发送',exact:true})).toBeEnabled();
 await page.locator('.session-actions-trigger').click();await page.keyboard.press('Escape');
 await expect(page.locator('.session-actions-trigger')).toBeFocused();
 await page.screenshot({path:info.outputPath('completed-after-resync.png'),fullPage:true});
 expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual(writes);expect(f.reads.count).toBe(reads+1);expect(f.errors).toEqual([]);
});

for(const width of [1440,390])for(const english of [false,true])test('manual resync recovers completion after verification read failure '+width+' '+(english?'en':'zh'),async({page},info)=>{
 await page.setViewportSize({width,height:900});
 const stopped={id:'current',status:'interrupted',items:[user('current'),{id:'answer',type:'agentMessage',phase:'final_answer',text:'Recovered completed answer'}]};
 const f=await fixture(page,[stopped]);if(english)await page.locator('#english').click();
 await page.locator('#message').fill('Preserved retry draft');const writes=f.calls.filter(c=>c.startsWith('POST '));
 f.reads.fail=true;await f.update({});
 const retry=page.getByRole('button',{name:english?'Resync':'重新同步',exact:true});
 await expect(retry).toBeVisible();await expect(page.getByRole('button',{name:english?'Send':'发送',exact:true})).toBeDisabled();
 f.reads.fail=false;f.state.thread.turns[0]={...stopped,status:'completed'};
 const request=page.waitForRequest(r=>new URL(r.url()).searchParams.get('restartHistory')==='true');
 await retry.focus();await page.keyboard.press('Enter');expect((await request).method()).toBe('GET');
 await expect(page.locator('#turn-outcome-current')).toHaveCount(0);
 await expect(page.getByText('Recovered completed answer',{exact:true})).toBeVisible();
 await expect(page.locator('#message')).toHaveValue('Preserved retry draft');
 await expect(page.getByRole('button',{name:english?'Send':'发送',exact:true})).toBeEnabled();
 await page.screenshot({path:info.outputPath('manual-resync-completed.png'),fullPage:true});
 expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual(writes);expect(f.errors).toEqual([]);
});

for(const width of [1440,1280,390,360])for(const english of [false,true])test('turn failures stay beside their requests and outside collapsed activity '+width+' '+(english?'en':'zh'),async({page},info)=>{
 await page.setViewportSize({width,height:900});
 const {calls,errors}=await fixture(page,[failed('work',[user('work'),command('first'),{id:'partial',type:'agentMessage',phase:'commentary',text:'Demo partial update'},command('last')]),failed('question',[user('question')]),failed('empty')]);
 if(english)await page.locator('#english').click();
 const cards=page.locator('.turn-outcome');await expect(cards).toHaveCount(3);
 for(const id of ['work','question','empty'])await expect(page.locator('[data-turn-id="'+id+'"] > .turn-outcome')).toBeVisible();
 await expect(page.locator('.execution-process')).toHaveCount(2);await expect(page.locator('.execution-process[open]')).toHaveCount(0);
 await expect(page.locator('.execution-process')).not.toContainText(['本轮失败','本轮失败']);
 await expect(page.locator('.turn-outcome-recovery')).toHaveCount(1);
 const latest=page.locator('#turn-outcome-empty');await expect(latest).toContainText(english?'Context compaction timed out':'上下文压缩超时');
 await page.screenshot({path:info.outputPath('default-state.png'),fullPage:true});
 const before=[...calls];await page.locator('.session-outcome-link').focus();await page.keyboard.press('Enter');await expect(latest).toBeFocused();
 await latest.locator('summary').focus();await page.keyboard.press('Space');await expect(latest.locator('details')).toHaveAttribute('open','');
 await expect(latest.locator('pre')).toContainText(compact);
 await latest.getByRole('button',{name:english?'Copy error':'复制错误',exact:true}).click();expect((await page.evaluate(()=>(window as any).copies))[0]).toContain(compact);
 await page.evaluate(()=>(window as any).copyFails=true);await latest.getByRole('button',{name:english?'Copy error':'复制错误',exact:true}).click();await expect(latest).toContainText(english?'Could not copy':'复制失败');
 await page.locator('#message').fill('Preserved draft');
 await page.locator(english?'#chinese':'#english').click();await expect(page.locator('#message')).toHaveValue('Preserved draft');await expect(latest.locator('details')).toHaveAttribute('open','');
 expect(calls).toEqual(before);expect(errors).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('turn-feedback.png'),fullPage:true});
});
test('new activity, native reconnect, compaction delay and terminal feedback remain separate',async({page})=>{
 await page.clock.install();
 const f=await fixture(page,[failed('old',[user('old')])]);const initialWrites=f.calls.filter(c=>c.startsWith('POST '));await page.locator('#english').click();
 await expect(page.locator('.session-outcome-link')).toBeVisible();
 const live:any={id:'new',status:'inProgress',startedAt:Date.now()/1000,items:[user('new'),{id:'compact',type:'contextCompaction',status:'inProgress',startedAtMs:Date.now()}]};
 await f.update({thread:{...f.state.thread,turns:[...f.state.thread.turns,live]},phase:'RUNNING',activeTurnId:'new'});
 await expect(page.locator('.session-outcome-link')).toHaveCount(0);await expect(page.locator('.turn-progress')).toHaveText('Compacting context');
 await page.clock.fastForward(11000);await expect(page.locator('.turn-progress')).toContainText('This can take a few minutes');
 await f.update({retry:{turnId:'new',message:'Reconnecting... 2/5'}});
 await expect(page.locator('.turn-retry')).toContainText('Reconnecting 2/5');await expect(page.locator('.turn-progress')).toHaveCount(0);
 await f.update({thread:{...f.state.thread,turns:[failed('old',[user('old')]),{...live,status:'failed',error:{message:compact}}]},phase:'IDLE',activeTurnId:null});
 await expect(page.locator('.turn-retry')).toHaveCount(0);await expect(page.locator('#turn-outcome-new')).toBeVisible();await expect(page.locator('.turn-announcement')).toContainText('Turn incomplete');
 const spoken=await page.locator('.turn-announcement').textContent();await page.locator('#chinese').click();expect(await page.locator('.turn-announcement').textContent()).toBe(spoken);
 await f.update({phase:'UNKNOWN'});await expect(page.locator('.session-outcome-link')).toHaveCount(0);
 expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual(initialWrites);
});
test('history, warning, interruption and unknown submissions preserve their meaning',async({page})=>{
 const f=await fixture(page,[{id:'complete',status:'completed',error:{message:'<img src=x onerror=alert(1)>'},items:[user('complete'),command('issue','failed',2)]},{id:'stopped',status:'interrupted',items:[user('stopped')]}]);await page.locator('#english').click();
 await expect(page.locator('.turn-outcome[data-kind=warning]')).toHaveCount(1);await expect(page.locator('.turn-outcome[data-kind=interrupted]')).toHaveCount(1);await expect(page.locator('.turn-outcome[data-kind=failed]')).toHaveCount(0);
 await expect(page.locator('.execution-process > summary')).toContainText('Contains issues');
 const first=page.locator('#turn-outcome-complete');await first.locator('summary').click();await expect(first.locator('pre')).toContainText('<img');await expect(first.locator('img')).toHaveCount(0);
 f.state.history={nextCursor:'older'};await f.update({});await page.getByRole('button',{name:'Load earlier messages',exact:true}).click();await expect(page.locator('#turn-outcome-historical')).toBeVisible();await expect(page.locator('.turn-announcement')).toBeEmpty();
 await page.locator('#message').fill('Do not resend');await page.getByRole('button',{name:'Send',exact:true}).click();await expect(page.locator('.outgoing-status')).toContainText('unconfirmed');await expect(page.locator('.session-outcome-link')).toHaveCount(0);
});

test('existing execution fixture preserves approvals, lazy output and SSE expansion',async({page})=>{
 await page.goto('/tests/execution-process.html');
 await expect(page.locator('#result')).toContainText('PASS:',{timeout:20000});
});

test('waiting, disconnection and ongoing release take priority over a past outcome',async({page})=>{
 const f=await fixture(page,[failed('old',[user('old')])]);
 const writes=f.calls.filter(c=>c.startsWith('POST '));
 await f.update({phase:'WAITING_INPUT',activeTurnId:'waiting',pending:[{requestId:'q',method:'item/tool/requestUserInput',params:{questions:[{id:'question',question:'Demo approval',options:[{label:'Option'}]}]}}]});
 await expect(page.locator('.session-outcome-link')).toHaveCount(0);await expect(page.locator('.approval')).toBeVisible();
 await f.update({phase:'IDLE',activeTurnId:null,pending:[],release:{inProgress:true}});
 await expect(page.locator('.session-outcome-link')).toHaveCount(0);
 await f.update({release:null});await expect(page.locator('.session-outcome-link')).toBeVisible();
 await page.evaluate(()=>{const source=(window as any).sources.findLast((s:any)=>!s.closed);source.onerror?.(new Event('error'));});
 await expect(page.locator('.session-outcome-link')).toHaveCount(0);
 expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual(writes);
});

test('each new failure updates the live region even when its summary is identical',async({page})=>{
 const f=await fixture(page,[failed('old',[user('old')])]);await page.locator('#english').click();
 for(const id of ['one','two']){
  const live={id,status:'inProgress',items:[user(id)]};
  await f.update({thread:{...f.state.thread,turns:[...f.state.thread.turns,live]},phase:'RUNNING',activeTurnId:id});
  await f.update({thread:{...f.state.thread,turns:[...f.state.thread.turns.slice(0,-1),failed(id,[user(id)])]},phase:'IDLE',activeTurnId:null});
  await expect(page.locator('.turn-announcement')).toContainText('Turn incomplete');
  if(id==='one')await page.locator('.turn-announcement').evaluate(el=>(window as any).announcementNode=el.firstChild);
  else expect(await page.locator('.turn-announcement').evaluate(el=>el.firstChild!==(window as any).announcementNode)).toBe(true);
 }
});

test('explicitly terminal compaction items never show active waiting feedback',async({page})=>{
 const f=await fixture(page,[failed('old',[user('old')])]);await page.locator('#english').click();
 for(const status of ['completed','failed','interrupted']){
  await f.update({thread:{...f.state.thread,turns:[{id:'live',status:'inProgress',items:[user('live'),{id:'compact',type:'contextCompaction',status,startedAtMs:Date.now()-11000}]}]},phase:'RUNNING',activeTurnId:'live'});
  await expect(page.locator('.turn-progress')).toHaveCount(0);
 }
});


for(const width of [1440,390])for(const english of [false,true])test('same ID conflict resync restores streaming and preserves draft '+width+' '+english,async({page},info)=>{
 await page.setViewportSize({width,height:900});
 const stopped={id:'current',status:'interrupted',items:[user('current'),{id:'reply',type:'agentMessage',text:'Kept reply'}]};
 const f=await fixture(page,[{id:'history',status:'interrupted',items:[user('history')]},stopped]);
 if(english)await page.locator('#english').click();
 await page.locator('#message').fill('Preserved conflict draft');
 const writes=f.calls.filter(c=>c.startsWith('POST '));let release!:()=>void;f.reads.gate=new Promise(resolve=>release=resolve);
 f.state.thread.turns[1]={...stopped,status:'inProgress'};f.state.phase='RUNNING';f.state.activeTurnId='current';
 await f.change({turn:{id:'current',status:'inProgress',items:[]},state:{phase:'RUNNING',activeTurnId:'current'}});
 await expect(page.locator('#turn-outcome-current')).toHaveCount(0);
 await expect(page.locator('#turn-outcome-history')).toHaveCount(1);
 await expect(page.getByRole('button',{name:english?'Send':'发送',exact:true})).toBeDisabled();
 await expect.poll(()=>f.reads.count).toBe(2);await page.screenshot({path:info.outputPath('conflict-verifying.png'),fullPage:true});
 release();f.reads.gate=undefined;
 await expect(page.getByRole('button',{name:english?'Steer':'插话',exact:true})).toBeEnabled();
 await expect(page.getByRole('button',{name:english?'Abort':'中止',exact:true})).toBeEnabled();
 await f.change({delta:{turnId:'current',itemId:'reply',field:'text',offset:10,text:' + continued'}});
 await expect(page.locator('[data-item-id="reply"]')).toContainText('Kept reply + continued');
 await expect(page.locator('#message')).toHaveValue('Preserved conflict draft');
 await expect(page.locator('.session-outcome-link')).toHaveCount(0);
 expect(f.reads.count).toBe(2);expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual(writes);expect(f.errors).toEqual([]);
 await page.locator('.session-actions-trigger').click();await expect(page.locator('.session-actions-trigger')).toHaveAttribute('aria-expanded','true');await page.keyboard.press('Escape');await expect(page.locator('.session-actions-trigger')).toHaveAttribute('aria-expanded','false');await expect(page.locator('.session-actions-trigger')).toBeFocused();
 await page.screenshot({path:info.outputPath('conflict-recovered.png'),fullPage:true});
});

test('self-conflicting full read stays pending once and manual same-revision resync recovers',async({page})=>{
 const f=await fixture(page,[{id:'current',status:'interrupted',items:[user('current')]}]);await page.locator('#english').click();
 await page.locator('#message').fill('Keep draft');const writes=f.calls.filter(c=>c.startsWith('POST '));
 f.state.phase='RUNNING';f.state.activeTurnId='current';
 await f.change({state:{phase:'RUNNING',activeTurnId:'current'}});
 await expect(page.getByRole('alert')).toContainText('State needs verification');
 await expect(page.locator('#turn-outcome-current')).toHaveCount(0);
 for(let i=0;i<8;i++)await f.change({delta:{turnId:'current',itemId:'late',field:'text',offset:0,text:'late'},state:{phase:'RUNNING',activeTurnId:'current'}});
 await page.waitForTimeout(600);expect(f.reads.count).toBe(2);
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
 f.state.thread.turns[0].status='inProgress';
 await page.getByRole('button',{name:'Resync',exact:true}).click();
 await expect(page.getByRole('button',{name:'Steer',exact:true})).toBeEnabled();
 await expect(page.locator('#message')).toHaveValue('Keep draft');
 expect(f.reads.count).toBe(3);expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual(writes);
});

test('failed conflict resync keeps send locked until a later state event recovers',async({page})=>{
 const f=await fixture(page,[{id:'current',status:'interrupted',items:[user('current')]}]);await page.locator('#english').click();
 await page.locator('#message').fill('Never auto resend');const writes=f.calls.filter(c=>c.startsWith('POST '));
 f.reads.fail=true;await f.change({state:{phase:'RUNNING',activeTurnId:'current'}});
 await expect(page.getByRole('alert')).toContainText('State needs verification');
 await expect.poll(()=>f.reads.count).toBe(2);await expect(page.locator('.session-actions-trigger')).toHaveAttribute('aria-busy','false');
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
 f.reads.fail=false;f.state.thread.turns[0].status='inProgress';f.state.phase='RUNNING';f.state.activeTurnId='current';
 await f.change({state:{phase:'RUNNING',activeTurnId:'current'}});
 await expect(page.getByRole('button',{name:'Steer',exact:true})).toBeEnabled();
 expect(f.reads.count).toBe(3);expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual(writes);
});



test('historyPending replay conflict cannot accept the old full read or spin until authoritative recovery',async({page},info)=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const stopped={id:'current',status:'interrupted',items:[user('current')]};
 const initial={thread:{id:'i18n-test',name:'Demo conversation',turns:[stopped]},epoch:'feedback',revision:0,syncCursor:'feedback:0',phase:'IDLE',activeTurnId:null,pending:[],historyPending:true};
 const f=await fixture(page,[stopped],initial,gate);await page.locator('#english').click();
 await expect.poll(()=>f.reads.count).toBe(1);
 await f.change({turn:{id:'current',status:'inProgress',items:[]},state:{phase:'RUNNING',activeTurnId:'current'}});
 f.state.revision=0;f.state.syncCursor='feedback:0';
 f.reads.gate=undefined;release();
 await expect.poll(()=>f.reads.count).toBe(2);
 await expect(page.getByRole('alert')).toContainText('State needs verification');
 await expect(page.locator('#turn-outcome-current')).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
 await expect(page.locator('#message')).toHaveValue('Preserved history draft');
 await page.waitForTimeout(600);expect(f.reads.count).toBe(2);
 await page.screenshot({path:info.outputPath('history-conflict-pending.png'),fullPage:true});
 f.state.revision=1;f.state.syncCursor='feedback:1';f.state.thread.turns[0].status='inProgress';f.state.phase='RUNNING';f.state.activeTurnId='current';
 await page.getByRole('button',{name:'Resync',exact:true}).click();
 await expect(page.getByRole('button',{name:'Steer',exact:true})).toBeEnabled();
 await expect(page.locator('#message')).toHaveValue('Preserved history draft');
 expect(f.reads.count).toBe(3);expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual([]);expect(f.errors).toEqual([]);
});


test('a conflicting cached initial snapshot never enables steering during its first read',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const stopped={id:'current',status:'interrupted',items:[user('current')]};
 const initial={thread:{id:'i18n-test',name:'Demo conversation',turns:[stopped]},epoch:'feedback',revision:0,syncCursor:'feedback:0',phase:'RUNNING',activeTurnId:'current',pending:[]};
 const f=await fixture(page,[stopped],initial,gate);await page.locator('#english').click();
 try{
  await expect(page.getByRole('button',{name:'Steer',exact:true})).toBeDisabled();
  await expect(page.locator('.connection')).toContainText('Verifying state');
  expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual([]);
 }finally{f.reads.gate=undefined;release();}
});


test('a rejected stop request never creates a native interrupted outcome',async({page})=>{
 const f=await fixture(page,[{id:'live',status:'inProgress',items:[user('live'),{id:'compact',type:'contextCompaction',status:'inProgress',startedAtMs:Date.now()}]}]);await page.locator('#english').click();
 await f.update({phase:'RUNNING',activeTurnId:'live'});f.reads.abortDenied=true;
 await page.getByRole('button',{name:'Abort',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Fixture stop was rejected');
 await expect(page.locator('.turn-outcome')).toHaveCount(0);await expect(page.locator('.turn-progress')).toContainText('Compacting context');
 await expect(page.locator('.connection')).toContainText('Running');
 expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual(['POST /api/sessions/i18n-test/abort']);expect(f.errors).toEqual([]);
});


test('a new runtime epoch can recover a pending conflict through a resync event',async({page})=>{
 const f=await fixture(page,[{id:'current',status:'interrupted',items:[user('current')]}]);await page.locator('#english').click();
 await page.locator('#message').fill('Preserve across epoch');f.state.phase='RUNNING';f.state.activeTurnId='current';
 await f.change({state:{phase:'RUNNING',activeTurnId:'current'}});
 await expect.poll(()=>f.reads.count).toBe(2);await expect(page.locator('.session-actions-trigger')).toHaveAttribute('aria-busy','false');
 f.state.epoch='next-epoch';f.state.revision=0;f.state.syncCursor='next-epoch:0';f.state.thread.turns[0].status='inProgress';
 await page.evaluate(()=>(window as any).sources.findLast((s:any)=>!s.closed).dispatchEvent(new MessageEvent('resync',{data:JSON.stringify({id:'next-epoch:0',revision:0})})));
 await expect(page.getByRole('button',{name:'Steer',exact:true})).toBeEnabled();
 await expect(page.locator('#message')).toHaveValue('Preserve across epoch');expect(f.reads.count).toBe(3);expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual([]);
});


test('failed resync ignores replayed state events from its unchanged cursor and retries fresh evidence',async({page})=>{
 const f=await fixture(page,[{id:'current',status:'interrupted',items:[user('current')]}]);await page.locator('#english').click();
 await page.locator('#message').fill('Preserve replay draft');f.reads.fail=true;f.state.revision=2;f.state.syncCursor='feedback:2';
 const events=[1,2].map(revision=>({id:'feedback:'+revision,threadId:'i18n-test',revision,patch:{state:{phase:'RUNNING',activeTurnId:'current'}}}));
 await page.evaluate(events=>{(window as any).replayChanges=events;(window as any).sources.findLast((s:any)=>!s.closed).dispatchEvent(new MessageEvent('change',{data:JSON.stringify(events[1])}));},events);
 await expect.poll(()=>f.reads.count).toBeGreaterThanOrEqual(2);await page.waitForTimeout(1200);
 expect(f.reads.count).toBe(2);await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
 await page.evaluate(()=>(window as any).replayChanges=[]);f.reads.fail=false;f.state.thread.turns[0].status='inProgress';f.state.phase='RUNNING';f.state.activeTurnId='current';
 await f.change({state:{phase:'RUNNING',activeTurnId:'current'}});
 await expect(page.getByRole('button',{name:'Steer',exact:true})).toBeEnabled();
 expect(f.reads.count).toBe(3);expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual([]);await expect(page.locator('#message')).toHaveValue('Preserve replay draft');
});


test('conflict resync retains expanded history, reading position and the prepared attachment',async({page})=>{
 const old={id:'history',status:'completed',items:[user('history'),command('historic-command'),...Array.from({length:30},(_,n)=>({id:'history-'+n,type:'agentMessage',text:'History message '+n+' with preserved content.'}))]};
 const current={id:'current',status:'interrupted',items:[user('current')]};
 const f=await fixture(page,[old,current]);await page.locator('#english').click();await f.update({history:{nextCursor:null}});
 await page.locator('#message').fill('Draft with attachment');
 await page.locator('.attachments input[type=file]').setInputFiles({name:'preserved.txt',mimeType:'text/plain',buffer:Buffer.from('fixture attachment')});
 await expect(page.locator('.attachments li')).toContainText('Ready');
 await page.locator('[data-turn-id="history"] .execution-process > summary').click();
 await expect(page.locator('[data-turn-id="history"] .execution-process')).toHaveAttribute('open','');
 const top=await page.locator('.timeline').evaluate(element=>{element.scrollTop=100;element.dispatchEvent(new Event('scroll'));return element.scrollTop;});expect(top).toBe(100);
 const writes=f.calls.filter(c=>c.startsWith('POST '));
 f.state.thread.turns=[{...current,status:'inProgress'}];f.state.history={nextCursor:'current'};f.state.phase='RUNNING';f.state.activeTurnId='current';
 await f.change({turn:{id:'current',status:'inProgress',items:[]},state:{phase:'RUNNING',activeTurnId:'current'}});
 await expect(page.getByRole('button',{name:'Steer',exact:true})).toBeEnabled();
 await expect(page.locator('[data-turn-id="history"] .execution-process')).toHaveAttribute('open','');
 await expect(page.locator('.attachments li')).toContainText('preserved.txt');await expect(page.locator('#message')).toHaveValue('Draft with attachment');
 expect(await page.locator('.timeline').evaluate(element=>element.scrollTop)).toBe(top);
 expect(f.calls.filter(c=>c.startsWith('POST '))).toEqual(writes);expect(f.errors).toEqual([]);
});
