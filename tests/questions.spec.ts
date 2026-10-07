import {test,expect} from '@playwright/test';
import {tmpdir} from 'node:os';
test('native async questions offer choices and custom answers, submit once and restore accepted state',async({page})=>{
  const posted:any[]=[];let answered=false;
  await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};else if(path==='/api/sessions')data={data:[],nextCursor:null};
    else if(path==='/api/models')data={data:[]};else if(path==='/api/permission-modes')data={modes:[]};
    else if(path==='/api/sessions/input')data={thread:{id:'input',turns:[{id:'t',status:'completed',items:[{id:'q',type:'agentMessage',delivery:'async',text:'Continue?\n- Yes\n- No',questions:[{title:'Continue?',options:['Yes','No']}]}]}]},phase:'IDLE',pending:[],inputAnswers:answered?{'t:q':{status:'accepted'}}:{}};
    else if(path.endsWith('/answer')){posted.push(route.request().postDataJSON());answered=true;data={status:'accepted'};}
    await route.fulfill({json:data});
  });
  await page.setViewportSize({width:390,height:844});await page.goto('/sessions/input');
  const form=page.getByRole('form',{name:'回答 Codex 提问'});
  await expect(form).toBeVisible();await form.getByRole('radio',{name:'Yes',exact:true}).check();expect(posted).toHaveLength(0);
  await form.getByLabel('其他回答').fill('Wait a minute');await form.getByRole('button',{name:'发送回答'}).click();
  await expect(form).toContainText('回答已发送');expect(posted).toHaveLength(1);expect(posted[0].answers).toEqual(['Wait a minute']);
  await page.reload();await expect(form).toContainText('回答已发送');expect(posted).toHaveLength(1);
});

for(const entry of ['/', '/sessions/model-refresh'])test(`model menu refresh preserves settings and layout on ${entry}`,async({page})=>{
  let refreshes=0,running=false;
  let finishRefresh=()=>{};const firstRefresh=new Promise<void>(resolve=>{finishRefresh=resolve;});
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install();
  await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};else if(path==='/api/sessions')data={data:[],nextCursor:null};
    else if(path==='/api/permission-modes')data={current:'auto-review',modes:[{id:'auto-review',available:true}]};
    else if(path==='/api/sessions/model-refresh')data={thread:{id:'model-refresh',name:'模型设置回归',turns:[]},phase:running?'RUNNING':'IDLE',model:'old',reasoningEffort:'high',permissions:{sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request',approvalsReviewer:'auto_review'},pending:[]};
    else if(path==='/api/models'){
      if(url.searchParams.has('refresh'))refreshes++;
      if(refreshes===1&&url.searchParams.has('refresh'))await firstRefresh;
      if(refreshes===2&&url.searchParams.has('refresh'))return route.fulfill({status:503,json:{error:'offline'}});
      data={data:(refreshes?['old','new']:['old']).map(id=>({id,model:id,displayName:id==='old'?'GPT-6-Astra':id,supportedReasoningEfforts:['high']}))};
    }
    await route.fulfill({json:data});
  });
  await page.goto(entry);const picker=page.getByRole('combobox',{name:'模型',exact:true}),effort=page.getByRole('combobox',{name:'推理强度'}),notice=page.locator('.model-notice');
  await picker.selectOption('old');await effort.selectOption('high');
  await expect(page.getByRole('button',{name:'刷新模型列表',exact:true})).toHaveCount(0);
  for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:900});
    const bottoms=await page.locator('.turn-options select,.permission-picker>button').evaluateAll(items=>items.map(item=>item.getBoundingClientRect().bottom));
    expect(Math.max(...bottoms)-Math.min(...bottoms)).toBeLessThan(2);
    for(const select of [picker,effort])expect((await select.boundingBox())!.width).toBeGreaterThan(80);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`${tmpdir()}/codex-model-menu-${entry==='/'?'home':'session'}-${width}.png`});
  }
  await page.setViewportSize({width:390,height:844});
  const height=await page.locator('.turn-options').evaluate(el=>el.getBoundingClientRect().height);
  await picker.focus();await picker.selectOption({label:'刷新模型列表'});
  try{await expect(picker).toHaveAttribute('aria-busy','true');await expect(picker).toBeFocused();await expect(picker.locator('[data-action="refresh"]')).toHaveJSProperty('disabled',true);}finally{finishRefresh();}
  await expect(picker.locator('option[value="new"]')).toHaveCount(1);await expect(picker).toHaveValue('old');await expect(effort).toHaveValue('high');await expect(picker).toBeFocused();
  await expect(notice).toContainText('已从 Codex');expect(await page.locator('.turn-options').evaluate(el=>el.getBoundingClientRect().height)).toBe(height);
  await page.clock.fastForward(5000);await expect(notice).toHaveCount(0);
  await picker.selectOption({label:'刷新模型列表'});await expect(notice).toContainText('保留原列表');await expect(picker.locator('option[value="new"]')).toHaveCount(1);await expect(picker).toHaveValue('old');await expect(effort).toHaveValue('high');
  await page.clock.fastForward(5000);await expect(notice).toHaveCount(0);
  if(entry!=='/'){
    await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'收起输入区',exact:true}).click();
    await page.evaluate(()=>window.scrollTo(0,1000));expect(await page.evaluate(()=>window.scrollY)).toBe(0);
    expect(await page.locator('.session-toolbar').evaluate(el=>el.getBoundingClientRect().top)).toBe(0);
    expect(await page.locator('.composer').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
    running=true;await page.reload();await expect(picker.locator('option[value="old"]')).toHaveJSProperty('disabled',true);await expect(effort).toBeDisabled();
    const selected=await picker.inputValue();await picker.selectOption({label:'刷新模型列表'});await expect(notice).toContainText('已从 Codex');await expect(picker).toHaveValue(selected);
  }
  expect(errors).toEqual([]);
});
