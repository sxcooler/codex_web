import {test,expect} from '@playwright/test';
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

test('manual model refresh keeps selection and retains the catalog on failure',async({page})=>{
  let refreshes=0;
  await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};else if(path==='/api/sessions')data={data:[],nextCursor:null};
    else if(path==='/api/permission-modes')data={modes:[]};
    else if(path==='/api/models'){
      if(url.searchParams.has('refresh'))refreshes++;
      if(refreshes===2)return route.fulfill({status:503,json:{error:'offline'}});
      data={data:(refreshes?['old','new']:['old']).map(id=>({id,model:id,displayName:id,supportedReasoningEfforts:['high']}))};
    }
    await route.fulfill({json:data});
  });
  await page.goto('/');const picker=page.getByRole('combobox',{name:'模型',exact:true});await picker.selectOption('old');
  await page.getByRole('button',{name:'刷新模型列表',exact:true}).click();await expect(picker.locator('option[value="new"]')).toHaveCount(1);await expect(picker).toHaveValue('old');
  await page.getByRole('button',{name:'刷新模型列表',exact:true}).click();await expect(page.getByRole('status')).toContainText('保留原列表');await expect(picker.locator('option[value="new"]')).toHaveCount(1);await expect(picker).toHaveValue('old');
});
