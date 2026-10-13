import {test,expect,type Page} from '@playwright/test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const evidence=mkdtempSync(join(tmpdir(),'codex-preview-header-'));
test.beforeEach(async({page})=>{const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));(page as any).previewErrors=errors;await page.addInitScript(()=>{(window as any).copied=[];(window as any).rejectCopy=false;(window as any).holdCopy=false;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{if((window as any).rejectCopy)throw new Error('clipboard denied');if((window as any).holdCopy)await new Promise(resolve=>{(window as any).finishCopy=resolve;});(window as any).copied.push(text);}}});});});
test.afterEach(async({page})=>{expect((page as any).previewErrors).toEqual([]);});
async function setup(page:Page){await page.goto('/tests/preview-header.html');await expect(page.locator('.markdown-message h2').first()).toBeVisible();}

for(const width of [1280,390])test(`two header rows, icon copy and stable preview at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await setup(page);const shell=page.locator('.preview-shell:visible'),copy=shell.getByRole('button',{name:'复制文件路径',exact:true});await expect(copy).toBeVisible();await expect(copy).toHaveText('');
 const geometry=await shell.evaluate(node=>{const box=(selector:string)=>node.querySelector(selector)!.getBoundingClientRect(),h=box('h3'),copy=box('.preview-copy'),expand=box('.preview-expand'),mode=box('.markdown-file-controls'),nav=box('.file-preview-navigation');return{h:{y:h.y,height:h.height},copy:{y:copy.y,width:copy.width,height:copy.height},expand:{y:expand.y},mode:{y:mode.y},nav:{y:nav.y},overflow:getComputedStyle(node.querySelector('h3')!).overflowX};});
 expect(geometry.copy.y).toBe(geometry.expand.y);expect(geometry.nav.y).toBeGreaterThanOrEqual(geometry.h.y+geometry.h.height);expect(Math.abs(geometry.nav.y-geometry.mode.y)).toBeLessThan(10);expect(geometry.overflow).toBe('hidden');expect(geometry.copy.width).toBe(width===390?44:28);expect(geometry.copy.height).toBe(geometry.copy.width);
 await page.evaluate(()=>{(window as any).previewNode=document.querySelector('.markdown-message');document.querySelector('.preview-content')!.scrollTop=300;(window as any).readCount=(window as any).requests.length;});const before=await shell.locator('.preview-content').evaluate(n=>n.scrollTop);
 await copy.click();await expect(shell.locator('.preview-copy-feedback')).toHaveText('已复制');expect(await shell.locator('.preview-copy-feedback').evaluate(n=>n.getBoundingClientRect().width)).toBeLessThanOrEqual(1);expect(await page.evaluate(()=>(window as any).copied)).toEqual(['C:\\Users\\Developer\\work\\sample-project\\.worktrees\\temporal-pipeline-benchmark\\docs\\handoffs\\2026-10-13-n0-cuda32-trt32-wide-table-results.md']);
 expect(await page.evaluate(()=>document.querySelector('.markdown-message')===(window as any).previewNode)).toBe(true);expect(await shell.locator('.preview-content').evaluate(n=>n.scrollTop)).toBe(before);expect(await page.evaluate(()=>(window as any).requests.length)).toBe(await page.evaluate(()=>(window as any).readCount));
 await shell.getByRole('button',{name:'全屏查看',exact:true}).click();await expect(page.locator('dialog:modal')).toHaveCount(1);await expect(copy).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('dialog:modal')).toHaveCount(0);await expect(copy).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:join(evidence,`header-${width}.png`)});console.log('Evidence: '+evidence);
});

test('copy failure is honest and a late success does not belong to the next file',async({page})=>{
 await setup(page);const shell=page.locator('.preview-shell:visible'),copy=shell.getByRole('button',{name:'复制文件路径',exact:true});await expect(copy).toBeVisible();
 await page.evaluate(()=>(window as any).rejectCopy=true);await copy.click();await expect(shell.locator('.preview-copy-feedback')).toHaveText('复制失败，请重试');expect(await shell.evaluate(node=>node.querySelector('.preview-copy-feedback')!.getBoundingClientRect().top>=node.querySelector('.file-preview-controls')!.getBoundingClientRect().bottom)).toBe(true);expect(await page.evaluate(()=>(window as any).copied)).toEqual([]);
 await page.evaluate(()=>{(window as any).rejectCopy=false;(window as any).holdCopy=true;});await copy.click();await page.evaluate(()=>(window as any).renderPanel('short.md'));await expect(shell.locator('h3')).toHaveAttribute('title','short.md');await page.evaluate(()=>(window as any).finishCopy());await expect(shell.locator('.preview-copy-feedback')).toBeEmpty();
});

for(const repository of ['', 'vendor/sub'])test(`Git history copy includes repository '${repository}'`,async({page})=>{
 await setup(page);await page.evaluate(repo=>(window as any).renderHistory(repo),repository);await expect(page.locator('.diff-line').first()).toBeVisible();const shell=page.locator('.preview-shell:visible');await shell.getByRole('button',{name:'复制文件路径',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).copied)).toEqual(['C:\\Users\\Developer\\work\\sample-project\\'+(repository?repository.replaceAll('/','\\')+'\\':'')+'nested\\file.txt']);
 await shell.getByRole('button',{name:'全屏查看',exact:true}).click();await expect(page.locator('dialog:modal')).toHaveCount(1);await page.keyboard.press('Escape');await expect(page.locator('dialog:modal')).toHaveCount(0);
});

test('missing project root disables copy instead of inventing an absolute path',async({page})=>{
 await setup(page);await page.evaluate(()=>(window as any).renderHistory('',true));await expect(page.locator('.diff-line').first()).toBeVisible();await expect(page.getByRole('button',{name:'复制文件路径',exact:true})).toBeDisabled();expect(await page.evaluate(()=>(window as any).copied)).toEqual([]);
});

test('working tree diff shares the copy header and view controls stay on the second row',async({page})=>{
 await setup(page);await page.getByRole('button',{name:'变更',exact:true}).click();await page.locator('.file-list button').filter({hasText:'wide-table-results.md'}).click();await expect(page.locator('.diff-line').first()).toBeVisible();
 const shell=page.locator('.preview-shell:visible');await expect(shell.locator('.file-preview-controls .split-toggle')).toBeVisible();await shell.getByRole('button',{name:'复制文件路径',exact:true}).click();await expect(shell.locator('.preview-copy-feedback')).toHaveText('已复制');await expect(shell.locator('.preview-copy')).toHaveAttribute('data-copy-status','success');
 await expect.poll(()=>page.evaluate(()=>(window as any).copied)).toEqual(['C:\\Users\\Developer\\work\\sample-project\\.worktrees\\temporal-pipeline-benchmark\\docs\\handoffs\\2026-10-13-n0-cuda32-trt32-wide-table-results.md']);
 await expect(shell.locator('.preview-copy-feedback')).toBeEmpty();await expect(shell.locator('.preview-copy')).not.toHaveAttribute('data-copy-status','success');
 await page.evaluate(()=>(window as any).rejectCopy=true);await shell.getByRole('button',{name:'复制文件路径',exact:true}).click();await expect(shell.locator('.preview-copy-feedback')).toHaveText('复制失败，请重试');
 const position=await shell.evaluate(node=>({feedback:node.querySelector('.preview-copy-feedback')!.getBoundingClientRect().top,controls:node.querySelector('.file-preview-controls')!.getBoundingClientRect().bottom}));expect(position.feedback,JSON.stringify(position)).toBeGreaterThanOrEqual(position.controls);
});
