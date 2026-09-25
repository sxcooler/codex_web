import {test,expect} from '@playwright/test';

test('home reuses confirmed native session options across reload without resuming history',async({page})=>{
  const models=['model-a','model-b'].map(model=>({id:model,model,displayName:model,isDefault:model==='model-a',supportedReasoningEfforts:['low','high'],defaultReasoningEffort:'low'}));
  let snapshot:any={thread:{id:'old',name:'已有会话',cwd:'C:/project',model:'model-b',reasoningEffort:'high',turns:[]},phase:'IDLE',permissions:{approvalPolicy:'on-request',approvalsReviewer:'auto_review',sandbox:{type:'workspaceWrite',writableRoots:['C:/project'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}},pending:[]};
  const opened:string[]=[],created:any[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[{id:'p',name:'项目',path:'C:/project'}]};
    else if(path==='/api/models')data={data:models};
    else if(path==='/api/permission-modes')data={model:'model-a',effort:url.searchParams.has('projectId')?'high':'low',current:'ask',modes:['ask','auto-review','full-access','custom'].map(id=>({id,available:true}))};
    else if(path==='/api/sessions'&&route.request().method()==='GET')data={data:[{id:'old',name:'已有会话'}],nextCursor:null};
    else if(path==='/api/sessions'){created.push(route.request().postDataJSON());data={threadId:'new'};}
    else if(path.endsWith('/open'))opened.push(path);
    else if(path==='/api/sessions/old'||path==='/api/sessions/new')data=snapshot;
    else if(path.endsWith('/release-on-leave'))data={status:'released',handoffReady:true};
    await route.fulfill({json:data});
  });
  const model=page.getByRole('combobox',{name:'模型',exact:true}),effort=page.getByRole('combobox',{name:'推理强度'});
  await page.goto('/');
  await expect(page).toHaveTitle('Codex Web');
  await expect(model.locator('option:checked')).toHaveText('model-a（配置）');
  await expect(effort.locator('option:checked')).toHaveText('low（配置）');
  await page.locator('.creation-fields').getByRole('combobox',{name:'项目',exact:true}).selectOption('p');
  await expect(effort.locator('option:checked')).toHaveText('high（配置）');
  expect(opened).toEqual([]);
  await page.getByRole('button',{name:'已有会话',exact:true}).click();
  await expect(page).toHaveTitle('已有会话 - Codex Web');
  for(const last of ['👨‍👩‍👧‍👦','e\u0301']){
    const prefix='一二三四五六七八九十甲'+last;
    for(const tail of ['','后续内容']){
      snapshot={...snapshot,thread:{...snapshot.thread,name:prefix+tail}};
      await page.getByRole('button',{name:'操作',exact:true}).click();
      await page.getByRole('button',{name:'刷新当前会话'}).click();
      await expect(page).toHaveTitle(prefix+tail+' - Codex Web');
    }
  }
  await expect(model.locator('option:checked')).toHaveText('model-b（当前）');
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('codex-web:turn-settings:v1')??'{}'))).toEqual({model:'model-b',effort:'high',permissionMode:'auto-review'});
  // An unsent override must not become the next task's preference.
  await model.selectOption('model-a');
  await page.getByRole('button',{name:'＋ 新任务',exact:true}).click();
  await expect(page).toHaveTitle('Codex Web');
  await expect(model).toHaveValue('model-b');await expect(effort).toHaveValue('high');
  await expect(page.getByRole('button',{name:/审批方式：帮我批准/})).toBeVisible();
  await page.reload();await expect(model).toHaveValue('model-b');await expect(effort).toHaveValue('high');
  expect(opened).toEqual(Array(5).fill('/api/sessions/old/open'));
  await page.screenshot({path:'output/playwright/home-options-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'output/playwright/home-options-mobile.png',fullPage:true});
  await page.getByRole('textbox',{name:'任务',exact:true}).fill('沿用最近选项');
  await page.getByRole('button',{name:'开始任务 →'}).click();
  await expect.poll(()=>created.length).toBe(1);
  expect(created[0]).toMatchObject({model:'model-b',effort:'high',permissionMode:'auto-review'});
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('button',{name:'＋ 新任务',exact:true}).click();
  await expect(model).toHaveValue('model-b');
  // A custom policy must clear the previous preset, never copy its roots/network.
  snapshot={...snapshot,thread:{...snapshot.thread,model:'model-a',reasoningEffort:null},permissions:{...snapshot.permissions,sandbox:{...snapshot.permissions.sandbox,writableRoots:['C:/project','C:/private'],networkAccess:true}}};
  await page.getByRole('button',{name:'已有会话',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('codex-web:turn-settings:v1')??'{}'))).toEqual({model:'model-a'});
  await page.getByRole('button',{name:'＋ 新任务',exact:true}).click();
  await expect(model).toHaveValue('model-a');
  snapshot={...snapshot,phase:'EXTERNAL',thread:{...snapshot.thread,model:'model-b',reasoningEffort:'high'}};
  await page.goto('/sessions/old');await expect(model.locator('option:checked')).toHaveText('model-b（当前）');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('codex-web:turn-settings:v1')!))).toEqual({model:'model-a'});
  await page.evaluate(()=>localStorage.setItem('codex-web:turn-settings:v1','{broken'));
  await page.goto('/');await expect(model.locator('option:checked')).toHaveText('model-a（配置）');
  await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{get(){throw new Error('storage blocked');}});});
  await page.reload();await expect(model.locator('option:checked')).toHaveText('model-a（配置）');
  expect(errors).toEqual([]);
});

test('existing session option display keeps current values and unknown states',async({page})=>{
  await page.goto('/tests/turn-options.html');
  await expect(page.locator('#result')).toContainText('PASS:');
});
