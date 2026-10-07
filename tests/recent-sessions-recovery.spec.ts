import {test,expect,type Page} from '@playwright/test';
const pendingReads=new Set<()=>void>();
test.afterEach(()=>{for(const finish of pendingReads)finish();pendingReads.clear();});

async function setup(page:Page){
  const state={reads:0,fail:false,hold:false,finish:()=>{},posted:0};
  page.on('close',()=>state.finish());
  await page.addInitScript(()=>{
    window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;
    AbortSignal.timeout=milliseconds=>{const controller=new AbortController();setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),milliseconds);return controller.signal;};
  });
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};
    else if(path==='/api/sessions'){
      state.reads++;
      if(state.hold)await new Promise<void>(resolve=>{state.finish=()=>{pendingReads.delete(state.finish);resolve();};pendingReads.add(state.finish);});
      if(state.fail){await route.abort('failed');return;}
      data={data:[{id:'list-recovery',name:'保留当前会话',release:{requested:true,handoffReady:false}}],nextCursor:null};
    }else if(path==='/api/sessions/list-recovery')data={thread:{id:'list-recovery',name:'保留当前会话',turns:[{id:'done',status:'completed',items:[{type:'agentMessage',id:'answer',text:'已完成的内容仍在这里'}]}]},phase:'IDLE',pending:[],epoch:'test',revision:0,syncCursor:'test:0'};
    else if(path==='/api/models')data={data:[]};
    else if(path==='/api/permission-modes')data={modes:[]};
    else if(path.endsWith('/status'))data={resync:false};
    else if(path.endsWith('/messages'))state.posted++;
    await route.fulfill({json:data}).catch(()=>{});
  });
  return state;
}

for(const width of [1280,390])test(`background list retries keep the error and layout stable until success at ${width}px`,async({page})=>{
  const state=await setup(page);await page.setViewportSize({width,height:900});await page.clock.install();
  await page.goto('/sessions/list-recovery');
  await expect(page.locator('.timeline')).toContainText('已完成的内容仍在这里');
  state.fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  const alert=page.locator('.app-notifications [role="alert"]');
  await expect(alert).toContainText('无法连接服务器');
  await page.getByRole('textbox',{name:'继续这个会话'}).fill('保留草稿');
  const top=await page.locator('.session-layout').evaluate(element=>element.getBoundingClientRect().top);
  state.hold=true;const before=state.reads;
  await page.clock.runFor(5100);await expect.poll(()=>state.reads).toBeGreaterThan(before);
  await expect(alert).toBeVisible();
  expect(await page.locator('.session-layout').evaluate(element=>element.getBoundingClientRect().top)).toBe(top);
  await page.screenshot({path:`.local/connection-retry-${width}.png`});
  state.hold=false;state.finish();await expect(page.locator('[aria-label="刷新最近会话"]')).toBeEnabled();
  await expect(alert).toBeVisible();
  state.fail=false;await page.clock.runFor(5100);await expect(alert).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'继续这个会话'})).toHaveValue('保留草稿');
  expect(state.posted).toBe(0);
});

test('a hung background list read times out and the next poll recovers without a page reload',async({page})=>{
  const state=await setup(page);await page.clock.install();await page.goto('/sessions/list-recovery');
  await expect(page.locator('.timeline')).toContainText('已完成的内容仍在这里');
  await expect(page.locator('[aria-label="刷新最近会话"]')).toBeEnabled();
  const initial=state.reads;
  state.hold=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>state.reads).toBeGreaterThan(initial);
  await expect(page.locator('[aria-label="刷新最近会话"]')).toBeDisabled();
  const before=state.reads;await page.clock.runFor(31_000);
  await expect(page.locator('.app-notifications [role="alert"]')).toContainText('读取超时');
  expect(state.reads).toBe(before);
  state.hold=false;state.finish();await page.clock.runFor(5100);
  await expect(page.locator('[aria-label="刷新最近会话"]')).toBeEnabled();
  await expect(page.locator('.app-notifications [role="alert"]')).toHaveCount(0);
  expect(state.reads).toBeGreaterThan(before);expect(state.posted).toBe(0);
});

test('changing the list filter cancels a stuck old request without displaying its cancellation',async({page})=>{
  const state=await setup(page),failed:string[]=[];
  page.on('requestfailed',request=>failed.push(request.url()));
  await page.goto('/sessions/list-recovery');await expect(page.locator('.timeline')).toContainText('已完成的内容仍在这里');
  await expect(page.locator('[aria-label="刷新最近会话"]')).toBeEnabled();
  const before=state.reads;state.hold=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>state.reads).toBeGreaterThan(before);
  state.hold=false;await page.locator('.show-hidden input').check();
  await expect.poll(()=>failed.some(url=>new URL(url).pathname==='/api/sessions')).toBe(true);
  await expect(page.locator('[aria-label="刷新最近会话"]')).toBeEnabled();state.finish();
  await expect(page.locator('.app-notifications [role="alert"]')).toHaveCount(0);expect(state.posted).toBe(0);
});

test('session sort persists, reorders loaded dates with favorites first and cancels old pagination',async({page})=>{
  const state=await setup(page),queries:string[]=[];let finishOld=()=>{};
  await page.route('**/api/sessions?**',async route=>{
    const query=new URL(route.request().url()).searchParams;queries.push(query.toString());
    if(query.has('cursor')){await new Promise<void>(resolve=>{finishOld=resolve;pendingReads.add(resolve);});await route.fulfill({json:{data:[{id:'stale',name:'过期分页'}],nextCursor:null}}).catch(()=>{});return;}
    await route.fulfill({json:{data:[{id:'updated',name:'更新较新',createdAt:10,updatedAt:40},{id:'created',name:'创建较新',createdAt:30,updatedAt:20},{id:'star',name:'收藏会话',createdAt:1,updatedAt:1,metadata:{favorite:true}}],nextCursor:'old-page'}});
  });
  await page.goto('/sessions/list-recovery');
  const names=()=>page.locator('.recent .session-link').allTextContents();
  await expect.poll(names).toEqual(['★ 收藏会话','更新较新','创建较新']);
  await page.getByRole('button',{name:'加载更多'}).click();await expect.poll(()=>queries.some(query=>query.includes('cursor=old-page'))).toBe(true);
  await page.evaluate(async()=>{const prefs=await import('/src/web/preferences.ts');prefs.writeSessionSort('created_at');});
  await expect.poll(names).toEqual(['★ 收藏会话','创建较新','更新较新']);finishOld();
  await expect(page.locator('.recent')).not.toContainText('过期分页');
  expect(queries.at(-1)).toBe('sortKey=created_at');
  await page.reload();await expect.poll(names).toEqual(['★ 收藏会话','创建较新','更新较新']);
  await page.evaluate(()=>{localStorage.setItem('codex-web:session-sort:v1','updated_at');window.dispatchEvent(new StorageEvent('storage',{key:'codex-web:session-sort:v1',newValue:'updated_at'}));});
  await expect.poll(names).toEqual(['★ 收藏会话','更新较新','创建较新']);expect(state.posted).toBe(0);
});
