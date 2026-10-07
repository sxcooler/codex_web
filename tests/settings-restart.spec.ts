import { test, expect, type Page } from '@playwright/test';

async function setup(page:Page, scenario='idle'){
  const calls:string[]=[],errors:string[]=[];
  let restart:any={available:true,status:'idle'};
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',async dialog=>{errors.push('Unexpected browser dialog');await dialog.dismiss();});
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};
    else if(path==='/api/sessions')data={data:[],nextCursor:null};
    else if(path==='/api/settings')data={origin:'http://localhost',nodeVersion:'test',runtime:{},...(scenario==='legacy'?{}:{webRestart:restart})};
    else if(path==='/api/runtime/restart-check'){
      if(scenario==='busy')return route.fulfill({status:409,json:{error:'本机 Codex App Server 仍有活动任务'}});
      data={idle:true};
    }
    else if(path==='/api/models/reload'){calls.push(path);data={data:[]};}
    else if(path==='/api/server/restart'){
      if(scenario==='legacy')return route.fulfill({status:404,json:{error:'Not found'}});
      if(route.request().method()==='POST'){calls.push(path);expect(route.request().postDataJSON()).toEqual({confirmed:true});restart={available:true,status:'scheduled',scheduledAt:new Date(Date.now()+90_000).toISOString()};}
      data=restart;
    }
    await route.fulfill({json:data});
  });
  return {calls,errors};
}

for(const width of [390,1440])test(`settings uses an in-page confirmation and checks native activity at ${width}px`,async({page})=>{
  const {calls,errors}=await setup(page);
  await page.setViewportSize({width,height:900});await page.goto('/settings?section=web');
  await expect(page.getByRole('heading',{name:'设置',exact:true})).toBeVisible();
  await expect(page.getByText(/仅在本机 Codex App Server/)).not.toBeVisible();
  for(const name of ['重启Codex','重启 Web 服务']){
    const button=page.getByRole('button',{name,exact:true}),before=calls.length;
    await button.click();
    const dialog=page.getByRole('dialog',{name:name+'？'});
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('本机 Codex App Server');
    await expect(dialog).not.toContainText('其他设备');
    await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeFocused();
    await expect(dialog.getByRole('button',{name:'确认重启',exact:true})).toBeEnabled();
    await page.screenshot({path:`.local/web/restart-dialog-${name==='重启Codex'?'codex':'web'}-${width}.png`});
    await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(button).toBeFocused();
    expect(calls).toHaveLength(before);
    await button.click();await dialog.getByRole('button',{name:'取消',exact:true}).click();expect(calls).toHaveLength(before);
    await button.click();await dialog.getByRole('button',{name:'确认重启',exact:true}).click();
    await expect.poll(()=>calls.length).toBe(before+1);await expect(dialog).not.toBeVisible();
    if(name==='重启Codex')await expect(button).toBeEnabled();
  }
  await expect(page.getByRole('status').filter({hasText:'已安排'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(calls).toEqual(['/api/models/reload','/api/server/restart']);expect(errors).toEqual([]);
});

for(const scenario of ['legacy','busy'])test(`restart explains ${scenario} only after opening its dialog`,async({page})=>{
  const {calls,errors}=await setup(page,scenario);await page.goto('/settings?section=web');
  const button=page.getByRole('button',{name:'重启 Web 服务',exact:true});await expect(button).toBeEnabled();
  await expect(page.getByText(/当前后端尚不支持|仍有活动任务/)).not.toBeVisible();
  await button.click();const dialog=page.getByRole('dialog',{name:'重启 Web 服务？'});
  await expect(dialog.getByRole('alert')).toContainText(scenario==='legacy'?'后端尚未加载重启接口':'仍有活动任务');
  await expect(dialog.getByRole('button',{name:'确认重启',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  expect(calls).toEqual([]);expect(errors).toEqual([]);
});
