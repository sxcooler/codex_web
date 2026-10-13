import {test,expect,type Page} from '@playwright/test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const evidence=mkdtempSync(join(tmpdir(),'codex-history-recovery-'));
test.beforeEach(async({page})=>{const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));(page as any).historyErrors=errors;});
test.afterEach(async({page})=>{expect((page as any).historyErrors).toEqual([]);});

async function setup(page:Page){
 const overload={message:'Selected model is at capacity. Please try a different model.',codexErrorInfo:'serverOverloaded'};
 let snapshotReads=0,historyReads:string[]=[],writes:string[]=[],holdSnapshot=false,holdHistory=false,fresh=false;
 let finishSnapshot=()=>{},finishHistory=()=>{};
 const message=(id:string,text:string)=>({id,type:'agentMessage',phase:'final_answer',text});
 const turns=()=>[{id:'recent',status:'failed',error:overload,items:[{id:'think',type:'reasoning',summary:['thinking'],content:[]},message('latest',fresh?'新快照正文':'最新正文')]},{id:'generic',status:'failed',error:{message:'Other failure',codexErrorInfo:'internalServerError'},items:[{id:'generic-tool',type:'reasoning',summary:[],content:[]}]}];
 await page.addInitScript(()=>{(window as any).sources=[];window.EventSource=class extends EventTarget{closed=false;constructor(){super();(window as any).sources.push(this);queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){this.closed=true;}} as any;});
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;if(request.method()==='POST'&&path.startsWith('/api/sessions/'))writes.push(path);
  let data:any={};
  if(path==='/api/auth/session'||path==='/api/auth/renew')data={authenticated:true,csrfToken:'test'};
  else if(path==='/api/projects')data={projects:[]};
  else if(path==='/api/project-catalog')data={projects:[],workRoot:null,desktopProjectlessRoot:null};
  else if(path==='/api/sessions')data={data:[{id:'history',name:'分页测试'}],nextCursor:null};
  else if(path==='/api/models')data={data:[]};
  else if(path==='/api/permission-modes')data={modes:[],current:'ask'};
  else if(path.endsWith('/status'))data={resync:false};
  else if(path==='/api/sessions/history'){
   snapshotReads++;if(holdSnapshot)await new Promise<void>(resolve=>{finishSnapshot=resolve;});
   data={thread:{id:'history',name:'分页测试',cwd:'C:/project',turns:turns()},epoch:'history-epoch',revision:0,syncCursor:'history-epoch:0',phase:'IDLE',pending:[],history:{nextCursor:'recent'},error:overload};
  }else if(path.endsWith('/history')){
   const cursor=url.searchParams.get('before')!;historyReads.push(cursor);if(holdHistory)await new Promise<void>(resolve=>{finishHistory=resolve;});
   data={turns:[{id:cursor==='recent'?'older':'oldest',status:'completed',items:[message(cursor+'-message',cursor==='recent'?'更早正文':'最早正文')]}],nextCursor:cursor==='recent'?'older':null};
  }
  await route.fulfill({json:data}).catch(()=>{});
 });
 await page.goto('/sessions/history');await expect(page.getByText('最新正文',{exact:true})).toBeVisible();
 return {get snapshotReads(){return snapshotReads;},historyReads,writes,set holdSnapshot(v:boolean){holdSnapshot=v;},set holdHistory(v:boolean){holdHistory=v;},set fresh(v:boolean){fresh=v;},finishSnapshot:()=>finishSnapshot(),finishHistory:()=>finishHistory()};
}

test('overload explains a past interruption without relabeling other failures',async({page})=>{
 await setup(page);
 await expect(page.locator('.execution-process .execution-status').first()).toHaveText('模型服务过载，本轮曾中断');
 await expect(page.locator('.execution-process .execution-status').last()).toHaveText('本轮失败');
 await expect(page.locator('.timeline .notice.error').filter({hasText:'模型服务过载，本轮曾中断'})).toHaveCount(2);
 await expect(page.locator('.timeline .notice.error').filter({hasText:'Other failure'})).toHaveCount(1);
});

test('one click during foreground snapshot loading queues the history request',async({page})=>{
 const state=await setup(page);state.holdSnapshot=true;
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>state.snapshotReads).toBe(2);
 const button=page.getByRole('button',{name:'加载更早消息',exact:true});await expect(button).toBeEnabled();await button.click();
 await expect(page.getByRole('button',{name:'正在加载更早消息…'})).toBeDisabled();expect(state.historyReads).toEqual([]);
 state.holdSnapshot=false;state.finishSnapshot();await expect(page.getByText('更早正文',{exact:true})).toBeVisible();expect(state.historyReads).toEqual(['recent']);expect(state.writes).toEqual([]);
});

test('loaded pages and exhausted cursor survive foreground and stream resync',async({page})=>{
 const state=await setup(page);
 await page.getByRole('button',{name:'加载更早消息',exact:true}).click();await expect(page.getByText('更早正文',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'加载更早消息',exact:true}).click();await expect(page.getByText('最早正文',{exact:true})).toBeVisible();await expect(page.locator('.history-loader')).toHaveCount(0);
 state.fresh=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByText('新快照正文',{exact:true})).toBeVisible();
 await expect(page.getByText('最早正文',{exact:true})).toBeVisible();await expect(page.locator('.history-loader')).toHaveCount(0);
 const previous=state.snapshotReads;await page.evaluate(()=>{(window as any).sources.findLast((s:any)=>!s.closed).dispatchEvent(new MessageEvent('resync',{data:JSON.stringify({id:'history-epoch:1'})}));});await expect.poll(()=>state.snapshotReads).toBeGreaterThan(previous);
 await expect(page.getByText('最早正文',{exact:true})).toBeVisible();await expect(page.locator('.history-loader')).toHaveCount(0);expect(state.historyReads).toEqual(['recent','older']);expect(state.writes).toEqual([]);
 await page.screenshot({path:join(evidence,'history-expanded-desktop.png')});
 await page.setViewportSize({width:390,height:844});await expect(page.getByText('最早正文',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(evidence,'history-expanded-mobile.png')});console.log('Evidence: '+evidence);
});

test('a foreground refresh waits for an in-flight history page instead of aborting it',async({page})=>{
 const state=await setup(page);state.holdHistory=true;await page.getByRole('button',{name:'加载更早消息',exact:true}).click();await expect.poll(()=>state.historyReads.length).toBe(1);
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(300);expect(state.snapshotReads).toBe(1);
 state.holdHistory=false;state.finishHistory();await expect(page.getByText('更早正文',{exact:true})).toBeVisible();await expect.poll(()=>state.snapshotReads).toBe(2);await expect(page.getByText('更早正文',{exact:true})).toBeVisible();expect(state.historyReads).toEqual(['recent']);expect(state.writes).toEqual([]);
});

test('leaving while history is queued does not load the abandoned conversation',async({page})=>{
 const state=await setup(page);state.holdSnapshot=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect.poll(()=>state.snapshotReads).toBe(2);
 await page.getByRole('button',{name:'加载更早消息',exact:true}).click();await expect(page.getByRole('button',{name:'正在加载更早消息…'})).toBeDisabled();
 await page.goto('/');state.holdSnapshot=false;state.finishSnapshot();await expect(page.getByLabel('任务',{exact:true})).toBeVisible();expect(state.historyReads).toEqual([]);expect(state.writes).toEqual([]);
});
