import {test,expect,type Page} from '@playwright/test';
const switchLanguage=(page:Page,value:'en'|'zh-CN')=>page.evaluate(value=>(window as any).changeLocale(value),value);
const requests=(page:Page)=>page.evaluate(()=>(window as any).requests);

for(const width of [390,1440])for(const locale of ['zh-CN','en'] as const)test(`language control spacing and focus match adjacent settings at ${width}px in ${locale}`,async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.addInitScript(value=>{Object.defineProperty(navigator,'languages',{configurable:true,value:[value]});},locale);
 await page.setViewportSize({width,height:900});await page.goto('/tests/i18n-settings.html?section=web');await switchLanguage(page,locale);
 await expect(page.getByRole('combobox',{name:locale==='en'?'Interface language':'界面语言',exact:true})).toBeVisible();
 const language=page.locator('.language-preference select');await language.selectOption('system');
 const before=await requests(page);
 for(const zoom of [1,2]){
  await page.evaluate(value=>{document.documentElement.style.zoom=String(value);},zoom);
  await page.locator('#session-sort').focus();await page.keyboard.press('Shift+Tab');await expect(language).toBeFocused();
  await page.keyboard.press('End');await expect(language).toHaveValue('en');await page.keyboard.press('Home');await expect(language).toHaveValue('system');
  const layout=await language.evaluate(select=>{
   const label=select.parentElement!,range=document.createRange();range.selectNode(label.firstChild!);
   const text=range.getBoundingClientRect(),control=select.getBoundingClientRect(),style=getComputedStyle(select),adjacent=getComputedStyle(document.querySelector('#session-sort')!);
   const scaled=Number(getComputedStyle(document.documentElement).zoom)||1;
   return {gap:Math.max(control.left-text.right,control.top-text.bottom)/scaled,paddingRight:parseFloat(style.paddingRight),adjacentPaddingRight:parseFloat(adjacent.paddingRight),weight:style.fontWeight,adjacentWeight:adjacent.fontWeight,visible:control.left>=0&&control.right<=innerWidth,focused:select.matches(':focus-visible')};
  });
  await page.screenshot({path:info.outputPath(`language-${zoom}x.png`),fullPage:true});
  expect(layout.gap,'focused outline must have space from its label').toBeGreaterThanOrEqual(8);
  expect(layout.paddingRight,'arrow needs the same reserved space as adjacent selects').toBeGreaterThanOrEqual(layout.adjacentPaddingRight);
  expect(layout.weight).toBe(layout.adjacentWeight);expect(layout.visible).toBe(true);expect(layout.focused).toBe(true);
 }
 expect(await requests(page)).toEqual(before);expect(errors).toEqual([]);
});
test('configuration draft, leave dialog and focus survive language changes without requests',async({page})=>{
 await page.goto('/tests/i18n-settings.html?section=configuration');await expect(page.locator('#setting-model_reasoning_effort')).toHaveValue('high');
 await page.locator('#setting-model_reasoning_effort').selectOption('low');const before=await requests(page);await page.locator('#setting-model_reasoning_effort').focus();
 await switchLanguage(page,'en');await expect(page.getByRole('heading',{name:'Configuration',exact:true})).toBeVisible();await expect(page.locator('#setting-model_reasoning_effort')).toHaveValue('low');await expect(page.locator('#setting-model_reasoning_effort')).toBeFocused();expect(await requests(page)).toEqual(before);
 await page.getByRole('link',{name:'Personalization',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();const dialogBefore=await requests(page);await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
 await switchLanguage(page,'zh-CN');await expect(page.getByRole('dialog')).toContainText('有未保存的更改');await expect(page.getByRole('button',{name:'取消',exact:true})).toBeFocused();expect(await requests(page)).toEqual(dialogBefore);
 await page.getByRole('button',{name:'取消',exact:true}).click();await expect(page.getByRole('link',{name:'个性化',exact:true})).toBeFocused();await expect(page.locator('#setting-model_reasoning_effort')).toHaveValue('low');
});
test('instruction original draft and raw save failure remain through locale changes',async({page})=>{
 await page.goto('/tests/i18n-settings.html?section=personalization&view=instructions');const editor=page.locator('textarea');await expect(editor).toHaveValue('Original 用户 instruction');await editor.fill('New 用户 draft');const before=await requests(page);await editor.focus();await switchLanguage(page,'en');await expect(page.getByRole('button',{name:'Save and return',exact:true})).toBeVisible();await expect(editor).toHaveValue('New 用户 draft');await expect(editor).toBeFocused();expect(await requests(page)).toEqual(before);
 await page.getByRole('button',{name:'Save and return',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Native raw failure');const failed=await requests(page);await switchLanguage(page,'zh-CN');await expect(page.getByRole('alert')).toContainText('Native raw failure');await expect(editor).toHaveValue('New 用户 draft');expect(await requests(page)).toEqual(failed);
});
test('Web language preference and open restart precheck are display only',async({page})=>{
 await page.goto('/tests/i18n-settings.html?section=web');await expect(page.locator('#diagnostics-status-title')).toBeVisible();const before=await requests(page);await page.getByRole('combobox',{name:'界面语言',exact:true}).selectOption('en');await expect(page.getByRole('combobox',{name:'Interface language',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Current diagnostics',exact:true})).toBeVisible();expect(await requests(page)).toEqual(before);
 await page.getByRole('button',{name:'Restart Web service',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('currently idle');const dialogBefore=await requests(page);await switchLanguage(page,'zh-CN');await expect(page.getByRole('dialog')).toContainText('本机 App Server 当前空闲。');await expect(page.getByRole('button',{name:'取消',exact:true})).toBeFocused();expect(await requests(page)).toEqual(dialogBefore);
});
test('native speed description and its unsaved selection remain original',async({page})=>{
 await page.goto('/tests/i18n-settings.html?section=general');await expect(page.locator('#setting-service_tier')).toHaveValue('default');await page.locator('#setting-service_tier').selectOption('priority');await expect(page.getByText('Native tier description',{exact:true})).toBeVisible();const before=await requests(page);await switchLanguage(page,'en');await expect(page.locator('#setting-service_tier')).toHaveValue('priority');await expect(page.getByText('Native tier description',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Save configuration',exact:true})).toBeEnabled();expect(await requests(page)).toEqual(before);
});
test('plugins local search, original text and partial state survive language changes',async({page})=>{
 await page.goto('/tests/i18n-settings.html?section=plugins');await expect(page.getByText('Native plugin name',{exact:true})).toBeVisible();await page.locator('input[type=search]').fill('Native');const before=await requests(page);await switchLanguage(page,'en');await expect(page.getByRole('searchbox',{name:'Search installed plugins',exact:true})).toHaveValue('Native');await expect(page.getByText('原始 plugin description',{exact:true}).first()).toBeVisible();await expect(page.locator('.plugin-status')).toContainText('Enabled');expect(await requests(page)).toEqual(before);
});
test('notification results change language without repeating permission or subscription work',async({page})=>{
 await page.addInitScript(()=>{(window as any).notificationCalls=[];Object.defineProperty(window,'Notification',{configurable:true,value:class{static permission='default';static async requestPermission(){(window as any).notificationCalls.push('permission');return 'denied';}}});Object.defineProperty(window,'PushManager',{configurable:true,value:class{}});Object.defineProperty(navigator.serviceWorker,'getRegistration',{configurable:true,value:async()=>{(window as any).notificationCalls.push('registration');return {pushManager:{getSubscription:async()=>{(window as any).notificationCalls.push('subscription');return null;}}};}});});
 await page.goto('/tests/i18n-settings.html?section=web');await expect(page.locator('.notification-status')).toHaveText('尚未启用');await page.getByRole('button',{name:'启用通知',exact:true}).click();await expect(page.locator('.notification-status')).toHaveText('未获得通知权限。');const before=await page.evaluate(()=>(window as any).notificationCalls);const apiBefore=await requests(page);await switchLanguage(page,'en');await expect(page.locator('.notification-status')).toHaveText('Notification permission was not granted.');expect(await page.evaluate(()=>(window as any).notificationCalls)).toEqual(before);expect(await requests(page)).toEqual(apiBefore);
});
for(const width of [390,1440])test(`English settings fit ${width}px and 200 percent zoom`,async({page})=>{
 await page.setViewportSize({width,height:900});
 for(const [section,heading] of [['general','General'],['configuration','Configuration'],['plugins','Installed plugins'],['web','Codex Web']]){
  await page.goto('/tests/i18n-settings.html?section='+section);await switchLanguage(page,'en');await expect(page.locator('#settings-section-title')).toHaveText(heading);await expect(page.locator('.settings-content')).toBeVisible();
  if(section==='web')await expect(page.locator('#diagnostics-status-title')).toBeVisible();
  await page.evaluate(()=>{document.documentElement.style.zoom='2';});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(width===1440&&section==='configuration')expect(await page.locator('#setting-permission-preset').evaluate(select=>select.previousElementSibling!.getBoundingClientRect().width/2)).toBeGreaterThanOrEqual(140);
  if(width===390)expect(await page.getByRole('combobox',{name:'Settings categories',exact:true}).evaluate(select=>select.getBoundingClientRect().width/2)).toBeGreaterThanOrEqual(100);
  if(width===390&&section==='web')expect(await page.locator('.settings-status dd').first().evaluate(value=>value.getBoundingClientRect().width/2)).toBeGreaterThanOrEqual(60);
  await page.screenshot({path:`.local/settings/visual-${width}-${section}.png`,fullPage:true});
 }
});
