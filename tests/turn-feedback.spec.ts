import {test,expect,type Page} from '@playwright/test';
const compact='Error running remote compact task: stream disconnected before completion: idle timeout waiting for SSE';
const failed=(id:string,items:any[]=[])=>({id,status:'failed',startedAt:1760000000,completedAt:1760000030,error:{message:compact,codexErrorInfo:'other'},items});
const user=(id:string)=>({id,type:'userMessage',content:[{type:'text',text:'Demo request '+id}]});
const command=(id:string,status='completed',exitCode=0)=>({id,type:'commandExecution',command:'echo demo',status,exitCode,aggregatedOutput:'Demo output'});
async function fixture(page:Page,turns:any[]){
 const calls:string[]=[],errors:string[]=[];
 const state:any={thread:{id:'i18n-test',name:'Demo conversation',turns},epoch:'feedback',revision:0,syncCursor:'feedback:0',phase:'IDLE',activeTurnId:null,pending:[]};
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{(window as any).sources=[];(window as any).copies=[];(window as any).copyFails=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{if((window as any).copyFails)throw Error('denied');(window as any).copies.push(text);}}});window.EventSource=class extends EventTarget{closed=false;constructor(){super();(window as any).sources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){this.closed=true;}} as any;});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;calls.push(route.request().method()+' '+path);let data:any={};
  if(path==='/api/sessions/i18n-test')data=state;
  else if(path.endsWith('/status'))data={resync:false};
  else if(path==='/api/models')data={data:[]};
  else if(path==='/api/permission-modes')data={modes:[]};
  else if(path==='/api/account/usage')data={accountId:null};
  else if(path.endsWith('/messages')){await route.abort('failed');return;}
  else if(path.endsWith('/history'))data={turns:[failed('historical',[user('history')])],nextCursor:null};
  await route.fulfill({json:data});
 });
 const update=async(patch:any)=>{Object.assign(state,patch);state.revision++;state.syncCursor='feedback:'+state.revision;const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/sessions/i18n-test');await page.evaluate(()=>(window as any).sources.findLast((s:any)=>!s.closed).dispatchEvent(new MessageEvent('resync',{data:'{}'})));await response;await expect(page.locator('.session-actions-trigger')).toHaveAttribute('aria-busy','false');};
 await page.goto('/tests/turn-feedback.html');await expect(page.locator('#message')).toBeVisible();
 return {state,calls,errors,update};
}
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
