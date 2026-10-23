import {test,expect,type Page} from '@playwright/test';

function report(active=false){return {checkedAt:'2026-10-22T06:00:00Z',complete:true,sessions:active?[{threadId:'demo-active',turnId:'demo-turn',name:'Demo navigation task',projectName:'Demo project',category:'session',kind:'running'},{threadId:'demo-child',turnId:'child-turn',name:'Demo review',parentThreadId:'demo-active',category:'subagent',kind:'approval'}]:[],blockers:[],issues:[],canRestart:!active,canForce:active,version:(active?'b':'a').repeat(64)};}
async function setup(page:Page,{locale='zh-CN',width=1440,active=false}={}){
 let inspection:any=report(active),changed:any;const writes:any[]=[],errors:string[]=[];let reads=0;
 await page.addInitScript(value=>localStorage.setItem('codex-web:locale:v1',value),locale);
 await page.setViewportSize({width,height:900});page.on('pageerror',error=>errors.push(error.message));
 page.on('dialog',async dialog=>{errors.push('Unexpected native confirmation');await dialog.dismiss();});
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;let data:any={};
  if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
  else if(path==='/api/projects')data={projects:[]};else if(path==='/api/sessions')data={data:[],nextCursor:null};
  else if(path==='/api/settings')data={appVersion:'demo',nodeVersion:'demo',runtime:{},webRestart:{available:true,status:'idle'}};
  else if(path==='/api/runtime/restart-check'){reads++;data=inspection;}
  else if((path==='/api/models/reload'||path==='/api/server/restart')&&request.method()==='POST'){
   writes.push({path,body:request.postDataJSON()});
   if(changed){inspection=changed;changed=undefined;return route.fulfill({status:409,json:{error:'Activity changed',code:'RUNTIME_RESTART_CHANGED',inspection}});}
   data=path==='/api/models/reload'?{data:[]}:{available:true,status:'scheduled',scheduledAt:new Date(Date.now()+90_000).toISOString()};
  }else if(path==='/api/server/restart')data={available:true,status:'idle'};
  await route.fulfill({json:data});
 });
 await page.goto('/settings?section=web');
 return {writes,errors,reads:()=>reads,set:(value:any)=>{inspection=value;},changeAtConfirmation:(value:any)=>{changed=value;}};
}

for(const width of [360,390,1280,1440])for(const locale of ['zh-CN','en'])test(`one dialog directly confirms a green idle restart ${locale} ${width}`,async({page},info)=>{
 const fixture=await setup(page,{width,locale}),en=locale==='en';
 for(const [name,path] of [[en?'Restart Codex':'重启Codex','/api/models/reload'],[en?'Restart Web service':'重启 Web 服务','/api/server/restart']]){
  const opener=page.getByRole('button',{name,exact:true});await opener.click();const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('button',{name:en?'Cancel':'取消',exact:true})).toBeFocused();
  const execute=dialog.getByRole('button',{name:en?'Restart':'重启',exact:true});
  await expect(execute).toBeEnabled();await expect(execute).toHaveClass(/primary/);
  await expect(dialog).toContainText(en?'No active sessions':'没有活动会话');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.mouse.move(0,0);await expect(execute).toHaveCSS('background-color','rgb(130, 217, 180)');
  await dialog.screenshot({path:info.outputPath(path.includes('models')?'idle-codex.png':'idle-web.png')});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(opener).toBeFocused();
  const before=fixture.writes.length;await opener.click();await execute.click();await expect(dialog).not.toBeVisible();
  expect(fixture.writes).toHaveLength(before+1);
  expect(fixture.writes.at(-1)).toEqual({path,body:{...(path.includes('server')?{confirmed:true}:{}),mode:'normal',version:'a'.repeat(64)}});
 }
 expect(fixture.errors).toEqual([]);
});

for(const width of [390,1440])for(const locale of ['zh-CN','en'])test(`active sessions use one warning force button ${locale} ${width}`,async({page},info)=>{
 const fixture=await setup(page,{width,locale,active:true}),en=locale==='en';
 await page.getByRole('button',{name:en?'Restart Codex':'重启Codex',exact:true}).click();const dialog=page.getByRole('dialog');
 await expect(dialog).toContainText('Demo navigation task');await expect(dialog).toContainText('Demo review');
 await expect(dialog).toContainText(en?'Awaiting approval':'待审批');await expect(dialog).toContainText(en?'Subagent':'子任务');
 const execute=dialog.getByRole('button',{name:en?'Force restart':'强制重启',exact:true});
 await expect(execute).toBeEnabled();await expect(execute).toHaveClass(/warning/);await expect(dialog.getByRole('checkbox')).toHaveCount(0);
 await dialog.screenshot({path:info.outputPath('active-force.png')});
 await execute.focus();await page.keyboard.press('Enter');await expect(dialog).not.toBeVisible();
 expect(fixture.writes).toEqual([{path:'/api/models/reload',body:{mode:'force',version:'b'.repeat(64)}}]);expect(fixture.errors).toEqual([]);
});

test('changed activity updates the same dialog and needs a new explicit click',async({page})=>{
 const fixture=await setup(page);await page.getByRole('button',{name:'重启Codex',exact:true}).click();const dialog=page.getByRole('dialog');
 fixture.changeAtConfirmation(report(true));await dialog.getByRole('button',{name:'重启',exact:true}).click();
 await expect(dialog).toContainText('Demo navigation task');await expect(dialog).toContainText('活动会话已变化');
 const force=dialog.getByRole('button',{name:'强制重启',exact:true});await expect(force).toBeEnabled();
 expect(fixture.writes).toHaveLength(1);await expect(page.getByRole('dialog')).toHaveCount(1);
 await force.click();await expect(dialog).not.toBeVisible();expect(fixture.writes).toHaveLength(2);
 expect(fixture.writes.at(-1).body.mode).toBe('force');expect(fixture.errors).toEqual([]);
});

test('incomplete checks retain known sessions and details without authorizing force',async({page},info)=>{
 const fixture=await setup(page,{width:360,active:true});fixture.set({...report(true),complete:false,canForce:false,issues:[{threadId:'unverified',stage:'thread/read',message:'Demo status read failed: <script>never run</script> '+ 'long diagnostic '.repeat(20)}]});
 await page.getByRole('button',{name:'重启Codex',exact:true}).click();const dialog=page.getByRole('dialog');
 await expect(dialog).toContainText('Demo navigation task');await expect(dialog.getByRole('alert')).toContainText('状态未确认');
 await expect(dialog.locator('.restart-execute')).toBeDisabled();
 const details=dialog.locator('details');await details.locator('summary').focus();await page.keyboard.press('Space');
 await expect(details).toContainText('Demo status read failed');await expect(dialog.locator('script')).toHaveCount(0);
 await dialog.screenshot({path:info.outputPath('partial-details.png')});
 fixture.set(report());await dialog.getByRole('button',{name:'重新检查',exact:true}).click();await expect(dialog.getByRole('button',{name:'重启',exact:true})).toBeEnabled();
 expect(fixture.writes).toHaveLength(0);expect(fixture.errors).toEqual([]);
});

test('long session lists scroll inside the dialog while actions stay visible',async({page},info)=>{
 const fixture=await setup(page,{width:360,locale:'en',active:true}),active=report(true);
 fixture.set({...active,sessions:Array.from({length:24},(_,i)=>({...active.sessions[0],threadId:'demo-'+i,name:'Demo task with a long descriptive title '+i+' details '.repeat(8)}))});
 await page.getByRole('button',{name:'Restart Web service',exact:true}).click();const dialog=page.getByRole('dialog');
 const execute=dialog.getByRole('button',{name:'Force restart',exact:true});await expect(execute).toBeVisible();
 expect(await dialog.evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight)).toBe(true);
 const body=dialog.locator('.restart-dialog-body');expect(await body.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
 await body.evaluate(el=>el.scrollTop=el.scrollHeight);await expect(execute).toBeVisible();
 await dialog.screenshot({path:info.outputPath('long-list-mobile.png')});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(fixture.writes).toHaveLength(0);expect(fixture.errors).toEqual([]);
});
