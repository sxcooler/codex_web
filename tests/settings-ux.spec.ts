import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

const account='a'.repeat(64);
const field=(value:string|boolean|null,extra:Record<string,unknown>={})=>({userValue:value,effectiveValue:value,origin:{type:'user'},writable:true,reason:null,...extra});
async function setup(page:Page){
 let version=1,fail=false,usage:any={accountId:account,updatedAt:Date.now(),rateLimits:{limitId:'codex',primary:{usedPercent:20,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:62,windowDurationMins:10080,resetsAt:1800000000},credits:{hasCredits:true,unlimited:false,balance:'62500'}},rateLimitsByLimitId:null,rateLimitResetCredits:{availableCount:'1',credits:[]},resetSupported:false};
 const fields:any={model:field('model-a'),model_reasoning_effort:field('high'),approval_policy:field('on-request'),approvals_reviewer:field('auto_review'),sandbox_mode:field('workspace-write'),workspaceNetworkAccess:field(false),web_search:field('cached'),service_tier:field('default'),memoriesEnabled:field(null,{defaultValue:false}),generateMemories:field(null,{defaultValue:true}),useMemories:field(null,{defaultValue:true}),allowExternalMemory:field(null,{defaultValue:true})};
 const posts:any[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(message.type()==='error'&&!(fail&&message.text().includes('504')))errors.push(message.text());});
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;let data:any={};
  if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
  else if(path==='/api/projects')data={projects:[]};
  else if(path==='/api/sessions')data={data:[{id:'older',preview:'较早创建',createdAt:1,updatedAt:20},{id:'newer',preview:'较晚创建',createdAt:2,updatedAt:10}],nextCursor:null};
  else if(path==='/api/models')data={data:[{model:'model-a',displayName:'Model A',isDefault:true,defaultServiceTier:'default',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'low'}],serviceTiers:[{id:'priority',name:'Fast',description:'Native fast tier'},{id:'research',name:'Research',description:'Native research tier'}]}]};
  else if(path==='/api/permission-modes')data={current:'auto-review',modes:[{id:'ask',available:true},{id:'auto-review',available:true},{id:'full-access',available:true},{id:'custom',available:true}]};
  else if(path==='/api/codex/settings'){
   if(request.method()==='POST'){posts.push(request.postDataJSON());if(fail)return route.fulfill({status:504,json:{error:'保存结果待核实'}});for(const [key,value]of Object.entries(request.postDataJSON().values))fields[key]={...fields[key],userValue:value,effectiveValue:value};version++;}
   data={supported:true,writable:true,userVersion:'v'+version,userFile:'C:/test/.codex/config.toml',fields};if(request.method()==='POST')data={snapshot:data};
  }else if(path==='/api/codex/instructions')data={path:'C:/test/.codex/AGENTS.md',content:'same\nold line\nlast',version:'i1',exists:true,writable:true,overriddenBy:null};
  else if(path==='/api/codex/plugins')data={supported:true,items:Array.from({length:12},(_,i)=>({key:'p'+i,id:'plugin-'+i,name:'插件 '+i,description:'简短说明，工具能力由当前会话连接状态决定。',enabled:i%2===0,marketplace:'Local',localVersion:'1.0',availability:'AVAILABLE'})),partial:false,errorCount:0,updatedAt:Date.now()};
  else if(path==='/api/account/usage')data=usage;
  else if(path==='/api/settings')data={origin:'http://localhost',appVersion:'test',nodeVersion:'24',workRoot:'C:/test/work',modelSource:{version:'test-cli',executable:'C:/test/codex',readAt:Date.now()},diagnostics:{enabled:true,lastWriteAt:1700000000000,dropped:0,writeFailures:0},runtime:{note:'只读诊断'},webRestart:{available:true,status:'idle'}};
  await route.fulfill({json:data});
 });
 return {posts,errors,fields,fail:()=>fail=true,usage:(value:any)=>usage={...usage,...value,updatedAt:Date.now()}};
}
async function screenshot(page:Page,name:string){await mkdir('.local/settings-ux',{recursive:true});await page.screenshot({path:'.local/settings-ux/'+name+'.png'});}

for(const width of [1440,390])test(`usage cards have the same inset in settings and quick dialog at ${width}px`,async({page})=>{
 const state=await setup(page);state.usage({rateLimitResetCredits:{availableCount:'1',credits:[{id:'render-only-credit',title:'额外 Codex 限额',description:'仅用于渲染验证的重置机会。',resetType:'codexRateLimits',status:'available',expiresAt:null}]},resetSupported:true});await page.setViewportSize({width,height:width===390?844:900});await page.goto('/settings?section=usage');
 const insets=async(root:string)=>page.locator(root+' .usage-group').evaluateAll(cards=>cards.map(card=>{const child=card.querySelector('h3')!,box=card.getBoundingClientRect(),heading=child.getBoundingClientRect();return {left:heading.left-box.left,top:heading.top-box.top,padding:getComputedStyle(card).padding};}));
 await expect(page.locator('.settings .usage-group progress')).toHaveCount(2);await expect(page.locator('.settings').getByRole('button',{name:'刷新',exact:true})).toBeEnabled();const settings=await insets('.settings');await screenshot(page,`regression-usage-settings-${width}`);await page.getByRole('button',{name:/账户用量/}).click();await expect(page.getByRole('dialog',{name:'账户用量',exact:true}).getByRole('button',{name:'刷新',exact:true})).toBeEnabled();const quick=await insets('.account-usage-dialog[open]');
 console.log('usage geometry',width,{settings,quick});await screenshot(page,`regression-usage-${width}`);await expect(page.getByRole('dialog',{name:'账户用量',exact:true}).locator('.usage-credit')).toContainText('额外 Codex 限额');await page.getByRole('dialog',{name:'账户用量',exact:true}).locator('.usage-credit').scrollIntoViewIfNeeded();await screenshot(page,`regression-usage-reset-${width}`);
 for(const card of quick){expect(card.left).toBeGreaterThanOrEqual(16);expect(card.top).toBeGreaterThanOrEqual(16);}expect(quick).toEqual(settings);
 const gap=await page.locator('.account-usage-dialog[open]').evaluate(el=>el.querySelector('.usage-content:not(.usage-dialog-heading)>p')!.getBoundingClientRect().top-el.querySelector('.usage-dialog-heading')!.getBoundingClientRect().bottom);
 expect(gap).toBeLessThanOrEqual(16);expect(state.posts).toEqual([]);expect(state.errors).toEqual([]);
});

for(const width of [1440,390])test(`settings switch thumb fits both states and card footnotes have space at ${width}px`,async({page})=>{
 const state=await setup(page);await page.setViewportSize({width,height:width===390?844:900});await page.goto('/settings?section=general');
 const footnote=async()=>page.locator('.settings-group>.settings-card+p').evaluateAll(notes=>notes.map(note=>note.getBoundingClientRect().top-note.previousElementSibling!.getBoundingClientRect().bottom));
 await expect(page.locator('.settings-group>.settings-card+p')).toHaveCount(1);const speed=await footnote();console.log('footnote geometry',width,speed);expect.soft(speed[0]).toBeGreaterThanOrEqual(10);
 await page.goto('/settings?section=personalization');const input=page.getByRole('switch',{name:'启用 Codex 记忆',exact:true});
 const geometry=()=>input.evaluate(el=>{const style=getComputedStyle(el),thumb=getComputedStyle(el,'::before'),bounds=el.getBoundingClientRect();return {padding:style.padding,width:bounds.width,height:bounds.height,thumbRight:parseFloat(thumb.left)+parseFloat(thumb.width)+new DOMMatrix(thumb.transform==='none'?undefined:thumb.transform).m41,border:parseFloat(style.borderLeftWidth),background:style.backgroundColor,lineHeight:style.lineHeight};});
 for(const checked of [false,true]){if(checked){await input.focus();await input.press('Space');}await expect(input).toBeChecked({checked});await expect(input).toHaveCSS('background-color',checked?'rgb(40, 124, 225)':'rgb(66, 66, 66)');await expect.poll(async()=>(await geometry()).thumbRight).toBe(checked?30:16);const actual=await geometry();console.log('switch geometry',width,checked,actual);expect.soft(actual.padding).toBe('0px');expect.soft(actual.width).toBe(34);expect.soft(actual.height).toBe(20);expect.soft(actual.thumbRight).toBeLessThanOrEqual(actual.width-actual.border*2);}
 for(const gap of await footnote())expect.soft(gap).toBeGreaterThanOrEqual(10);
 await screenshot(page,`regression-switch-${width}`);state.fields.memoriesEnabled={...state.fields.memoriesEnabled,writable:false,reason:'由管理员控制'};await page.reload();await expect(input).toBeDisabled();await expect(input).not.toBeChecked();expect((await geometry()).padding).toBe('0px');await screenshot(page,`regression-switch-disabled-${width}`);expect(state.posts).toEqual([]);expect(state.errors).toEqual([]);
});

for(const width of [1440,390])test(`global errors can be dismissed without resizing or scrolling the session at ${width}px`,async({page})=>{
 const state=await setup(page);let failed=false;await page.setViewportSize({width,height:width===390?844:900});
 await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
 await page.route('**/api/sessions?*',route=>route.fulfill(failed?{status:503,json:{error:'同步失败，需要人工检查。'.repeat(150)}}:{json:{data:[],nextCursor:null}}));
 await page.route('**/api/sessions/geometry',route=>route.fulfill({json:{thread:{id:'geometry',name:'布局回归',turns:[]},phase:'IDLE',activeTurnId:null,pending:[],epoch:'test',syncCursor:'test:0'}}));
 await page.goto('/sessions/geometry');const composer=page.getByRole('textbox',{name:'继续这个会话',exact:true});await expect(composer).toBeVisible();await composer.focus();
 const layout=()=>page.evaluate(()=>[document.documentElement,document.querySelector('.workspace-content')!,document.querySelector('.session-layout')!].map(el=>({height:el.clientHeight,scroll:el.scrollHeight,top:el.scrollTop})));
 const before=await layout();failed=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.getByRole('alert').filter({hasText:'最近会话同步失败'})).toBeVisible();
 const shown=await layout();console.log('notice geometry',width,{before,shown});await screenshot(page,`regression-notice-${width}`);expect.soft(shown).toEqual(before);
 await page.route('**/api/projects/refresh',route=>route.fulfill({status:503,json:{error:'项目同步失败，请检查来源。'.repeat(150)}}));
 if(width===390)await page.getByRole('button',{name:'展开左侧栏',exact:true}).click();const refresh=page.locator('.sidebar .side-section').first().getByRole('button',{name:'刷新',exact:true});await refresh.focus();await refresh.press('Enter');await expect(page.getByRole('alert').filter({hasText:'项目同步失败'})).toBeVisible();if(width===390)await page.getByRole('button',{name:'收起左侧栏',exact:true}).click();
 const messages=page.locator('.app-notification-text');await expect(messages).toHaveCount(2);const stack=await messages.evaluateAll(elements=>elements.map(el=>({top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom,height:el.clientHeight,scroll:el.scrollHeight})));
 for(const message of stack){expect(message.height).toBeGreaterThan(0);expect(message.scroll).toBeGreaterThan(message.height);expect(message.bottom).toBeLessThanOrEqual(width===390?844:900);}expect(stack[1].top).toBeGreaterThan(stack[0].bottom);expect(await layout()).toEqual(before);await screenshot(page,`regression-notice-stack-${width}`);
 await page.getByRole('button',{name:'关闭错误提醒',exact:true}).click();await expect(page.locator('.app-notifications [role=alert]')).toHaveCount(1);
 const close=page.getByRole('button',{name:'关闭会话同步提醒',exact:true});await expect(close).toBeVisible();await close.focus();await close.press('Enter');await expect(page.getByRole('alert').filter({hasText:'最近会话同步失败'})).toHaveCount(0);expect(await layout()).toEqual(before);await expect(composer).toBeFocused();
 expect(state.errors.filter(error=>!error.includes('503'))).toEqual([]);
});

test('settings switches do not change login and chat input padding',async({page})=>{
 const state=await setup(page);await page.goto('/');await expect(page.getByRole('textbox',{name:'任务',exact:true})).toHaveCSS('padding','11px 13px');
 await page.route('**/api/auth/session',route=>route.fulfill({json:{authenticated:false,csrfToken:'test'}}));await page.goto('/');await expect(page.getByLabel('管理员密码',{exact:true})).toHaveCSS('padding','11px 13px');expect(state.errors).toEqual([]);
});

test('mobile drawer Tab cycle includes notification scrolling and dismiss while the drawer stays open',async({page})=>{
 const state=await setup(page);let failed=false;await page.setViewportSize({width:390,height:844});
 await page.route('**/api/sessions?*',route=>route.fulfill(failed?{status:503,json:{error:'同步失败，需要人工检查。'.repeat(150)}}:{json:{data:[],nextCursor:null}}));
 await page.goto('/');await page.getByRole('button',{name:'展开左侧栏',exact:true}).click();const previous=page.getByRole('button',{name:'＋ 新任务',exact:true});await expect(previous).toBeFocused();
 failed=true;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.getByRole('alert').filter({hasText:'最近会话同步失败'})).toBeVisible();
 const text=page.locator('.app-notification-text'),close=page.getByRole('button',{name:'关闭会话同步提醒',exact:true});let textReached=false,closeReached=false;
 for(let index=0;index<20;index++){await page.keyboard.press('Tab');textReached||=await text.evaluate(el=>el===document.activeElement);closeReached||=await close.evaluate(el=>el===document.activeElement);}
 expect.soft(textReached).toBe(true);expect(closeReached).toBe(true);
 for(let index=0;index<20&&!await text.evaluate(el=>el===document.activeElement);index++)await page.keyboard.press('Tab');await expect(text).toBeFocused();await page.keyboard.press('PageDown');await expect.poll(()=>text.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 await page.keyboard.press('Tab');await expect(close).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(text).toBeFocused();await page.keyboard.press('Tab');await page.keyboard.press('Enter');await expect(close).toHaveCount(0);await expect(page.locator('.shell')).toHaveAttribute('data-drawer','left');await expect(previous).toBeFocused();
 await page.getByRole('button',{name:/账户用量/}).click();const dialog=page.getByRole('dialog',{name:'账户用量',exact:true});await expect(dialog).toBeVisible();await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('dialog'))).toBe(true);await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(page.locator('.shell')).toHaveAttribute('data-drawer','left');
 await screenshot(page,'regression-notice-drawer-keyboard-390');expect(state.posts).toEqual([]);expect(state.errors.filter(error=>!error.includes('503'))).toEqual([]);
});

test('password failure stays visible beside the form and preserves runtime errors',async({page})=>{
 const state=await setup(page),posts:any[]=[];
 await page.route('**/api/models?refresh=true',route=>route.fulfill({status:503,json:{error:'模型目录暂不可用'}}));
 await page.route('**/api/auth/password',route=>{posts.push(route.request().postDataJSON());return route.fulfill({status:400,json:{error:'当前密码不正确'}});});
 await page.setViewportSize({width:390,height:844});await page.goto('/settings?section=web');
 await page.getByRole('button',{name:'刷新模型列表',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'模型目录暂不可用'})).toBeVisible();
 await page.getByLabel('当前密码',{exact:true}).fill('incorrect-fixture-password');await page.getByLabel('新密码',{exact:true}).fill('new-fixture-password');await page.getByRole('button',{name:'修改密码并退出',exact:true}).click();
 const alert=page.locator('.settings-password').getByRole('alert');await expect(alert).toContainText('当前密码不正确');await expect(alert).toBeInViewport();await expect(page.getByRole('alert').filter({hasText:'模型目录暂不可用'})).toHaveCount(1);
 expect(posts).toEqual([{currentPassword:'incorrect-fixture-password',newPassword:'new-fixture-password'}]);await expect(page.getByLabel('当前密码',{exact:true})).toHaveValue('incorrect-fixture-password');await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
 await screenshot(page,'password-error');expect(state.errors.filter(error=>!/^Failed to load resource: the server responded with a status of (400|503)\b/.test(error))).toEqual([]);
});

test('settings cards use independent scroll, preserve navigation and fit both viewports',async({page})=>{
 const state=await setup(page);
 for(const width of [1440,768,390]){
  await page.setViewportSize({width,height:width===390?844:900});
  for(const section of ['general','configuration','personalization','usage','plugins','web']){
   await page.goto('/settings?section='+section);await expect(page.locator('.settings-card,.usage-group').first()).toBeVisible();
   await expect(page.locator('.settings-section-title')).toBeVisible();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   expect(await page.locator('.workspace-content').evaluate(el=>el.scrollHeight<=el.clientHeight)).toBe(true);
   await screenshot(page,section+'-'+width);
   if(section==='configuration'&&width===1440)await page.locator('.settings-content').screenshot({path:'.local/settings-ux/configuration-content-1440.png'});
   if(section==='web'||section==='plugins'){
    const nav=page.locator(width>680?'.settings-navigation':'.settings-mobile-navigation'),before=(await nav.boundingBox())!.y;
    await page.locator('.settings-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;});
    expect((await nav.boundingBox())!.y).toBe(before);await screenshot(page,section+'-bottom-'+width);
   }
  }
 }
 expect(state.errors).toEqual([]);
});

test('speed uses native tiers and memory uses defaults, one draft owner and unknown-write guard',async({page})=>{
 const state=await setup(page);await page.goto('/settings?section=general');
 const speed=page.getByLabel('速度',{exact:true});await expect(speed).toHaveValue('default');await expect(speed.getByRole('option',{name:'快速',exact:true})).toHaveAttribute('value','priority');await expect(speed.getByRole('option',{name:'Research',exact:true})).toHaveAttribute('value','research');
 await speed.selectOption('priority');await page.getByRole('button',{name:'保存配置',exact:true}).click();expect(state.posts[0].values).toEqual({service_tier:'priority'});
 const shortcut=page.getByLabel('桌面发送快捷键',{exact:true});await shortcut.selectOption('mod-enter');expect(await page.evaluate(()=>localStorage.getItem('codex-web:send-shortcut:v1'))).toBe('mod-enter');
 await page.goto('/settings?section=personalization');const memory=page.getByRole('switch',{name:'启用 Codex 记忆',exact:true});await expect(memory).not.toBeChecked();await expect(page.getByText('默认关闭',{exact:false}).first()).toBeVisible();await memory.check();
 await page.getByRole('link',{name:'编辑指令',exact:true}).click();const dialog=page.getByRole('dialog',{name:'有未保存的更改'});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(memory).toBeChecked();
 await page.getByRole('button',{name:'保存配置',exact:true}).click();expect(state.posts[1].values).toEqual({memoriesEnabled:true});
 await page.getByText('记忆高级设置',{exact:true}).click();await expect(page.getByRole('switch',{name:'生成记忆',exact:true})).toBeChecked();await page.getByRole('switch',{name:'允许从工具聊天生成记忆',exact:true}).uncheck();state.fail();await page.getByRole('button',{name:'保存配置',exact:true}).click();await expect(page.getByRole('button',{name:'先读回核对',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'保存配置',exact:true})).toBeDisabled();expect(state.posts[2].values).toEqual({allowExternalMemory:false});await screenshot(page,'memory-unknown-write');expect(state.errors).toEqual([]);
});

test('instruction diff uses line numbers and a shared split scroller, with guarded return and mobile unified',async({page})=>{
 const state=await setup(page);await page.goto('/settings?section=personalization&view=instructions');await page.getByLabel('指令原始文本',{exact:true}).fill('same\nnew line\nlast');
 const diff=page.locator('.instructions-diff .diff-view');await expect(diff.locator('.deletion')).toContainText('old line');await expect(diff.locator('.addition')).toContainText('new line');await expect(diff.locator('.split-cell .line-number').filter({hasText:'2'}).first()).toBeVisible();
 expect(await diff.locator('.split-cell').first().evaluate(el=>getComputedStyle(el).overflowX)).toBe('visible');await diff.scrollIntoViewIfNeeded();await screenshot(page,'instructions-dirty-split');await page.locator('.instructions-comparison').screenshot({path:'.local/settings-ux/instructions-diff-content-split.png'});await page.getByLabel('指令原始文本',{exact:true}).fill('same\nnew line '+ 'very-long-word'.repeat(80)+'\nlast');const bounds=await diff.locator('.addition .split-cell').nth(1).evaluate(el=>({cell:el.getBoundingClientRect().right,code:el.querySelector('code')!.getBoundingClientRect().right}));expect(bounds.code).toBeLessThanOrEqual(bounds.cell);await diff.scrollIntoViewIfNeeded();await screenshot(page,'instructions-longline-split');
 await page.getByRole('link',{name:'返回个性化',exact:true}).click();await expect(page.getByRole('dialog',{name:'有未保存的更改'})).toBeVisible();await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByLabel('指令原始文本',{exact:true})).toHaveValue('same\nnew line '+ 'very-long-word'.repeat(80)+'\nlast');
 await page.setViewportSize({width:768,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await diff.scrollIntoViewIfNeeded();await screenshot(page,'instructions-dirty-768');await page.setViewportSize({width:390,height:844});await diff.scrollIntoViewIfNeeded();await screenshot(page,'instructions-longline-unified');await page.getByLabel('指令原始文本',{exact:true}).fill('same\nnew line\nlast');await page.setViewportSize({width:390,height:844});await expect(diff.locator('.unified-cell').first()).toBeVisible();await expect(diff.locator('.split-cell').first()).not.toBeVisible();await diff.scrollIntoViewIfNeeded();await screenshot(page,'instructions-dirty-unified');await page.locator('.instructions-comparison').screenshot({path:'.local/settings-ux/instructions-diff-content-unified.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(state.errors).toEqual([]);
});

test('balance is shared with quick usage, keeps zero/unknown/unlimited and never borrows another bucket',async({page})=>{
 const state=await setup(page);await page.goto('/settings?section=usage');const card=page.locator('.settings-section .usage-balance');await expect(card).toContainText('62,500');await page.getByRole('button',{name:/账户用量/}).click();await expect(page.getByRole('dialog',{name:'账户用量',exact:true}).locator('.usage-balance')).toContainText('62,500');await page.getByRole('button',{name:'关闭账户用量'}).click();
 for(const [credits,text]of [[{hasCredits:true,unlimited:false,balance:'0'},'0'],[{hasCredits:null,unlimited:null,balance:null},'暂不可用'],[{hasCredits:true,unlimited:true,balance:null},'无限'] ]as const){state.usage({rateLimitsByLimitId:{codex:{credits},spark:{credits:{hasCredits:true,unlimited:false,balance:'888'}}}});await page.locator('.settings-section').getByRole('button',{name:'刷新',exact:true}).click();await expect(card).toContainText(text);await expect(card).not.toContainText('888');await expect(card).not.toContainText('62,500');}
 expect(state.posts).toEqual([]);expect(state.errors).toEqual([]);
});

test('Web sorting persists and refreshes sidebar immediately, metadata defaults closed and readonly is near its row',async({page})=>{
 const state=await setup(page);await page.goto('/settings?section=web');await page.getByLabel('会话列表排序',{exact:true}).selectOption('created_at');expect(await page.evaluate(()=>localStorage.getItem('codex-web:session-sort:v1'))).toBe('created_at');await expect(page.locator('.recent-row').first()).toContainText('较晚创建');await page.reload();await expect(page.getByLabel('会话列表排序',{exact:true})).toHaveValue('created_at');
 state.fields.web_search={...state.fields.web_search,writable:false,reason:'管理员限制'};await page.goto('/settings?section=configuration');await expect(page.getByLabel('搜索模式',{exact:true})).toBeDisabled();await expect(page.locator('[data-setting=web_search]')).toContainText('管理员限制');await expect(page.getByText('C:/test/.codex/config.toml',{exact:false})).not.toBeVisible();await screenshot(page,'configuration-readonly');expect(state.errors).toEqual([]);
});

test('memory readonly and unknown remain distinct from known official defaults',async({page})=>{
 const state=await setup(page);state.fields.memoriesEnabled={...state.fields.memoriesEnabled,defaultValue:null,writable:false,reason:'由管理员控制'};await page.goto('/settings?section=personalization');await expect(page.getByRole('switch',{name:'启用 Codex 记忆',exact:true})).toBeDisabled();await expect(page.locator('[data-setting=memoriesEnabled]')).toContainText('未设置／未知');await expect(page.locator('[data-setting=memoriesEnabled]')).toContainText('由管理员控制');await screenshot(page,'memory-readonly-unknown');expect(state.posts).toEqual([]);expect(state.errors).toEqual([]);
});
