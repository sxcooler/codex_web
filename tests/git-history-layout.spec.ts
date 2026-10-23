import {test,expect} from '@playwright/test';

for(const [width,height] of [[360,800],[390,844],[1280,900],[1440,900]])for(const locale of ['zh-CN','en'])test(`Git history layout uses empty space and preserves the selected diff: ${locale} ${width}`,async({page},info)=>{
 const errors:string[]=[],writes:string[]=[],reads:string[]=[];
 const commits=Array.from({length:24},(_,i)=>({id:i.toString(16).padStart(40,'0'),parents:[(i+1).toString(16).padStart(40,'0')],subject:'Improve demo navigation '+(i+1),author:'Demo Developer',date:'2026-10-16T08:00:00Z',refs:i===0?['refs/heads/feature/mobile-layout']:[]}));
 await page.setViewportSize({width,height});await page.addInitScript(value=>localStorage.setItem('codex-web:locale:v1',value),locale);page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;reads.push(path);if(route.request().method()!=='GET')writes.push(path);
  const data=path.endsWith('/git/repositories')?{repositories:[{path:'',name:'demo-project-with-a-long-name',kind:'main',available:true},{path:'packages/ui',kind:'nested',available:true}],complete:false}
   :path.endsWith('/git/log')?{repository:true,commits,branches:[{ref:'refs/heads/main',name:'main'}],nextCursor:'demo-next'}
   :path.endsWith('/git/commit')?{commit:{...commits[0],message:'Demo commit'},files:Array.from({length:12},(_,i)=>({path:i===0?'README.md':'src/feature-'+i+'.ts',added:i+1,deleted:0}))}
   :path.endsWith('/git/commit/diff')?{hunks:[{oldStart:1,newStart:1,oldLines:0,newLines:80,lines:Array.from({length:80},(_,i)=>({kind:'add',newLine:i+1,text:'changed demo line '+i}))}]}
   :{files:[]};await route.fulfill({json:data});
 });
 await page.goto('/tests/git-fetch-notice.html');await expect(page).toHaveTitle('Git 刷新提示回归');await page.locator('.tabs > button').nth(2).click();
 await expect(page.locator('.git-commit')).toHaveCount(24);const history=page.locator('.git-history'),list=page.locator('.git-graph-list');
 const available=await history.evaluate(node=>node.clientHeight),initialHeight=await list.evaluate(node=>node.clientHeight);
 expect(initialHeight).toBeGreaterThan(available*.55);
 const labels=await page.locator('.git-history-controls > label').evaluateAll(nodes=>nodes.map(node=>({top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right})));
 expect(labels[1].left).toBeGreaterThanOrEqual(labels[0].right);expect(Math.abs(labels[0].top-labels[1].top)).toBeLessThan(1);
 const selects=page.locator('.git-history-controls select');await selects.first().focus();await page.keyboard.press('Tab');await expect(selects.nth(1)).toBeFocused();
 await page.screenshot({path:info.outputPath('history-unselected.png')});
 await page.locator('.git-commit').first().click();await expect(page.locator('.commit-files-section .file-list button')).toHaveCount(12);
 await page.screenshot({path:info.outputPath('history-areas.png')});
 await page.locator('.commit-files-section .file-list button').first().click();await expect(page.locator('.diff-line').first()).toContainText('changed demo line 0');
 expect(await list.evaluate(node=>node.clientHeight)).toBeGreaterThanOrEqual(48);
 expect(await page.locator('.commit-files-section').evaluate(node=>node.clientHeight)).toBeGreaterThan(available*.18);
 const preview=page.locator('.preview-shell:modal');await expect(preview).toBeVisible();expect(await preview.evaluate(node=>node.clientHeight)).toBeGreaterThan(available*.8);
 await page.screenshot({path:info.outputPath('history-selected.png')});
 await page.locator('.preview-content').evaluate(node=>{(window as any).previewNode=node;node.scrollTop=100;});const readsBefore=reads.length;await page.keyboard.press('Escape');await expect(preview).toHaveCount(0);await list.evaluate(node=>node.scrollTop=100);
 const files=page.locator('.commit-files-section'),fileHeight=await files.evaluate(node=>node.clientHeight),toggle=history.locator(':scope > .panel-list-section > .panel-section-toggle');await toggle.click();expect(await files.evaluate(node=>node.clientHeight)).toBeGreaterThan(fileHeight);await toggle.click();
 await expect(list).toHaveJSProperty('scrollTop',100);await files.locator('.file-list button').first().click();await expect(preview).toBeVisible();await expect(page.locator('.preview-content')).toHaveJSProperty('scrollTop',100);expect(await page.locator('.preview-content').evaluate(node=>node===(window as any).previewNode)).toBe(true);
 expect(reads.length).toBe(readsBefore);expect(writes).toEqual([]);expect(errors).toEqual([]);await expect(page.locator('vite-error-overlay')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
