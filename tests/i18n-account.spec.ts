import {test,expect} from '@playwright/test';

for(const automatic of [false,true])test(`quota result restores focus during a slow follow-up read: ${automatic?'expiry':'close'}`,async({page},info)=>{
 await page.setViewportSize({width:automatic?390:1440,height:900});await page.addInitScript(()=>localStorage.setItem('codex-web:locale:v1','en'));await page.clock.install();await page.goto('/tests/i18n-account.html');
 await page.getByRole('button',{name:'Account usage',exact:false}).click();const dialog=page.locator('dialog.account-usage-dialog').first();
 await dialog.getByRole('button',{name:'Use',exact:true}).click();
 await page.evaluate(()=>{const original=window.fetch;let hold=false;window.fetch=async(input,init)=>{if(String(input).includes('/reset')){const response=await original(input,init);hold=true;return response;}if(hold)await new Promise<void>(resolve=>(window as any).finishUsageRead=resolve);return original(input,init);};});
 await page.locator('.usage-confirm').getByRole('button',{name:'Confirm use of 1 credit',exact:true}).click();
 await expect(dialog).toContainText('Reset successful');await expect(dialog.getByRole('button',{name:'Refreshing…',exact:true})).toBeDisabled();
 const close=dialog.getByRole('button',{name:'Dismiss this notice',exact:true});await close.focus();
 await page.screenshot({path:info.outputPath('quota-feedback.png'),fullPage:true});
 if(automatic)await page.clock.fastForward(5000);else await close.click();
 await expect(dialog).not.toContainText('Reset successful');await expect(dialog.locator('.usage-content .usage-heading p')).toBeFocused();
 expect(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.url.endsWith('/reset')).length)).toBe(1);
 await page.evaluate(()=>(window as any).finishUsageRead());
});

test('completed quota feedback is dismissible while pending resets remain protected',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('codex-web:locale:v1','en'));await page.goto('/tests/i18n-account.html');
 await page.getByRole('button',{name:'Account usage',exact:false}).click();const dialog=page.locator('dialog.account-usage-dialog').first();
 await dialog.getByRole('button',{name:'Use',exact:true}).click();await page.evaluate(()=>(window as any).holdReset=true);
 await page.locator('.usage-confirm').getByRole('button',{name:'Confirm use of 1 credit',exact:true}).click();
 await expect(dialog).toContainText('Using reset credit');await expect(dialog.getByRole('button',{name:'Dismiss this notice',exact:true})).toHaveCount(0);
 const pending=await page.evaluate(()=>localStorage.getItem('codex-web:account-reset:v1:mock-account'));expect(pending).toBeTruthy();
 await page.evaluate(()=>(window as any).finishReset());await expect(dialog).toContainText('Reset successful');
 await dialog.getByRole('button',{name:'Dismiss this notice',exact:true}).click();await expect(dialog).not.toContainText('Reset successful');
 await expect(dialog.getByRole('button',{name:'Refresh',exact:true})).toBeFocused();
 expect(await page.evaluate(()=>localStorage.getItem('codex-web:account-reset:v1:mock-account'))).toBeNull();
 expect(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.url.endsWith('/reset')).length)).toBe(1);
});

test('confirmed quota success expires while the current quota stays visible',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('codex-web:locale:v1','en'));await page.clock.install();await page.goto('/tests/i18n-account.html');
 await page.getByRole('button',{name:'Account usage',exact:false}).click();const dialog=page.locator('dialog.account-usage-dialog').first();
 await dialog.getByRole('button',{name:'Use',exact:true}).click();await page.locator('.usage-confirm').getByRole('button',{name:'Confirm use of 1 credit',exact:true}).click();
 await expect(dialog).toContainText('Reset successful');await dialog.getByRole('button',{name:'Dismiss this notice',exact:true}).focus();await page.clock.fastForward(5000);await expect(dialog).not.toContainText('Reset successful');await expect(dialog.getByRole('button',{name:'Refresh',exact:true})).toBeFocused();
 await expect(dialog).toContainText('5 hours');expect(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.url.endsWith('/reset')).length)).toBe(1);
});
test('account confirmation and exact native values survive a language switch without requests',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('codex-web:locale:v1','en'));await page.goto('/tests/i18n-account.html');await page.getByRole('button',{name:'Account usage',exact:false}).click();const dialog=page.locator('dialog.account-usage-dialog').first();await expect(dialog).toBeVisible();await expect(dialog).toContainText('5 hours');await expect(dialog).toContainText('90,071,992,547,409,931,234,567,890.012');await expect(dialog).toContainText('9007199254740993123');await expect(dialog).toContainText('原始描述 preserve native description');
 await dialog.getByRole('button',{name:'Use',exact:true}).click();await expect(page.locator('.usage-confirm')).toBeVisible();await page.evaluate(()=>{(window as any).requestCount=(window as any).requests.length;(document.querySelector('nav button') as HTMLButtonElement).click();});await expect(page.locator('.usage-confirm')).toContainText('使用重置机会？');await expect(page.locator('.usage-confirm')).toContainText('原始机会标题');expect(await page.evaluate(()=>(window as any).requests.length)).toBe(await page.evaluate(()=>(window as any).requestCount));expect(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.method==='POST').length)).toBe(0);
 await page.locator('.usage-confirm').getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).toContainText('5 小时');await expect(dialog).toContainText('90,071,992,547,409,931,234,567,890.012');
});

test('pending mock reset keeps its identifier and is never resubmitted by switching language',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('codex-web:locale:v1','en'));await page.goto('/tests/i18n-account.html');await page.getByRole('button',{name:'Account usage',exact:false}).click();const dialog=page.locator('dialog.account-usage-dialog').first();await dialog.getByRole('button',{name:'Use',exact:true}).click();await expect(page.locator('.usage-confirm')).toBeVisible();await page.evaluate(()=>(window as any).holdReset=true);await page.locator('.usage-confirm').getByRole('button',{name:'Confirm use of 1 credit',exact:true}).click();await expect(dialog).toContainText('Using reset credit…');
 const operation=await page.evaluate(()=>localStorage.getItem('codex-web:account-reset:v1:mock-account'));expect(operation).toBeTruthy();const payload=JSON.parse(operation!);expect(payload.accountId).toBe('mock-account');expect(payload.creditId).toBe('credit-one');expect(payload.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
 const count=await page.evaluate(()=>(window as any).requests.length);await page.evaluate(()=>(document.querySelector('nav button') as HTMLButtonElement).click());await expect(dialog).toContainText('正在使用重置机会…');expect(await page.evaluate(()=>localStorage.getItem('codex-web:account-reset:v1:mock-account'))).toBe(operation);expect(await page.evaluate(()=>(window as any).requests.length)).toBe(count);const resets=await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.url.endsWith('/reset')));expect(resets).toHaveLength(1);expect(JSON.parse(resets[0].body)).toEqual(payload);
 await page.evaluate(()=>(window as any).finishReset());await expect(dialog).toContainText('重置成功');expect(await page.evaluate(()=>localStorage.getItem('codex-web:account-reset:v1:mock-account'))).toBeNull();const after=await page.evaluate(()=>(window as any).requests.length);await page.evaluate(()=>(document.querySelector('nav button:last-child') as HTMLButtonElement).click());await expect(dialog).toContainText('Reset successful');expect(await page.evaluate(()=>(window as any).requests.length)).toBe(after);expect(await page.evaluate(()=>(window as any).requests.filter((r:any)=>r.url.endsWith('/reset')).length)).toBe(1);
});
