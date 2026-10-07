import {test,expect,type Page} from '@playwright/test';

const sections=[['general','常规'],['configuration','配置'],['personalization','个性化'],['usage','使用情况'],['plugins','已安装插件'],['web','Codex Web']] as const;
const accountA='a'.repeat(64),accountB='b'.repeat(64);
async function setup(page:Page){
  let accountId=accountA,usedPercent=29,failRefresh=false,holdRefresh=false,finishRefresh:()=>void=()=>{},unknownReset=false;
  const requests:string[]=[],resets:unknown[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;requests.push(path+url.search);
    let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};
    else if(path==='/api/sessions')data={data:[],nextCursor:null};
    else if(path==='/api/settings')data={origin:'http://localhost',appVersion:'test-version',nodeVersion:'test-node',workRoot:'C:/test/work',modelSource:{version:'test-cli',executable:'C:/test/codex',readAt:Date.now()},runtime:{},diagnostics:{enabled:false,lastWriteAt:null,dropped:0,writeFailures:0},webRestart:{available:true,status:'idle'}};
    else if(path==='/api/codex/settings')return route.fulfill({status:503,json:{error:'配置读取失败'}});
    else if(path==='/api/codex/instructions')return route.fulfill({status:503,json:{error:'指令读取失败'}});
    else if(path==='/api/codex/plugins')data={supported:false,items:[],partial:false,errorCount:0,updatedAt:null};
    else if(path==='/api/account/usage'){
      if(url.search){if(holdRefresh)await new Promise<void>(resolve=>finishRefresh=resolve);if(failRefresh)return route.fulfill({status:401,json:{error:'登录已过期'}});}
      data={accountId,updatedAt:Date.now(),rateLimits:{limitId:'codex',primary:{usedPercent,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600}},rateLimitsByLimitId:null,rateLimitResetCredits:{availableCount:'1',credits:[{id:'credit-one',title:'测试重置机会',resetType:'codexRateLimits',status:'available',expiresAt:null}]},resetSupported:true};
    }else if(path==='/api/account/usage/reset'){
      resets.push(route.request().postDataJSON());if(unknownReset)return route.abort('failed');data={outcome:'reset'};
    }
    await route.fulfill({json:data});
  });
  return {requests,resets,errors,switchAccount:()=>{accountId=accountB;},expire:()=>{failRefresh=true;},hold:()=>{holdRefresh=true;},release:()=>{holdRefresh=false;usedPercent=40;finishRefresh();},unknown:(value:boolean)=>{unknownReset=value;}};
}

for(const width of [390,1440])test(`settings sections are direct routes without horizontal overflow at ${width}px`,async({page})=>{
  const state=await setup(page);await page.setViewportSize({width,height:900});
  for(const [section,label] of sections){
    await page.goto('/settings?section='+section);
    await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
    await expect(page.locator('.settings-section').getByRole('heading',{name:label,exact:true})).toBeVisible();
    if(width===390)await expect(page.getByRole('combobox',{name:'设置分类',exact:true})).toHaveValue(section);
    else await expect(page.getByRole('navigation',{name:'设置分类'}).getByRole('link',{name:label,exact:true})).toHaveAttribute('aria-current','page');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.reload();await expect(page.locator('.settings-section').getByRole('heading',{name:label,exact:true})).toBeVisible();
  }
  if(width===390){await page.getByRole('combobox',{name:'设置分类',exact:true}).selectOption('usage');await expect(page).toHaveURL(/section=usage$/);}
  else await page.getByRole('navigation',{name:'设置分类'}).getByRole('link',{name:'使用情况',exact:true}).click();
  await expect(page.locator('.settings-section').getByText('71% 剩余')).toBeVisible();
  await page.screenshot({path:`.local/web/settings-usage-${width}.png`});
  expect(state.errors).toEqual([]);
});

test('section changes use history, unknown sections fall back, and configuration failures do not block general or usage',async({page})=>{
  const state=await setup(page);await page.goto('/settings?section=unknown');
  await expect(page.locator('.settings-section').getByRole('heading',{name:'常规',exact:true})).toBeVisible();
  const nav=page.getByRole('navigation',{name:'设置分类'});
  await nav.getByRole('link',{name:'配置',exact:true}).click();await expect(page).toHaveURL(/section=configuration$/);
  await expect(page.getByRole('alert').filter({hasText:'配置读取失败'})).toBeVisible();
  await nav.getByRole('link',{name:'使用情况',exact:true}).click();await expect(page.locator('.settings-section').getByText('71% 剩余')).toBeVisible();
  await page.goBack();await expect(page.locator('.settings-section').getByRole('heading',{name:'配置',exact:true})).toBeVisible();
  await page.goForward();await expect(page.locator('.settings-section').getByText('71% 剩余')).toBeVisible();
  await nav.getByRole('link',{name:'Codex Web',exact:true}).click();await expect(page.getByRole('button',{name:'重启 Web 服务',exact:true})).toBeVisible();
  expect(state.requests).toContain('/api/codex/settings');
  expect(state.errors).toEqual([]);
});

test('Codex Web preserves runtime details, model refresh, notifications, layout reset and password change',async({page})=>{
  const state=await setup(page);await page.goto('/settings?section=web');await expect(page.getByText('C:/test/work',{exact:true})).not.toBeVisible();await page.getByText('运行路径与权限详情',{exact:true}).click();
  for(const value of ['test-version','test-node','C:/test/work','test-cli','C:/test/codex'])await expect(page.getByText(value,{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'通知',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'重启Codex',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'刷新模型列表',exact:true}).click();
  expect(state.requests).toContain('/api/models?refresh=true');
  await page.getByRole('button',{name:'重置布局',exact:true}).click();
  await page.getByLabel('当前密码').fill('current-test-password');await page.getByLabel('新密码').fill('new-test-password');
  await page.getByRole('button',{name:'修改密码并退出',exact:true}).click();
  await expect(page.getByRole('heading',{name:'连接你的开发机'})).toBeVisible();
  expect(state.requests).toContain('/api/auth/password');expect(state.errors).toEqual([]);
});

test('usage page and quick dialog share state and one refresh, and a 401 still signs out',async({page})=>{
  const state=await setup(page);await page.goto('/settings?section=usage');
  await expect(page.locator('.settings-section').getByText('71% 剩余')).toBeVisible();await expect(page.locator('.usage-headline')).toContainText('71%');
  expect(state.requests.filter(path=>path==='/api/account/usage')).toHaveLength(1);
  state.hold();await page.locator('.settings-section').getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByRole('button',{name:/账户用量/}).click();
  const dialog=page.getByRole('dialog',{name:'账户用量',exact:true});await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button',{name:'刷新中…',exact:true})).toBeDisabled();
  expect(state.requests.filter(path=>path==='/api/account/usage?refresh=true')).toHaveLength(1);
  state.release();await expect(dialog.getByText('60% 剩余')).toBeVisible();await expect(page.locator('.usage-headline')).toContainText('60%');
  await dialog.getByRole('button',{name:'关闭账户用量'}).click();await expect(page.locator('.settings-section').getByText('60% 剩余')).toBeVisible();
  state.expire();await page.locator('.settings-section').getByRole('button',{name:'刷新',exact:true}).click();
  await expect(page.getByText('登录已过期或失效，请重新登录。')).toBeVisible();expect(state.errors).toEqual([]);
});

test('usage page closes old account confirmation after account switch without consuming credit',async({page})=>{
  const state=await setup(page);await page.clock.install();await page.goto('/settings?section=usage');
  await page.locator('.settings-section').getByRole('button',{name:'使用',exact:true}).click();
  const confirmation=page.getByRole('dialog',{name:'使用重置机会？'});await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button',{name:'取消',exact:true})).toBeFocused();
  state.switchAccount();await page.clock.fastForward(60_000);
  await expect(confirmation).not.toBeVisible();expect(state.resets).toEqual([]);expect(state.errors).toEqual([]);
});

test('closing a quick dialog during reset precheck cannot reopen confirmation while usage page is active',async({page})=>{
  const state=await setup(page);await page.goto('/settings?section=usage');
  await expect(page.locator('.settings-section').getByRole('button',{name:'使用',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:/账户用量/}).click();
  const dialog=page.getByRole('dialog',{name:'账户用量',exact:true});
  state.hold();await dialog.getByRole('button',{name:'使用',exact:true}).click();
  await expect.poll(()=>state.requests.filter(path=>path==='/api/account/usage?refresh=true').length).toBe(1);
  await dialog.getByRole('button',{name:'关闭账户用量'}).click();state.release();
  await expect(page.locator('.settings-section').getByRole('button',{name:'使用',exact:true})).toBeEnabled();
  await expect(page.getByRole('dialog',{name:'使用重置机会？'})).not.toBeVisible();expect(state.resets).toEqual([]);
});

test('unknown reset from usage page survives reload and retries the same idempotency key',async({page})=>{
  const state=await setup(page);state.unknown(true);await page.goto('/settings?section=usage');
  await page.locator('.settings-section').getByRole('button',{name:'使用',exact:true}).click();
  await page.getByRole('dialog',{name:'使用重置机会？'}).getByRole('button',{name:'确认消耗 1 次'}).click();
  await expect(page.locator('.settings-section').getByText('有一次操作结果待核实。',{exact:false})).toBeVisible();
  await expect(page.locator('.settings-section').getByRole('button',{name:'使用',exact:true})).toBeDisabled();
  expect(state.resets).toHaveLength(1);const operation=state.resets[0];
  await page.reload();await expect(page.locator('.settings-section').getByRole('button',{name:'核对并重试本次操作'})).toBeVisible();
  state.unknown(false);await page.locator('.settings-section').getByRole('button',{name:'核对并重试本次操作'}).click();
  await expect(page.locator('.settings-section').getByText('重置成功',{exact:true})).toBeVisible();expect(state.resets).toEqual([operation,operation]);expect(state.errors).toEqual([]);
});

test('existing quick-dialog safety checks still pass',async({page})=>{
  await page.goto('/tests/account-usage.html');await expect(page.locator('#result')).toHaveText('PASS');
});

const projectOne='1'.repeat(24),projectTwo='2'.repeat(24);
const configFixture=()=>({supported:true,writable:true,userVersion:'v1',userFile:'C:/test/.codex/config.toml',fields:{
 model:{userValue:'model-a',effectiveValue:'model-b',origin:{type:'project',file:'C:/test/project/.codex'},writable:true,reason:null},
 model_reasoning_effort:{userValue:'high',effectiveValue:'high',origin:{type:'user',file:'C:/test/.codex/config.toml'},writable:true,reason:null},
 approval_policy:{userValue:'on-request',effectiveValue:'on-request',origin:{type:'enterpriseManaged'},writable:false,reason:'权限由受管要求限制，权限设置只读。'},
 approvals_reviewer:{userValue:'user',effectiveValue:'user',origin:{type:'enterpriseManaged'},writable:false,reason:'权限由受管要求限制，权限设置只读。'},
 sandbox_mode:{userValue:'workspace-write',effectiveValue:'workspace-write',origin:{type:'enterpriseManaged'},writable:false,reason:'权限由受管要求限制，权限设置只读。'},
 workspaceNetworkAccess:{userValue:false,effectiveValue:false,origin:{type:'enterpriseManaged'},writable:false,reason:'权限由受管要求限制，权限设置只读。'},
 web_search:{userValue:'cached',effectiveValue:'cached',origin:{type:'user'},writable:true,reason:null},service_tier:{userValue:'default',effectiveValue:'default',origin:{type:'user'},writable:true,reason:null},...Object.fromEntries(['memoriesEnabled','generateMemories','useMemories','allowExternalMemory'].map(key=>[key,{userValue:null,effectiveValue:null,defaultValue:key!=='memoriesEnabled',origin:null,writable:true,reason:null}]))}});
async function forms(page:Page){
 const base=await setup(page),posts:any[]=[],reads:string[]=[];let writeStatus=409,hold=false,release:()=>void=()=>{},snapshot:any=configFixture();
 let document:any={path:'C:/test/.codex/AGENTS.md',content:'original\r\ntext',version:'i1',exists:true,writable:true,overriddenBy:'C:/test/.codex/AGENTS.override.md'};
 let plugins:any={supported:true,partial:false,errorCount:0,updatedAt:1700000000000,items:[{key:'one',id:'p1',name:'Alpha',description:'First plugin',marketplace:'Market A',localVersion:'1.2',enabled:true,availability:null,reason:null},{key:'two',id:'p2',name:'Alpha',description:null,marketplace:'Market B',localVersion:null,enabled:false,availability:'DISABLED_BY_ADMIN',reason:'disabled_by_admin'}]},pluginFailure=false;
 await page.route('**/api/projects',route=>route.fulfill({json:{projects:[{id:projectOne,name:'One',path:'C:/test/one'},{id:projectTwo,name:'Two',path:'C:/test/two'}]}}));
 await page.route('**/api/models',route=>route.fulfill({json:{data:[{model:'model-a',displayName:'Model A',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'low'}]},{model:'model-b',displayName:'Model B',supportedReasoningEfforts:[{reasoningEffort:'high'}]},{model:'model-low',displayName:'Low only',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]}}));
 await page.route('**/api/permission-modes*',route=>route.fulfill({json:{current:'custom',modes:[{id:'custom',available:false,reason:'受管权限'}]}}));
 await page.route('**/api/codex/**',async route=>{
  const request=route.request(),url=new URL(request.url());reads.push(url.pathname+url.search);
  if(request.method()==='POST'){posts.push(request.postDataJSON());if(hold)await new Promise<void>(resolve=>release=resolve);if(writeStatus!==200)return route.fulfill({status:writeStatus,json:{error:writeStatus===504?'保存结果待核实':'其他编辑者已修改',code:writeStatus===504?'SETTINGS_WRITE_UNKNOWN':'SETTINGS_CONFLICT'}});if(url.pathname.endsWith('instructions')){document={...document,content:request.postDataJSON().content,version:'i2'};return route.fulfill({json:document});}snapshot={...snapshot,userVersion:'v2',fields:{...snapshot.fields,web_search:{...snapshot.fields.web_search,userValue:request.postDataJSON().values.web_search??snapshot.fields.web_search.userValue}}};return route.fulfill({json:{status:'written',snapshot,effect:'future-sessions'}});}
  if(url.pathname.endsWith('settings'))return route.fulfill({json:snapshot});
  if(url.pathname.endsWith('instructions'))return route.fulfill({json:document});
  if(pluginFailure)return route.fulfill({status:503,json:{error:'插件读取失败'}});
  return route.fulfill({json:plugins});
 });
 return {...base,posts,reads,status:(s:number)=>writeStatus=s,hold:()=>hold=true,release:()=>{hold=false;release();},document:(d:any)=>document={...document,...d},snapshot:(s:any)=>snapshot=s,plugins:(p:any)=>plugins=p,failPlugins:()=>pluginFailure=true};
}

test('advanced approval choices omit deprecated policies while valid choices remain editable',async({page})=>{
 const state=await forms(page),snapshot=configFixture();for(const key of ['approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess'] as const)snapshot.fields[key]={...snapshot.fields[key],writable:true,reason:null};state.snapshot(snapshot);
 await page.goto('/settings?section=configuration');const policy=page.getByLabel('审批策略',{exact:true});await expect(policy).toBeEnabled();await expect(policy.locator('option[value="untrusted"],option[value="on-failure"]')).toHaveCount(0);await policy.selectOption('never');await expect(policy).toHaveValue('never');expect(state.posts).toHaveLength(0);
});

for(const old of ['untrusted','on-failure'])test(`deprecated approval ${old} stays displayed readonly while independent search saves`,async({page})=>{
 const state=await forms(page),snapshot=configFixture();for(const key of ['approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess'] as const)snapshot.fields[key]={...snapshot.fields[key],writable:false,reason:`旧审批策略 ${old} 已停用或由原生迁移，权限设置只读。`};snapshot.fields.approval_policy.userValue=old;snapshot.fields.approval_policy.effectiveValue=old;state.snapshot(snapshot);state.status(200);
 await page.goto('/settings?section=configuration');const policy=page.getByLabel('审批策略',{exact:true});await expect(policy).toBeDisabled();await expect(policy).toHaveValue(old);await expect(policy.locator(`option[value="${old}"]`)).toBeDisabled();await expect(page.locator('[data-setting="approval_policy"]')).toContainText('停用或由原生迁移');await expect(page.getByLabel('默认模型',{exact:true})).toBeEnabled();await page.getByLabel('搜索模式',{exact:true}).selectOption('live');await page.getByRole('button',{name:'保存配置',exact:true}).click();expect(state.posts).toEqual([{expectedVersion:'v1',values:{web_search:'live'}}]);await expect(policy).toHaveValue(old);
});

test('configuration shows origins, locks managed permissions, preserves incompatible effort and conflict/unknown drafts',async({page})=>{
 const state=await forms(page);await page.goto('/settings?section=configuration');
 const model=page.getByLabel('默认模型',{exact:true}),effort=page.getByLabel('推理强度',{exact:true});
 await expect(model).toHaveValue('model-a');await expect(page.locator('[data-setting="model"]')).toContainText('model-b');await expect(page.locator('[data-setting="model"]')).toContainText('当前项目覆盖');
 await expect(page.getByLabel('审批策略',{exact:true})).toBeDisabled();await expect(page.getByText('权限由受管要求限制，权限设置只读。').first()).toBeVisible();
 await model.selectOption('model-low');await expect(effort).toHaveValue('high');await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();
 await model.selectOption('model-a');await page.getByLabel('搜索模式',{exact:true}).selectOption('live');
 await page.getByRole('button',{name:'保存配置',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'其他编辑者'})).toBeFocused();await expect(page.getByLabel('搜索模式',{exact:true})).toHaveValue('live');
 await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();await page.getByRole('button',{name:'重新读取并比较',exact:true}).click();
 state.status(504);await page.getByRole('button',{name:'保存配置',exact:true}).click();await expect(page.getByRole('button',{name:'先读回核对',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();expect(state.posts).toHaveLength(2);expect(state.posts[0]).toEqual({expectedVersion:'v1',values:{web_search:'live'}});
 await page.getByRole('button',{name:'先读回核对',exact:true}).click();await expect(page.getByLabel('搜索模式',{exact:true})).toHaveValue('live');
});

test('dirty configuration cancellation restores history, section, sidebar and project before explicit discard',async({page})=>{
 await forms(page);await page.goto('/settings?section=usage');await page.getByRole('navigation',{name:'设置分类'}).getByRole('link',{name:'配置',exact:true}).click();await page.getByLabel('搜索模式',{exact:true}).selectOption('live');
 await page.goBack();const dialog=page.getByRole('dialog',{name:'有未保存的更改'});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(page).toHaveURL(/section=configuration$/);await expect(page.getByLabel('搜索模式',{exact:true})).toHaveValue('live');
 await page.goBack();await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(page).toHaveURL(/section=configuration$/);
 await page.getByLabel('查看项目有效配置',{exact:true}).selectOption(projectOne);await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByLabel('查看项目有效配置',{exact:true})).toHaveValue('');
 await page.getByRole('button',{name:'＋ 新任务',exact:true}).click();await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(page).toHaveURL(/section=configuration$/);
 expect(await page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;})).toBe(true);
 await page.getByRole('navigation',{name:'设置分类'}).getByRole('link',{name:'使用情况',exact:true}).click();await dialog.getByRole('button',{name:'放弃更改',exact:true}).click();await expect(page).toHaveURL(/section=usage$/);
});

for(const width of [390,1440])test(`instructions compare raw text, guard scope/project, save once and fit ${width}px`,async({page})=>{
 const state=await forms(page);state.status(200);await page.setViewportSize({width,height:900});await page.goto('/settings?section=personalization&view=instructions');
 const input=page.getByLabel('指令原始文本',{exact:true});await expect(input).toHaveValue('original\ntext');await expect(page.getByText('C:/test/.codex/AGENTS.override.md',{exact:false})).toBeVisible();await input.focus();await page.keyboard.press('Control+A');await page.keyboard.type('new raw <text>');
 await expect(page.locator('.instructions-diff .deletion').first()).toContainText('original');await expect(page.locator('.instructions-diff .addition').first()).toContainText('new raw <text>');
 await page.getByLabel('指令范围',{exact:true}).selectOption('project');const dialog=page.getByRole('dialog',{name:'有未保存的更改'});await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(input).toHaveValue('new raw <text>');await expect(page.getByLabel('指令范围',{exact:true})).toHaveValue('user');
 await page.screenshot({path:`.local/web/settings-instructions-${width}.png`});await page.locator('.instructions-comparison').screenshot({path:`.local/web/settings-instructions-comparison-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 state.hold();await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByRole('button',{name:'保存中…',exact:true})).toBeDisabled();expect(state.posts).toHaveLength(1);state.release();await expect(page.getByText('指令已保存，后续新会话读取。',{exact:true})).toBeVisible();expect(state.posts[0]).toEqual({scope:'user',expectedVersion:'i1',content:'new raw <text>'});
 await page.getByLabel('指令范围',{exact:true}).selectOption('project');await page.getByLabel('指令项目',{exact:true}).selectOption(projectOne);await expect(input).toBeEnabled();await input.fill('project draft');await page.getByLabel('指令项目',{exact:true}).selectOption(projectTwo);await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByLabel('指令项目',{exact:true})).toHaveValue(projectOne);await expect(input).toHaveValue('project draft');
});

test('instructions missing/read-only, conflict reread and unknown write remain distinct',async({page})=>{
 const state=await forms(page);state.document({content:'',exists:false});await page.goto('/settings?section=personalization&view=instructions');await expect(page.getByText('尚未创建',{exact:true})).toBeVisible();await page.getByLabel('指令原始文本',{exact:true}).fill('draft');await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByLabel('指令原始文本',{exact:true})).toHaveValue('draft');await page.getByRole('button',{name:'重新读取并比较',exact:true}).click();state.status(504);await page.getByRole('button',{name:'保存指令',exact:true}).click();await expect(page.getByRole('button',{name:'先读回核对',exact:true})).toBeVisible();expect(state.posts).toHaveLength(2);state.document({writable:false,reason:'文件只读'});await page.getByRole('button',{name:'先读回核对',exact:true}).click();await expect(page.getByLabel('指令原始文本',{exact:true})).toBeDisabled();await expect(page.getByLabel('指令原始文本',{exact:true})).toHaveValue('draft');await expect(page.getByText('文件只读',{exact:true})).toBeVisible();
});

test('plugins filter locally and preserve last success through refresh failure; unsupported, partial and empty differ',async({page})=>{
 const state=await forms(page);await page.goto('/settings?section=plugins');await expect(page.locator('.installed-plugins summary')).toHaveCount(2);await expect(page.getByText('市场：Market A',{exact:true})).not.toBeVisible();for(const detail of await page.locator('.installed-plugins summary').all())await detail.click();await expect(page.getByText('市场：Market A',{exact:true})).toBeVisible();await expect(page.getByText('市场：Market B',{exact:true})).toBeVisible();await expect(page.locator('.plugin-status').filter({hasText:'已启用'})).toBeVisible();await expect(page.getByText('版本：未知',{exact:true})).toBeVisible();const timestamp=await page.getByTestId('plugins-updated').innerText();
 await page.getByLabel('搜索已安装插件',{exact:true}).fill('missing');await expect(page.getByText('没有匹配的已安装插件',{exact:true})).toBeVisible();expect(state.reads.filter(p=>p.endsWith('/plugins'))).toHaveLength(1);await page.getByLabel('搜索已安装插件',{exact:true}).fill('');state.failPlugins();await page.getByRole('button',{name:'刷新插件',exact:true}).click();await expect(page.getByText('列表待更新',{exact:false})).toBeVisible();await page.locator('.installed-plugins summary').first().click();await expect(page.getByText('市场：Market A',{exact:true})).toBeVisible();expect(await page.getByTestId('plugins-updated').innerText()).toBe(timestamp);await expect(page.getByRole('button',{name:/安装|卸载|启停/})).toHaveCount(0);
 await page.unroute('**/api/codex/**');await page.route('**/api/codex/plugins',route=>route.fulfill({json:{supported:false,items:[],partial:false,errorCount:0,updatedAt:null}}));await page.reload();await expect(page.getByText('当前 Codex 版本不支持读取已安装插件',{exact:true})).toBeVisible();await expect(page.getByText('暂无已安装插件',{exact:true})).toHaveCount(0);
 await page.unroute('**/api/codex/plugins');await page.route('**/api/codex/plugins',route=>route.fulfill({json:{supported:true,items:[],partial:true,errorCount:2,updatedAt:1700000000000}}));await page.reload();await expect(page.getByText('部分市场读取失败：2 个；当前列表不完整。',{exact:true})).toBeVisible();await expect(page.getByText('暂无已安装插件',{exact:true})).toHaveCount(0);
 await page.unroute('**/api/codex/plugins');await page.route('**/api/codex/plugins',route=>route.fulfill({json:{supported:true,items:[],partial:false,errorCount:0,updatedAt:1700000000000}}));await page.reload();await expect(page.getByText('暂无已安装插件',{exact:true})).toBeVisible();
});

for(const width of [390,1440])test(`configuration and plugin forms support keyboard and fit ${width}px`,async({page})=>{
 const state=await forms(page);state.status(200);await page.setViewportSize({width,height:900});await page.goto('/settings?section=configuration');
 await page.getByLabel('搜索模式',{exact:true}).focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('End');for(let i=0;i<4;i++)await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeFocused();await page.screenshot({path:`.local/web/settings-configuration-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 if(width===390)await page.getByRole('combobox',{name:'设置分类',exact:true}).selectOption('plugins');else await page.getByRole('navigation',{name:'设置分类'}).getByRole('link',{name:'已安装插件',exact:true}).click();
 await page.getByRole('dialog',{name:'有未保存的更改'}).getByRole('button',{name:'保存并离开',exact:true}).click();await page.locator('.installed-plugins summary').first().click();await expect(page.getByText('市场：Market A',{exact:true})).toBeVisible();expect(state.posts).toHaveLength(1);await page.getByLabel('搜索已安装插件',{exact:true}).focus();await page.keyboard.type('Alpha');await page.screenshot({path:`.local/web/settings-plugins-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(state.errors).toEqual([]);
});

test('dirty forward cancel retains history and failed save cancels departure',async({page})=>{
 const state=await forms(page);await page.goto('/settings?section=configuration');const nav=page.getByRole('navigation',{name:'设置分类'});await nav.getByRole('link',{name:'使用情况',exact:true}).click();await page.goBack();await page.getByLabel('搜索模式',{exact:true}).selectOption('live');await page.goForward();const dialog=page.getByRole('dialog',{name:'有未保存的更改'});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(page).toHaveURL(/section=configuration$/);await expect(page.getByLabel('搜索模式',{exact:true})).toHaveValue('live');
 await nav.getByRole('link',{name:'使用情况',exact:true}).click();await dialog.getByRole('button',{name:'保存并离开',exact:true}).click();await expect(dialog).not.toBeVisible();await expect(page.getByRole('alert').filter({hasText:'其他编辑者'})).toBeFocused();await expect(page).toHaveURL(/section=configuration$/);await expect(page.getByLabel('搜索模式',{exact:true})).toHaveValue('live');expect(state.posts).toHaveLength(1);
 await page.goForward();await dialog.getByRole('button',{name:'放弃更改',exact:true}).click();await expect(page).toHaveURL(/section=usage$/);
});

test('project effective model mismatch blocks save without replacing user effort',async({page})=>{
 const state=await forms(page);await page.goto('/settings?section=configuration');await page.getByLabel('推理强度',{exact:true}).selectOption('low');await expect(page.getByLabel('推理强度',{exact:true})).toHaveValue('low');await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();expect(state.posts).toHaveLength(0);
});

test('permission presets save fixed atomic fields and allow network only with workspace sandbox',async({page})=>{
 const state=await forms(page),snapshot=configFixture();for(const key of ['approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess'] as const)snapshot.fields[key]={...snapshot.fields[key],writable:true,reason:null,origin:{type:'user'}};
 snapshot.fields.sandbox_mode.userValue='read-only';snapshot.fields.sandbox_mode.effectiveValue='read-only';snapshot.fields.workspaceNetworkAccess.writable=false;snapshot.fields.workspaceNetworkAccess.reason='网络选项仅能在 workspace-write 沙箱下编辑。';state.snapshot(snapshot);state.status(200);
 await page.route('**/api/permission-modes*',route=>route.fulfill({json:{current:'custom',modes:[{id:'custom',available:true},{id:'ask',available:true},{id:'auto-review',available:true},{id:'full-access',available:true}]}}));await page.goto('/settings?section=configuration');await expect(page.getByLabel('工作区网络访问',{exact:true})).toBeDisabled();await page.getByLabel('权限预设',{exact:true}).selectOption('auto-review');await expect(page.getByLabel('工作区网络访问',{exact:true})).toBeEnabled();await page.getByLabel('工作区网络访问',{exact:true}).selectOption('true');await page.getByLabel('权限预设',{exact:true}).selectOption('full-access');await expect(page.getByLabel('工作区网络访问',{exact:true})).toBeDisabled();await page.getByRole('button',{name:'保存配置',exact:true}).click();expect(state.posts[0]).toEqual({expectedVersion:'v1',values:{approval_policy:'never',sandbox_mode:'danger-full-access'}});
});

for(const section of ['configuration','personalization'])for(const departure of ['discard','save'])test(`review logout guard ${section} ${departure} cancels before auth mutation`,async({page})=>{
 const state=await forms(page),writes:string[]=[];state.status(200);await page.route('**/api/auth/logout',async route=>{writes.push('logout');await route.fulfill({json:{}});});page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname.startsWith('/api/codex/'))writes.push('save');});const route='/settings?section='+section+(section==='personalization'?'&view=instructions':'');await page.goto(route);
 const input=section==='configuration'?page.getByLabel('搜索模式',{exact:true}):page.getByLabel('指令原始文本',{exact:true});if(section==='configuration')await input.selectOption('live');else await input.fill('logout draft');
 await page.getByRole('button',{name:'↪ 退出',exact:true}).click();const dialog=page.getByRole('dialog',{name:'有未保存的更改'});await expect(dialog).toBeVisible();expect(writes).toEqual([]);await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(page).toHaveURL(new RegExp('section='+section+(section==='personalization'?'&view=instructions':'')+'$'));await expect(input).toHaveValue(section==='configuration'?'live':'logout draft');expect(writes).toEqual([]);
 await page.getByRole('button',{name:'↪ 退出',exact:true}).click();await dialog.getByRole('button',{name:departure==='discard'?'放弃更改':'保存并离开',exact:true}).click();await expect(page.getByRole('heading',{name:'连接你的开发机',exact:true})).toBeVisible();expect(writes).toEqual(departure==='discard'?['logout']:['save','logout']);
});

for(const missing of ['model','effort'])test(`review missing user ${missing} cannot borrow project defaults for save`,async({page})=>{
 const state=await forms(page),snapshot:any=configFixture();snapshot.fields.model.effectiveValue='model-a';snapshot.fields.model_reasoning_effort.effectiveValue='high';snapshot.fields.model_reasoning_effort.origin={type:'project',file:'C:/test/project/.codex'};snapshot.fields[missing==='model'?'model':'model_reasoning_effort'].userValue=null;state.snapshot(snapshot);await page.goto('/settings?section=configuration');
 if(missing==='model')await page.getByLabel('推理强度',{exact:true}).selectOption('low');else await page.getByLabel('默认模型',{exact:true}).selectOption('model-b');await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();await expect(page.getByRole('alert').filter({hasText:missing==='model'?'用户默认模型尚未确定':'用户推理强度尚未确定'})).toBeVisible();expect(state.posts).toHaveLength(0);
 if(missing==='model')await page.getByLabel('默认模型',{exact:true}).selectOption('model-a');else await page.getByLabel('推理强度',{exact:true}).selectOption('high');await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeEnabled();await expect(page.getByLabel(missing==='model'?'推理强度':'默认模型',{exact:true})).toHaveValue(missing==='model'?'low':'model-b');
});

test('review native custom permission classification and local network differences stay custom',async({page})=>{
 const state=await forms(page),snapshot=configFixture();for(const key of ['approval_policy','approvals_reviewer','sandbox_mode','workspaceNetworkAccess'] as const)snapshot.fields[key]={...snapshot.fields[key],writable:true,reason:null,origin:{type:'user'}};snapshot.fields.workspaceNetworkAccess.userValue=true;snapshot.fields.workspaceNetworkAccess.effectiveValue=true;state.snapshot(snapshot);await page.route('**/api/permission-modes*',route=>route.fulfill({json:{current:'custom',modes:[{id:'custom',available:true},{id:'ask',available:true},{id:'auto-review',available:true},{id:'full-access',available:true}]}}));await page.goto('/settings?section=configuration');await expect(page.getByLabel('权限预设',{exact:true})).toHaveValue('custom');await page.getByLabel('权限预设',{exact:true}).selectOption('ask');await expect(page.getByLabel('工作区网络访问',{exact:true})).toHaveValue('false');await expect(page.getByLabel('权限预设',{exact:true})).toHaveValue('ask');await page.getByLabel('工作区网络访问',{exact:true}).selectOption('true');await expect(page.getByLabel('权限预设',{exact:true})).toHaveValue('custom');expect(state.posts).toHaveLength(0);
});

async function shortcutComposer(page:Page,shortcut:'enter'|'mod-enter'){
 const state=await setup(page),posts:any[]=[];
 await page.addInitScript(value=>{localStorage.setItem('codex-web:send-shortcut:v1',value);window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;},shortcut);
 await page.route('**/api/models*',route=>route.fulfill({json:{data:[]}}));await page.route('**/api/permission-modes*',route=>route.fulfill({json:{modes:[]}}));
 await page.route('**/api/sessions',async route=>{if(route.request().method()==='POST'){posts.push(route.request().postDataJSON());return route.abort('failed');}return route.fulfill({json:{data:[],nextCursor:null}});});
 await page.route('**/api/sessions/shortcut',route=>route.fulfill({json:{thread:{id:'shortcut',turns:[]},phase:'IDLE',pending:[]}}));
 await page.route('**/api/sessions/shortcut/messages',async route=>{posts.push(route.request().postDataJSON());await route.abort('failed');});
 return {...state,posts};
}
for(const entry of ['/', '/sessions/shortcut'])for(const shortcut of ['enter','mod-enter'] as const)test(`send shortcut ${shortcut} protects IME and Shift, submits once and preserves unknown guards on ${entry}`,async({page})=>{
 const state=await shortcutComposer(page,shortcut);await page.goto(entry);const input=page.getByRole('textbox',{name:entry==='/'?'任务':'继续这个会话',exact:true}),send=page.getByRole('button',{name:entry==='/'?'开始任务 →':'发送',exact:true});
 await input.fill('shortcut message');await expect(send).toBeEnabled();await input.press('Shift+Enter');await expect(input).toHaveValue('shortcut message\n');expect(state.posts).toHaveLength(0);
 await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,isComposing:true,ctrlKey:true});await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,metaKey:true});await expect(input).toHaveValue('shortcut message\n');expect(state.posts).toHaveLength(0);
 if(shortcut==='mod-enter'){await input.press('Enter');await expect(input).toHaveValue('shortcut message\n\n');expect(state.posts).toHaveLength(0);}
 await input.press(shortcut==='enter'?'Enter':'Control+Enter');await expect.poll(()=>state.posts.length).toBe(1);expect(state.posts[0][entry==='/'?'prompt':'text']).toBe(shortcut==='enter'?'shortcut message\n':'shortcut message\n\n');expect(state.posts[0].clientRequestId).toBeTruthy();expect(state.posts[0].attachmentIds).toEqual([]);
 await expect(send).toBeDisabled();await input.fill('must not retry');await input.press(shortcut==='enter'?'Enter':'Meta+Enter');expect(state.posts).toHaveLength(1);expect(state.errors).toEqual([]);
});
for(const entry of ['/', '/sessions/shortcut'])test(`mobile soft Enter and modifiers never send on ${entry}`,async({page})=>{
 const state=await shortcutComposer(page,'mod-enter');await page.setViewportSize({width:390,height:844});await page.goto(entry);const input=page.getByRole('textbox',{name:entry==='/'?'任务':'继续这个会话',exact:true});await input.fill('mobile');await expect(page.getByRole('button',{name:entry==='/'?'开始任务 →':'发送',exact:true})).toBeEnabled();await input.press('Enter');await expect(input).toHaveValue('mobile\n');await input.press('Control+Enter');await input.press('Meta+Enter');expect(state.posts).toHaveLength(0);expect(state.errors).toEqual([]);
});

test('general shortcut saves immediately and reports persistence failure without a native write',async({page})=>{
 const state=await setup(page);await page.goto('/settings');const shortcut=page.getByLabel('桌面发送快捷键',{exact:true});await expect(shortcut).toHaveValue('enter');await shortcut.selectOption('mod-enter');
 expect(await page.evaluate(()=>localStorage.getItem('codex-web:send-shortcut:v1'))).toBe('mod-enter');await page.reload();await expect(shortcut).toHaveValue('mod-enter');
 await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('storage denied');};});await shortcut.selectOption('enter');await expect(page.getByRole('alert').filter({hasText:'未持久化'})).toBeFocused();expect(await page.evaluate(()=>localStorage.getItem('codex-web:send-shortcut:v1'))).toBe('mod-enter');await expect(shortcut).toHaveValue('mod-enter');expect(state.requests.filter(path=>path.includes('restart'))).toEqual([]);expect(state.errors).toEqual([]);
});
for(const width of [390,1440])test(`Codex Web diagnostic summary reflects current status without a toggle at ${width}px`,async({page})=>{
 await setup(page);let diagnostics:any={enabled:true,lastWriteAt:1700000000000,dropped:7,writeFailures:2};await page.route('**/api/settings',route=>route.fulfill({json:{origin:'http://localhost',runtime:{permissionModes:null,note:'有效权限尚未读取'},diagnostics}}));await page.setViewportSize({width,height:900});await page.goto('/settings?section=web');const summary=page.getByRole('region',{name:'当前诊断状态',exact:true});await expect(summary).toContainText('已启用');await expect(summary).toContainText('7');await expect(summary).toContainText('2');await expect(summary.getByTestId('diagnostics-last-write')).toHaveText(await page.evaluate(()=>new Date(1700000000000).toLocaleString()));await expect(summary.getByRole('button')).toHaveCount(0);await expect(summary.getByRole('checkbox')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 diagnostics={enabled:false,lastWriteAt:null,dropped:0,writeFailures:0};await page.reload();await expect(summary).toContainText('未启用');await expect(summary.getByTestId('diagnostics-last-write')).toHaveText('尚无成功写入');await page.screenshot({path:`.local/web/settings-general-${width}.png`});
});
