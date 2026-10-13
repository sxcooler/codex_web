import {test,expect,type Page} from '@playwright/test';

async function setup(page:Page){
  const queries:URLSearchParams[]=[],errors:string[]=[],consoleErrors:string[]=[],failed:string[]=[],posts:string[]=[],rows=[
    {id:'star',name:'收藏会话',cwd:'c:\\WORK\\One',updatedAt:1,metadata:{favorite:true}},
    {id:'root',name:'根目录任务',cwd:'C:/work',updatedAt:9},
    {id:'outside',name:'外部任务',cwd:'C:/external/One',updatedAt:8},
    {id:'outside-two',name:'同名外部目录',cwd:'C:/another/One',updatedAt:7.5},
    {id:'one',name:'普通会话',cwd:'C:/work/One',updatedAt:7},
    {id:'missing',name:'缺少目录',updatedAt:6},
    {id:'posix-root',name:'POSIX 根目录',cwd:'/',updatedAt:5.5},
    {id:'fallback',name:'旧元数据目录',updatedAt:5,metadata:{project_path:'C:/work/Two'}},
  ];
  const state={queries,errors,consoleErrors,failed,posts,hold:false,finish:()=>{},fail:false};
  page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});page.on('requestfailed',request=>failed.push(request.url()));
  await page.addInitScript(()=>{(window as any).__sources=[];window.EventSource=class extends EventTarget{constructor(){super();(window as any).__sources.push(this);}close(){}} as any;});
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;let data:any={};
    if(route.request().method()==='POST')posts.push(path);
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects'||path==='/api/projects/refresh')data={projects:[{id:'one',name:'项目一',path:'C:/work/One'},{id:'two',name:'项目二',path:'C:/work/Two'}],workRoot:'C:/work'};
    else if(path==='/api/models')data={data:[]};
    else if(path==='/api/permission-modes')data={modes:[]};
    else if(path==='/api/sessions/one')data={thread:{id:'one',name:'普通会话',turns:[]},phase:'IDLE',pending:[],epoch:'test',revision:0,syncCursor:'test:0'};
    else if(path.endsWith('/status'))data={resync:false};
    else if(path==='/api/sessions'){
      queries.push(url.searchParams);const term=url.searchParams.get('searchTerm');
      if(state.hold&&term==='旧搜索')await new Promise<void>(resolve=>{state.finish=resolve;});
      if(state.fail)return route.fulfill({status:503,json:{error:'列表不可用'}});
      data={data:term?(term==='没有结果'?[]:term==='分页搜索'&&url.searchParams.has('cursor')?[{id:'search-'+url.searchParams.get('cursor'),name:'分页搜索 '+url.searchParams.get('cursor'),cwd:'C:/work/One'}]:[{id:term==='旧搜索'?'stale':'search',name:term+' 索引标题',cwd:'C:/work/One'}]):url.searchParams.has('cursor')?[{id:'page',name:'下一页',cwd:'C:/work/Two',updatedAt:4}]:url.searchParams.get('archived')==='true'?[{id:'archived',name:'归档任务',cwd:'C:/work/One'}]:[...rows,...(url.searchParams.get('includeHidden')==='true'?[{id:'hidden',name:'隐藏任务',metadata:{hidden:true}}]:[])],nextCursor:term==='分页搜索'?url.searchParams.get('cursor')==='search-next'?'search-last':url.searchParams.has('cursor')?null:'search-next':term||url.searchParams.has('cursor')||url.searchParams.has('archived')?null:'next'};
    }
    if(path==='/api/sessions')data.data=data.data.map((row:any)=>({...row,recencyAt:row.updatedAt}));
    await route.fulfill({json:data}).catch(()=>{});
  });
  return state;
}
async function openSidebar(page:Page,width:number){if(width<1001)await page.getByRole('button',{name:'展开左侧栏',exact:true}).click();}

for(const width of [1280,390])test(`sidebar search, grouping, pagination and project picker at ${width}px`,async({page})=>{
  const state=await setup(page);await page.setViewportSize({width,height:900});await page.goto('/');await openSidebar(page,width);
  const sidebar=page.getByRole('complementary',{name:'左侧栏'}),search=sidebar.getByRole('searchbox',{name:'搜索会话标题'}),names=()=>sidebar.locator('.session-link').allTextContents();
  await expect(sidebar.getByRole('combobox',{name:'打开项目新任务'})).toHaveCount(0);
  const grouping=sidebar.getByRole('combobox',{name:'会话分组方式'});
  await expect(grouping).toHaveValue('project');await grouping.selectOption('flat');
  await expect.poll(names).toEqual(['★ 收藏会话','根目录任务','外部任务','同名外部目录','普通会话','缺少目录','POSIX 根目录','旧元数据目录']);
  await grouping.selectOption('project');
  await expect(sidebar.locator('.session-group h3')).toHaveText(['项目一','无项目','One','One','/','项目二']);
  await expect(sidebar.locator('.session-group').filter({has:page.getByRole('heading',{name:'/',exact:true})}).locator('.session-link')).toHaveText('POSIX 根目录');
  await expect(sidebar.locator('.session-group h3').nth(2)).toHaveAttribute('title','C:/external/One');await expect(sidebar.locator('.session-group h3').nth(3)).toHaveAttribute('title','C:/another/One');
  await sidebar.getByRole('button',{name:'加载更多'}).click();await expect(sidebar).toContainText('下一页');
  await search.fill('索引');await expect.poll(()=>state.queries.at(-1)?.get('searchTerm')).toBe('索引');await expect.poll(names).toEqual(['索引 索引标题']);
  expect(state.queries.at(-1)?.has('cursor')).toBe(false);
  await page.screenshot({path:`.local/sidebar-search-${width}.png`});
  await sidebar.getByRole('button',{name:'清空会话搜索'}).click();await expect.poll(names).toContain('普通会话');
  await sidebar.getByLabel('显示已隐藏会话').check();await expect(sidebar).toContainText('隐藏任务（已隐藏）');
  await sidebar.getByRole('combobox',{name:'会话列表范围'}).selectOption('archived');await expect(sidebar.locator('.session-link')).toHaveText('归档任务');
  await sidebar.getByLabel('会话菜单 归档任务').click();await expect(sidebar.getByRole('button',{name:'恢复归档'})).toBeVisible();
  await sidebar.getByRole('combobox',{name:'会话列表范围'}).selectOption('recent');await expect(sidebar).toContainText('普通会话');
  await page.screenshot({path:`.local/sidebar-groups-${width}.png`});
  expect(await sidebar.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.reload();await openSidebar(page,width);await expect(grouping).toHaveValue('project');
  await page.evaluate(()=>{localStorage.setItem('codex-web:session-grouping:v2','flat');window.dispatchEvent(new StorageEvent('storage',{key:'codex-web:session-grouping:v2',newValue:'flat'}));});await expect(grouping).toHaveValue('flat');
  await sidebar.getByRole('button',{name:'＋ 新任务'}).click();
  await page.getByRole('combobox',{name:'项目',exact:true}).selectOption('workspace:two');await page.getByRole('button',{name:'刷新项目'}).click();await expect(page.getByRole('combobox',{name:'项目',exact:true})).toHaveValue('workspace:two');
  expect(state.posts.filter(path=>path!=='/api/auth/renew')).toEqual(['/api/projects/refresh']);expect(state.errors).toEqual([]);
  await page.goto('/sessions/one');await openSidebar(page,width);await expect.poll(()=>page.evaluate(()=>(window as any).__sources.length)).toBe(1);
  await search.fill('连接稳定');await expect.poll(()=>state.queries.at(-1)?.get('searchTerm')).toBe('连接稳定');await expect(sidebar.locator('.session-link')).toHaveText('连接稳定 索引标题');
  const quietReads=state.queries.length,quietFailed=state.failed.length;
  await page.evaluate(()=>{const stream=(window as any).__sources[0];for(let revision=1;revision<=20;revision++){stream.dispatchEvent(new Event('ping'));stream.dispatchEvent(new MessageEvent('change',{data:JSON.stringify({threadId:'one',id:'test:'+revision,revision,patch:{state:{phase:'IDLE'}}})}));}});
  await expect(page.locator('.connection')).toHaveClass('connection online');await page.waitForTimeout(350);expect(state.queries.length).toBe(quietReads);expect(state.failed.length).toBe(quietFailed);expect(await page.evaluate(()=>(window as any).__sources.length)).toBe(1);expect(state.consoleErrors).toEqual([]);

});

test('whitespace-only search edits retain loaded pages, cursor and the session connection',async({page})=>{
  const state=await setup(page);await page.goto('/sessions/one');
  const sidebar=page.locator('.sidebar'),search=sidebar.getByRole('searchbox',{name:'搜索会话标题'}),more=sidebar.getByRole('button',{name:'加载更多'});
  await expect.poll(()=>page.evaluate(()=>(window as any).__sources.length)).toBe(1);
  await search.fill('分页搜索');await expect(sidebar.locator('.session-link')).toHaveText('分页搜索 索引标题');
  await more.click();await expect(sidebar).toContainText('分页搜索 search-next');
  const reads=state.queries.length;
  for(const value of ['分页搜索 ',' 分页搜索 ']){
    await search.fill(value);await page.waitForTimeout(350);
    expect(state.queries.length).toBe(reads);await expect(sidebar).toContainText('分页搜索 search-next');await expect(more).toBeEnabled();
    expect(await page.evaluate(()=>(window as any).__sources.length)).toBe(1);
  }
  await more.click();await expect(sidebar).toContainText('分页搜索 search-last');expect(state.queries.at(-1)?.get('cursor')).toBe('search-last');
  await sidebar.getByRole('button',{name:'清空会话搜索'}).click();await expect(sidebar).toContainText('普通会话');
  const emptyReads=state.queries.length;await search.fill(' ');await page.waitForTimeout(350);expect(state.queries.length).toBe(emptyReads);
  await sidebar.getByRole('button',{name:'清空会话搜索'}).click();await expect(sidebar).toContainText('普通会话');expect(state.queries.length).toBe(emptyReads);
  await more.click();await expect(sidebar).toContainText('下一页');expect(state.queries.at(-1)?.get('cursor')).toBe('next');
  expect(state.errors).toEqual([]);expect(state.consoleErrors).toEqual([]);
});

test('search cancellation, failed refresh and storage failure preserve the correct displayed query',async({page})=>{
  const state=await setup(page);await page.goto('/');const sidebar=page.locator('.sidebar'),search=sidebar.getByRole('searchbox',{name:'搜索会话标题'});
  state.hold=true;await search.fill('旧搜索');await expect.poll(()=>state.queries.at(-1)?.get('searchTerm')).toBe('旧搜索');
  await search.fill('新搜索');await expect(sidebar.locator('.session-link')).toHaveCount(0);await expect(sidebar).toContainText('搜索会话…');
  await expect(sidebar.locator('.session-link')).toHaveText('新搜索 索引标题');state.finish();await expect(sidebar).not.toContainText('旧搜索 索引标题');
  state.fail=true;await sidebar.getByRole('button',{name:'刷新最近会话'}).click();await expect(page.getByRole('alert')).toContainText('列表不可用');await expect(sidebar.locator('.session-link')).toHaveText('新搜索 索引标题');
  await search.fill('没有结果');await expect(sidebar.locator('.session-link')).toHaveCount(0);state.fail=false;await sidebar.getByRole('button',{name:'刷新最近会话'}).click();await expect(sidebar).toContainText('未找到匹配标题的会话');
  await sidebar.getByRole('combobox',{name:'会话分组方式'}).selectOption('flat');
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('blocked');};});await sidebar.getByRole('combobox',{name:'会话分组方式'}).selectOption('project');await expect(sidebar.getByRole('combobox',{name:'会话分组方式'})).toHaveValue('project');await expect(page.getByRole('alert')).toContainText('分组偏好未能保存');
  expect(state.errors).toEqual([]);
});
