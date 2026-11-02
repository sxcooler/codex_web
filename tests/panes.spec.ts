import {test,expect} from '@playwright/test';

for(const width of [390,1001,1279,1280,1281,1440])for(const locale of ['zh-CN','en'])test(`pane drawer boundary ${width}px ${locale}`,async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.addInitScript(value=>localStorage.setItem('codex-web:locale:v1',value),locale);
 await page.setViewportSize({width,height:900});await page.goto('/tests/panes.html');
 await expect(page).toHaveTitle('双侧栏布局回归');await expect(page.locator('#result')).toContainText('PASS:');await expect(page.locator('vite-error-overlay')).toHaveCount(0);
 const shell=page.locator('.shell'),left=page.locator('[data-panel-toggle=left]'),right=page.locator('[data-panel-toggle=right]');
 await expect(page.locator('html')).toHaveAttribute('lang',locale);
 if(width<=1280){
  await left.click();await expect(shell).toHaveAttribute('data-drawer','left');await expect(page.locator('.sidebar')).toHaveCSS('position','fixed');
  await page.keyboard.press('Tab');expect(await page.evaluate(()=>!!document.activeElement?.closest('.sidebar,.pane-toolbar'))).toBe(true);
  await right.click();await expect(left).toHaveAttribute('aria-expanded','false');await expect(page.locator('.git-panel')).toHaveCSS('position','fixed');await expect(page.locator('.session-main')).toHaveJSProperty('inert',true);
  await page.screenshot({path:info.outputPath('right.png')});await page.keyboard.press('Escape');await expect(right).toBeFocused();await expect(shell).toHaveAttribute('data-drawer','');
  await left.click();await page.screenshot({path:info.outputPath('left.png')});await page.locator('.drawer-backdrop').click({position:{x:width-5,y:100}});await expect(left).toHaveAttribute('aria-expanded','false');
 }else{
  await expect(page.locator('.sidebar')).toHaveCSS('position','static');await expect(page.getByRole('separator')).toHaveCount(2);await page.screenshot({path:info.outputPath('desktop.png')});
 }
 if(width===1280){
  await left.click();await page.setViewportSize({width:1281,height:900});await expect(shell).toHaveAttribute('data-drawer','');await expect(left).toHaveAttribute('aria-expanded','true');
  await page.setViewportSize({width:1280,height:900});await expect(left).toHaveAttribute('aria-expanded','false');await expect(page.locator('.drawer-backdrop')).toHaveCount(0);
 }
 expect(errors).toEqual([]);
});

for(const width of [390,1280])test(`drawer layout preserves composer input behavior at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.goto('/tests/session-toolbar.html');
 const input=page.locator('#message');await expect(page.locator('.connection')).toHaveText('空闲');await expect(input).toHaveAttribute('enterkeyhint',width<=1000?'enter':'send');
 await page.getByRole('button',{name:'收起输入区',exact:true}).click();await page.getByRole('button',{name:'展开输入',exact:true}).click();
 if(width>1000)await expect(input).toBeFocused();
 await input.fill('保留输入快捷键');await input.press('Enter');
 await expect.poll(()=>page.evaluate(()=>(window as any).testState.messages?.length??0)).toBe(width<=1000?0:1);
 if(width===1280){
  await page.setViewportSize({width:1000,height:900});await expect(input).toHaveAttribute('enterkeyhint','enter');
  await page.setViewportSize({width:1280,height:900});await expect(input).toHaveAttribute('enterkeyhint','send');
 }
});
