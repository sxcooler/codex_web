import {test,expect} from '@playwright/test';
for(const [status,code] of [[400,'REQUEST_VALIDATION_FAILED'],[401,'AUTH_REQUIRED'],[403,'REQUEST_FORBIDDEN']] as const)test(`coded ${status} fork rejection permits only explicit retry across languages`,async({page})=>{
 const posts:any[]=[];
 await page.route('**/api/**',async route=>{posts.push(route.request().postDataJSON());await route.fulfill({status,json:{error:'Original rejected request',code}});});
 await page.goto('/tests/i18n-fork.html');await page.getByRole('button',{name:'分支到新聊天',exact:true}).click();
 await expect(page.getByRole('button',{name:'重试分支',exact:true})).toBeEnabled();expect(posts).toHaveLength(1);
 await page.getByRole('combobox',{name:'界面语言',exact:true}).selectOption('en');await expect(page.getByRole('button',{name:'Retry fork',exact:true})).toBeEnabled();expect(posts).toHaveLength(1);
 await page.getByRole('button',{name:'Retry fork',exact:true}).click();await expect.poll(()=>posts.length).toBe(2);expect(posts[1].clientRequestId).not.toBe(posts[0].clientRequestId);
});
