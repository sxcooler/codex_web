import {test,expect} from '@playwright/test';

test('recent sessions are links and new task settings merge with native defaults',async({page})=>{
  const models=['model-a','model-b'].map(model=>({id:model,model,displayName:model,isDefault:model==='model-a',supportedReasoningEfforts:['low','high'].map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'low'}));
  const writes:any[]=[],created:any[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};
    else if(path==='/api/models')data={data:models};
    else if(path==='/api/permission-modes')data={model:'model-a',effort:'high',current:'ask',modes:[{id:'ask',available:true}],userVersion:'user-v1'};
    else if(path==='/api/model-defaults'){writes.push(route.request().postDataJSON());data={model:writes.at(-1).model,effort:writes.at(-1).effort,effectiveModel:'model-a',effectiveEffort:writes.at(-1).effort};}
    else if(path==='/api/sessions'&&route.request().method()==='GET')data={data:[{id:'old',name:'已有会话'}],nextCursor:null};
    else if(path==='/api/sessions'){created.push(route.request().postDataJSON());data={threadId:'new',status:'started'};}
    else if(path==='/api/sessions/old')data={thread:{id:'old',name:'已有会话',turns:[]},phase:'IDLE',model:'model-a',reasoningEffort:'high',permissions:{sandbox:{type:'readOnly'},approvalPolicy:'on-request',approvalsReviewer:'user'},pending:[]};
    else if(path==='/api/sessions/new')data={thread:{id:'new',name:'新会话',turns:[{id:'turn',items:[{id:'user',type:'userMessage',clientId:created[0]?.clientRequestId,content:[{type:'text',text:'开始'}]}]}]},phase:'IDLE',pending:[]};
    else if(path.endsWith('/release-on-leave'))data={status:'released',handoffReady:true};
    await route.fulfill({json:data});
  });
  await page.goto('/');
  const model=page.getByRole('combobox',{name:'模型',exact:true}),effort=page.getByRole('combobox',{name:'推理强度'});
  await expect(model).toHaveValue('model-a');await expect(effort).toHaveValue('high');
  await expect(model.locator('option[value="model-a"]')).toHaveCount(1);
  await expect(effort.locator('option[value="high"]')).toHaveCount(1);
  const link=page.getByRole('link',{name:'已有会话',exact:true});
  await expect(link).toHaveAttribute('href','/sessions/old');
  await link.click();await expect(page).toHaveURL(/\/sessions\/old$/);await expect(link).toHaveAttribute('aria-current','page');
  await model.selectOption('model-b');await expect(effort).toHaveValue('low');
  expect(writes).toHaveLength(0);
  await page.getByRole('button',{name:'＋ 新任务',exact:true}).click();
  await expect(model).toHaveValue('model-a');
  await model.selectOption('model-b');await effort.selectOption('high');
  await page.getByRole('textbox',{name:'任务',exact:true}).fill('开始');
  await page.getByRole('button',{name:'开始任务 →'}).click();
  await expect(page).toHaveURL(/\/sessions\/new$/);
  await expect.poll(()=>writes.length).toBe(1);
  await expect(page.getByRole('status').filter({hasText:'当前项目配置覆盖了模型或推理强度'})).toBeVisible();
  expect(writes[0]).toEqual({model:'model-b',effort:'high',expectedVersion:'user-v1'});
  expect(created[0]).toMatchObject({model:'model-b',effort:'high'});
  await page.getByRole('button',{name:'＋ 新任务',exact:true}).click();
  await expect(model).toHaveValue('model-b');
  await expect(model.locator('option[value="model-b"]')).toHaveText('model-b（上一次）');
  await expect(effort.locator('option[value="high"]')).toHaveText('high（上一次）');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

for(const version of ['user-v1',null])test('created task survives '+(version?'defaults conflict':'missing config version')+' without resubmission',async({page})=>{
 let creates=0,writes=0,reads=0;
 await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;let data:any={};
  if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
  else if(path==='/api/projects')data={projects:[]};
  else if(path==='/api/models')data={data:[{id:'model-a',model:'model-a',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};
  else if(path==='/api/permission-modes'){if(!creates)reads++;data={model:'model-a',effort:'high',current:'ask',modes:[{id:'ask',available:true}],userVersion:creates?'user-v2':version};}
  else if(path==='/api/sessions'&&route.request().method()==='GET')data={data:[],nextCursor:null};
  else if(path==='/api/sessions'){creates++;data={threadId:'new',status:'idle'};}
  else if(path==='/api/model-defaults'){writes++;expect(route.request().postDataJSON().expectedVersion).toBe('user-v1');return route.fulfill({status:409,json:{error:'配置已被其他程序修改',code:'SETTINGS_CONFLICT'}});}
  else if(path==='/api/sessions/new')data={thread:{id:'new',turns:[]},phase:'IDLE',pending:[]};
  await route.fulfill({json:data});
 });
 await page.goto('/');await expect(page.getByRole('combobox',{name:'模型',exact:true})).toHaveValue('model-a');
 await page.getByRole('textbox',{name:'任务',exact:true}).fill('开始');await page.getByRole('button',{name:'开始任务 →'}).click();
 await expect(page).toHaveURL(/\/sessions\/new$/);await expect(page.getByRole('status').filter({hasText:'任务已创建，但'})).toBeVisible();
 expect(creates).toBe(1);expect(writes).toBe(version?1:0);expect(reads).toBe(1);
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('codex-web:turn-settings:v2')??'{}'))).toMatchObject({model:'model-a',effort:'high'});
});

test('confirmed first message remains visible when history temporarily fails and dedupes after recovery',async({page})=>{
  let historyReady=false,requestId='',posts=0;
  await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};
    else if(path==='/api/models')data={data:[{id:'model-a',model:'model-a',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};
    else if(path==='/api/permission-modes')data={model:'model-a',effort:'high',current:'ask',modes:[{id:'ask',available:true}]};
    else if(path==='/api/sessions'&&route.request().method()==='GET')data={data:[],nextCursor:null};
    else if(path==='/api/sessions'){posts++;requestId=route.request().postDataJSON().clientRequestId;data={threadId:'new',status:'started'};}
    else if(path==='/api/sessions/new'){
      if(!historyReady)return route.fulfill({status:503,json:{error:'历史暂不可读'}});
      data={thread:{id:'new',name:'新会话',turns:[{id:'turn',items:[{id:'user',type:'userMessage',clientId:requestId,content:[{type:'text',text:'首条消息'}]}]}]},phase:'IDLE',pending:[]};
    }
    else if(path==='/api/model-defaults')data={model:'model-a',effort:'high',effectiveModel:'model-a',effectiveEffort:'high'};
    await route.fulfill({json:data});
  });
  await page.goto('/');await page.getByRole('textbox',{name:'任务',exact:true}).fill('首条消息');await page.getByRole('button',{name:'开始任务 →'}).click();
  await expect(page.locator('.outgoing-message')).toContainText('首条消息');
  await expect(page.locator('.outgoing-status')).toContainText('已发送，等待历史同步');
  await expect(page.getByRole('alert').filter({hasText:'历史暂不可读'})).toBeVisible();
  await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();
  expect(posts).toBe(1);
  historyReady=true;await page.getByRole('button',{name:'重新同步'}).click();
  await expect(page.locator('.outgoing-message')).toHaveCount(0);
  await expect(page.locator('.message').filter({hasText:'首条消息'})).toHaveCount(1);
  expect(posts).toBe(1);
});
