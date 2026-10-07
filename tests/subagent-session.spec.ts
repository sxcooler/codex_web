import {test,expect} from '@playwright/test';

test('old subagent notification links show an explanation without opening a conversation',async({page})=>{
  const requests:string[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;requests.push(path);let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[]};
    else if(path==='/api/sessions')data={data:[{id:'parent',name:'主会话'}],nextCursor:null};
    else if(path==='/api/sessions/child/open')return route.fulfill({status:404,json:{code:'RUNTIME_SUBAGENT_THREAD',error:'子 Agent 会话不单独展示，请返回主会话。'}});
    await route.fulfill({json:data});
  });
  await page.goto('/sessions/child');
  await expect(page.getByRole('heading',{name:'子 Agent 会话不单独展示'})).toBeVisible();
  await expect(page).toHaveTitle('子 Agent 会话不单独展示 - Codex Web');
  await expect(page.locator('#message')).toHaveCount(0);
  await expect(page.getByRole('link',{name:'返回首页'})).toHaveAttribute('href','/');
  expect(requests.filter(path=>path==='/api/sessions/child'||path.endsWith('/events'))).toEqual([]);
  await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('heading',{name:'子 Agent 会话不单独展示'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
