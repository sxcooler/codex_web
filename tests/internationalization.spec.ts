import {test,expect,type Page} from '@playwright/test';
test.use({locale:'en-US'});
async function loginFixture(page:Page){
 const calls:string[]=[];
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;calls.push(route.request().method()+' '+path);
  await route.fulfill({json:path==='/api/auth/session'?{authenticated:false,csrfToken:'fixture'}:{}});
 });return calls;
}
test('browser language initializes before login and switching preserves password without extra requests',async({page},info)=>{
 const calls=await loginFixture(page),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/');
 await expect(page.getByLabel('Administrator password',{exact:true})).toBeVisible();
 await expect(page.locator('html')).toHaveAttribute('lang','en');
 await page.getByLabel('Administrator password',{exact:true}).fill('fixture password');
 const before=[...calls];
 await page.getByRole('combobox',{name:'Interface language',exact:true}).selectOption('zh-CN');
 await expect(page.getByLabel('管理员密码',{exact:true})).toHaveValue('fixture password');
 await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
 expect(calls).toEqual(before);
 await page.screenshot({path:info.outputPath('login-chinese.png')});
 await page.reload();await expect(page.getByLabel('管理员密码',{exact:true})).toBeVisible();
 expect(errors).toEqual([]);
});

test('saved choices synchronize across tabs, clear and browser language changes',async({page,context})=>{
 await loginFixture(page);await page.goto('/');await expect(page.getByLabel('Administrator password',{exact:true})).toBeVisible();
 const other=await context.newPage();await loginFixture(other);await other.goto('/');
 await other.getByRole('combobox',{name:'Interface language',exact:true}).selectOption('zh-CN');
 await expect(page.getByLabel('管理员密码',{exact:true})).toBeVisible();
 await other.evaluate(()=>{localStorage.setItem('unrelated','value');});await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
 await other.evaluate(()=>localStorage.clear());await expect(page.locator('html')).toHaveAttribute('lang','en');
 await page.evaluate(()=>{Object.defineProperty(navigator,'languages',{configurable:true,value:['zh-CN']});window.dispatchEvent(new Event('languagechange'));});
 await expect(page.getByLabel('管理员密码',{exact:true})).toBeVisible();
 await page.getByRole('combobox',{name:'界面语言',exact:true}).selectOption('en');
 await page.evaluate(()=>{Object.defineProperty(navigator,'languages',{configurable:true,value:['zh-CN']});window.dispatchEvent(new Event('languagechange'));});
 await expect(page.locator('html')).toHaveAttribute('lang','en');await other.close();
});

test('failed persistence keeps a temporary choice, ignores sync and retries saving',async({page})=>{
 await loginFixture(page);await page.goto('/');await expect(page.getByLabel('Administrator password',{exact:true})).toBeVisible();
 await page.evaluate(()=>{(window as any).restoreLocaleStorage=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='codex-web:locale:v1')throw new DOMException('blocked','SecurityError');(window as any).restoreLocaleStorage.call(this,key,value);};});
 await page.getByRole('combobox',{name:'Interface language',exact:true}).selectOption('zh-CN');
 await expect(page.getByRole('alert')).toContainText('仅当前标签页有效');
 await page.evaluate(()=>{window.dispatchEvent(new StorageEvent('storage',{key:'codex-web:locale:v1',newValue:'en'}));window.dispatchEvent(new Event('locale-changed'));});
 await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
 await page.evaluate(()=>{Storage.prototype.setItem=(window as any).restoreLocaleStorage;});await page.getByRole('button',{name:'重试保存',exact:true}).click();
 await expect(page.getByRole('alert')).toHaveCount(0);await page.reload();await expect(page.getByLabel('管理员密码',{exact:true})).toBeVisible();
});

async function homeFixture(page:Page){
 const calls:string[]=[];
 await page.addInitScript(()=>{(window as any).streamCount=0;(window as any).EventSource=class extends EventTarget{constructor(){super();(window as any).streamCount++;}close(){}};});
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;calls.push(route.request().method()+' '+path+url.search);
  const values:Record<string,unknown>={
   '/api/auth/session':{authenticated:true,csrfToken:'fixture'},'/api/projects':{projects:[],workRoot:'C:/fixture'},
   '/api/project-catalog':{state:'ready',projects:[],workspaces:[]},'/api/sessions':{pending:true},
   '/api/models':{data:[]},'/api/permission-modes':{modes:[]},'/api/account/usage':{accountId:null,updatedAt:0,rateLimits:null,rateLimitsByLimitId:null,rateLimitResetCredits:null,resetSupported:false},
  };await route.fulfill({json:values[path]??{}});
 });return calls;
}

test('Home draft, focus, streams and an existing sync notice survive display changes',async({page})=>{
 const calls=await homeFixture(page);await page.goto('/');await expect(page.getByLabel('Task',{exact:true})).toBeVisible();
 await expect(page.getByText('Updating recent conversations',{exact:true})).toBeVisible();
 const editor=page.getByLabel('Task',{exact:true});await editor.fill('原始 draft text');await editor.focus();
 const before=[...calls],streams=await page.evaluate(()=>(window as any).streamCount);
 await page.evaluate(()=>{localStorage.setItem('codex-web:locale:v1','zh-CN');window.dispatchEvent(new Event('locale-changed'));});
 await expect(page.getByLabel('任务',{exact:true})).toHaveValue('原始 draft text');await expect(page.getByLabel('任务',{exact:true})).toBeFocused();
 await expect(page.getByText('最近会话更新中',{exact:true})).toBeVisible();expect(calls).toEqual(before);expect(await page.evaluate(()=>(window as any).streamCount)).toBe(streams);
});

for(const width of [390,1440])test(`English login and Home fit ${width}px and 200 percent zoom`,async({page},info)=>{
 await page.setViewportSize({width,height:900});await loginFixture(page);await page.goto('/');await expect(page.getByLabel('Administrator password',{exact:true})).toBeVisible();
 await page.evaluate(()=>{document.documentElement.style.zoom='2';});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('login-en.png'),fullPage:true});
 await page.unroute('**/api/**');await homeFixture(page);await page.goto('/');await expect(page.getByLabel('Task',{exact:true})).toBeVisible();await page.evaluate(()=>{document.documentElement.style.zoom='2';});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('home-en.png'),fullPage:true});
});
