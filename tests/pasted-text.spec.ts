import {test,expect,type Page,type Locator} from '@playwright/test';
import {readFile} from 'node:fs/promises';

type Upload={name:string;type:string;text:string;size:number;sameFile:boolean};
const previews=/^(预览粘贴文本 |Preview pasted text )/;
const remove=/^(移除附件 |Remove attachment )/;
const retry=/^(重试|Retry)$/;

async function openApp(page:Page,width=1440,locale='zh-CN'){
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error'||message.type()==='warning')errors.push(message.text());});
  await page.setViewportSize({width,height:900});
  await page.addInitScript(value=>{
    localStorage.setItem('codex-web:locale:v1',value);
    localStorage.setItem('codex-web:panels:v1',JSON.stringify({version:1,left:false,right:false}));
  },locale);
  await page.goto('/tests/session-toolbar.html');
  await expect(page.locator('#message')).toBeVisible();
  await expect(page.locator('.connection')).toHaveText(locale==='en'?'Idle':'空闲');
  await expect(page).toHaveTitle(/ - Codex Web$/);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.evaluate(()=>{
    const original=window.fetch;
    const harness={mode:'success',uploads:[] as any[],pending:[] as (()=>void)[],files:[] as File[]};
    (window as any).pasteHarness=harness;
    window.fetch=async(path,options={})=>{
      if(path!=='/api/uploads')return original(path,options);
      const file=(options.body as FormData).get('file') as File;
      const index=harness.files.length,sameFile=harness.files.includes(file);
      harness.files.push(file);
      harness.uploads.push({name:file.name,type:file.type,text:await file.text(),size:file.size,sameFile});
      const rejected=file.name.toLowerCase().endsWith('.exe');
      const response=()=>new Response(JSON.stringify(rejected?{error:'Invalid request',code:'REQUEST_VALIDATION_FAILED'}:harness.mode==='fail'?{error:'Controlled upload failure'}:{uploadId:'pasted-'+index,kind:file.type.startsWith('image/')?'image':'file'}),{status:rejected?400:harness.mode==='fail'?503:200});
      if(harness.mode==='hold')return new Promise<Response>(resolve=>harness.pending.push(()=>resolve(response())));
      return response();
    };
  });
  return errors;
}

async function uploads(page:Page):Promise<Upload[]>{return page.evaluate(()=>(window as any).pasteHarness.uploads);}
async function mode(page:Page,value:'success'|'fail'|'hold'){await page.evaluate(value=>(window as any).pasteHarness.mode=value,value);}
async function paste(target:Locator,text:string,image=false){
  return target.evaluate((element,{text,image})=>{
    const data=new DataTransfer();data.setData('text/plain',text);
    if(image)data.items.add(new File(['image clipboard payload'],'clipboard.png',{type:'image/png'}));
    const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});
    element.dispatchEvent(event);return event.defaultPrevented;
  },{text,image});
}
async function pasteFiles(target:Locator,files:{name:string;type:string;text:string}[],text=''){
  return target.evaluate((element,{files,text})=>{
    const data=new DataTransfer();data.setData('text/plain',text);
    for(const file of files)data.items.add(new File([file.text],file.name,{type:file.type}));
    const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});
    element.dispatchEvent(event);return event.defaultPrevented;
  },{files,text});
}
async function expanded(page:Page,value=true){
  const button=page.getByRole('button',{name:value?/^(展开输入|Expand composer)$/:/^(收起输入区|Collapse composer)$/});
  if(await button.isVisible())await button.click();
  await expect(page.locator('.composer')).toHaveClass(value?'composer':/is-collapsed/);
}
async function home(page:Page){
  const link=page.getByRole('link',{name:/^＋ (新任务|New task)$/});
  if(!await link.isVisible())await page.locator('[data-panel-toggle="left"]').click();
  await link.click();
  await expect(page.locator('.home textarea')).toBeVisible();
  if(await page.locator('.shell').getAttribute('data-drawer')==='left')await page.locator('[data-panel-toggle="left"]').click();
}
async function checkDraft(input:Locator,value:string,start=2,end=5){
  await expect(input).toHaveValue(value);
  expect(await input.evaluate(element=>[(element as HTMLTextAreaElement).selectionStart,(element as HTMLTextAreaElement).selectionEnd])).toEqual([start,end]);
}
async function selectDraft(input:Locator,value='旧草稿 old draft'){
  await input.fill(value);
  await input.evaluate(element=>(element as HTMLTextAreaElement).setSelectionRange(2,5));
}
async function downloadText(page:Page){
  const downloaded=page.waitForEvent('download');
  await page.getByRole('link',{name:/^(下载完整文件|Download full file)$/}).click();
  const file=await downloaded;
  return {name:file.suggestedFilename(),text:await readFile((await file.path())!,'utf8')};
}

for(const width of [1440,390])for(const locale of ['zh-CN','en'])test(`clipboard files and rejected upload are visible in expanded and compact composers ${width}px ${locale}`,async({page},info)=>{
  const errors=await openApp(page,width,locale),input=page.locator('#message');
  await expanded(page);await selectDraft(input);
  const files=[{name:'notes.md',type:'text/markdown',text:'# clipboard\r\n中文'},{name:'report.pdf',type:'application/pdf',text:'%PDF-1.7'}];
  expect(await pasteFiles(input,files,'x'.repeat(5000))).toBe(true);
  await expect(page.locator('.attachments li')).toHaveCount(2);
  await expect.poll(async()=>(await uploads(page)).length).toBe(2);
  expect((await uploads(page)).map(({name,type,text})=>({name,type,text}))).toEqual(files);
  await checkDraft(input,'旧草稿 old draft');await expect(page.getByRole('button',{name:previews})).toHaveCount(0);
  await expect(page.locator('.attachment-hint')).not.toContainText(/5000|Markdown/);
  await expanded(page,false);
  expect(await pasteFiles(input,[{name:'danger.EXE',type:'application/octet-stream',text:'MZ payload'}])).toBe(true);
  const notice=page.locator('.composer-notice');
  await expect(notice).toContainText('danger.EXE');await expect(notice).toHaveAttribute('role','alert');
  await expect(notice).toContainText(locale==='en'?'not accepted':'未被接受');
  await expect(page.locator('.composer .primary')).toBeDisabled();
  await page.screenshot({path:info.outputPath('clipboard-rejected-compact.png')});
  await expanded(page);
  const failed=page.locator('.attachments li').filter({hasText:'danger.EXE'});
  await expect(failed.getByRole('alert')).toContainText(locale==='en'?'not accepted':'未被接受');
  await failed.getByRole('button',{name:remove}).focus();await page.keyboard.press('Enter');
  await expect(page.locator('.attachments li')).toHaveCount(2);await expect(page.locator('.composer .primary')).toBeEnabled();
  await page.screenshot({path:info.outputPath('clipboard-files-expanded.png')});
  await home(page);const task=page.locator('.home textarea');await selectDraft(task,'新任务已有正文');
  expect(await pasteFiles(task,[files[0]])).toBe(true);await expect(page.locator('.attachments li')).toHaveCount(1);
  await checkDraft(task,'新任务已有正文');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors.filter(error=>!error.includes('400'))).toEqual([]);
});

// Browser plugin not available: use the project's Playwright/Edge fixture, without touching the OS clipboard.
for(const width of [1440,390])for(const locale of ['zh-CN','en'])test(`pasted Markdown real Session and Home flows ${width}px ${locale}`,async({page},info)=>{
  const errors=await openApp(page,width,locale),input=page.locator('#message');
  await expanded(page);await selectDraft(input);
  const original='中文🙂\r\n'.repeat(834);
  expect(await paste(input,original)).toBe(true);
  await expect.poll(async()=>(await uploads(page)).length).toBe(1);
  expect((await uploads(page))[0]).toMatchObject({name:expect.stringMatching(/^pasted-text-.*\.md$/),type:'text/markdown',text:original,size:Buffer.byteLength(original)});
  await checkDraft(input,'旧草稿 old draft');
  const preview=page.getByRole('button',{name:previews});
  const previewBox=await preview.boundingBox(),removeBox=await page.getByRole('button',{name:remove}).boundingBox();
  expect(removeBox!.x-previewBox!.x-previewBox!.width).toBeGreaterThanOrEqual(4);
  expect(Math.abs(previewBox!.y+previewBox!.height/2-removeBox!.y-removeBox!.height/2)).toBeLessThanOrEqual(1);
  await expect(preview).toBeVisible();await preview.focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
  await expect.poll(()=>dialog.locator('pre').textContent()).toBe(original);
  await page.keyboard.press('Tab');expect(await dialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await page.screenshot({path:info.outputPath('session-source.png')});
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(preview).toBeFocused();
  await expanded(page,false);await selectDraft(input);
  expect(await paste(input,'x'.repeat(5001))).toBe(true);
  await expect.poll(async()=>(await uploads(page)).length).toBe(2);
  await checkDraft(input,'旧草稿 old draft');await expect(page.locator('.attachment-count')).toHaveText('2');
  await expect(preview).toHaveCount(0);
  const compactControls=[page.locator('.attachment-picker'),input,page.locator('.composer .primary'),page.locator('.composer-expand')];
  const boxes=await Promise.all(compactControls.map(control=>control.boundingBox()));
  for(let i=1;i<boxes.length;i++)expect(boxes[i]!.x-boxes[i-1]!.x-boxes[i-1]!.width).toBeGreaterThanOrEqual(0);
  await page.screenshot({path:info.outputPath('session-compact.png')});
  await expanded(page);await expect(preview).toHaveCount(2);
  await page.locator('.composer .primary').click();
  await expect.poll(()=>page.evaluate(()=>(window as any).testState.messages?.length??0)).toBe(1);
  expect(await page.evaluate(()=>(window as any).testState.messages[0])).toMatchObject({text:'旧草稿 old draft',attachmentIds:['pasted-0','pasted-1']});
  await home(page);
  const task=page.locator('.home textarea');await selectDraft(task,'新任务已有正文');
  expect(await paste(task,'中'.repeat(5000))).toBe(true);
  await expect.poll(async()=>(await uploads(page)).length).toBe(3);
  await checkDraft(task,'新任务已有正文');await expect(page.getByRole('button',{name:previews})).toHaveCount(1);
  await page.screenshot({path:info.outputPath('home-attachment.png')});
  const homePreview=page.getByRole('button',{name:previews});await homePreview.click();
  await expect.poll(()=>page.getByRole('dialog').locator('pre').textContent()).toBe('中'.repeat(5000));
  await page.keyboard.press('Escape');await expect(homePreview).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('threshold counts UTF-16 exactly and leaves the short paste to the browser',async({page})=>{
  await openApp(page);await expanded(page);
  const input=page.locator('#message');await selectDraft(input);
  const short='🙂'.repeat(2499)+'中',exact=short+'文',above=exact+'\r';
  expect([short.length,exact.length,above.length]).toEqual([4999,5000,5001]);
  expect(await paste(input,short)).toBe(false);expect(await uploads(page)).toHaveLength(0);
  await checkDraft(input,'旧草稿 old draft');
  expect(await paste(input,exact)).toBe(true);expect(await paste(input,above)).toBe(true);
  await expect.poll(async()=>(await uploads(page)).length).toBe(2);
  expect((await uploads(page)).map(file=>file.text)).toEqual([exact,above]);
  await checkDraft(input,'旧草稿 old draft');
});

test('only the main textarea converts text and a clipboard image takes precedence',async({page})=>{
  await openApp(page);await home(page);
  await page.getByRole('button',{name:'新建项目',exact:true}).click();
  const name=page.getByPlaceholder('Example Review Tool');await name.fill('kept name');
  expect(await paste(name,'x'.repeat(5000))).toBe(false);await expect(name).toHaveValue('kept name');
  // An unrelated textarea inside the form must not become a second composer target.
  await page.locator('.home form').evaluate(form=>{const input=document.createElement('textarea');input.id='unrelated-textarea';form.append(input);});
  expect(await paste(page.locator('#unrelated-textarea'),'x'.repeat(5000))).toBe(false);
  expect(await uploads(page)).toHaveLength(0);
  expect(await paste(page.locator('.home textarea').first(),'x'.repeat(5000),true)).toBe(true);
  await expect.poll(async()=>(await uploads(page)).length).toBe(1);
  expect((await uploads(page))[0]).toMatchObject({name:'clipboard.png',type:'image/png'});
  await expect(page.getByRole('button',{name:previews})).toHaveCount(0);
});

test('busy composer cannot upload a pasted file',async({page})=>{
  await openApp(page);await expanded(page);
  await page.evaluate(()=>(window as any).testState.holdSend=true);
  const input=page.locator('#message');await input.fill('held submission');await page.locator('.composer .primary').click();
  await expect(page.getByRole('button',{name:'添加附件',exact:true})).toBeDisabled();
  await paste(input,'x'.repeat(5000));expect(await uploads(page)).toHaveLength(0);
});

test('failed upload preserves the original File for safe source, download, retry and removal',async({page},info)=>{
  const errors=await openApp(page);await expanded(page);await mode(page,'fail');
  const original='<img src=x onerror="window.pastedExecuted=true"><script>window.pastedExecuted=true</script>\r\n'+'🙂中'.repeat(1800);
  await paste(page.locator('#message'),original);
  const row=page.locator('.attachments li');await expect(row).toContainText('Controlled upload failure');
  await expect(page.locator('.composer .primary')).toBeDisabled();
  await row.getByRole('button',{name:previews}).click();
  const dialog=page.getByRole('dialog');await expect.poll(()=>dialog.locator('pre').textContent()).toBe(original);
  await expect(dialog.locator('img,script,iframe')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).pastedExecuted)).toBeUndefined();
  const downloaded=await downloadText(page);expect(downloaded.text).toBe(original);expect(downloaded.name).toMatch(/^pasted-text-.*\.md$/);
  await page.screenshot({path:info.outputPath('failed-safe-source.png')});await page.keyboard.press('Escape');
  await mode(page,'success');await row.getByRole('button',{name:retry}).click();
  await expect(row).toContainText('就绪');expect((await uploads(page))[1]).toMatchObject({text:original,sameFile:true});
  await row.getByRole('button',{name:remove}).click();await expect(row).toHaveCount(0);await expect(page.locator('.composer .primary')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('sixth pasted file remains recoverable and retry revalidates the five-file limit',async({page},info)=>{
  await openApp(page);await expanded(page);
  await page.locator('.attachments input[type=file]').setInputFiles(Array.from({length:5},(_,i)=>({name:`old-${i}.txt`,mimeType:'text/plain',buffer:Buffer.from('old')})));
  await expect.poll(async()=>(await uploads(page)).length).toBe(5);
  await expect(page.locator('.attachments li')).toHaveCount(5);
  expect(await paste(page.locator('#message'),'中'.repeat(5000))).toBe(true);
  const rows=page.locator('.attachments li'),sixth=rows.filter({has:page.getByRole('button',{name:previews})});
  await expect(rows).toHaveCount(6);await expect(sixth).toContainText('最多 5 个附件');
  expect(await uploads(page)).toHaveLength(5);await expect(page.locator('.composer .primary')).toBeDisabled();
  await sixth.getByRole('button',{name:retry}).click();await expect(sixth).toContainText('最多 5 个附件');expect(await uploads(page)).toHaveLength(5);
  await expanded(page,false);await expect(page.locator('.attachment-count')).toHaveText('6');await expect(page.locator('.composer-compact')).toContainText('上传失败');
  await page.screenshot({path:info.outputPath('sixth-file-compact.png')});await expanded(page);
  await page.getByRole('button',{name:'移除附件 old-0.txt',exact:true}).click();await sixth.getByRole('button',{name:retry}).click();
  await expect(sixth).toContainText('就绪');await expect(rows).toHaveCount(5);expect((await uploads(page))[5].text).toBe('中'.repeat(5000));
  await expect(page.locator('.composer .primary')).toBeEnabled();
});

test('finishing an old upload after switching sessions cannot overwrite the new draft',async({page})=>{
  await openApp(page);await expanded(page);await mode(page,'hold');
  await page.locator('#message').fill('first draft');await paste(page.locator('#message'),'a'.repeat(5000));
  await expect.poll(async()=>(await uploads(page)).length).toBe(1);
  await page.locator('[data-panel-toggle="left"]').click();await page.getByRole('link',{name:'另一演示会话',exact:true}).click();
  await expect(page).toHaveURL(/\/sessions\/other$/);
  await page.locator('#message').fill('second draft');
  await page.evaluate(()=>{const harness=(window as any).pasteHarness;harness.mode='success';harness.pending.shift()();});
  await expect(page.locator('#message')).toHaveValue('second draft');await expect(page.locator('.attachments li')).toHaveCount(0);
  const firstSession=page.getByRole('link',{name:'完善示例应用的帮助文档与快速入门说明',exact:true});
  if(!await firstSession.isVisible())await page.locator('[data-panel-toggle="left"]').click();await firstSession.click();
  await expect(page.locator('#message')).toHaveValue('first draft');await expect(page.locator('.attachments li')).toHaveCount(1);
  await expect(page.locator('.attachments li')).toContainText('上传已暂停');
  await mode(page,'hold');await page.locator('.attachments li').getByRole('button',{name:retry}).click();
  await expect.poll(async()=>(await uploads(page)).length).toBe(2);
  await page.locator('.attachments li').getByRole('button',{name:remove}).click();
  await page.evaluate(()=>{const harness=(window as any).pasteHarness;harness.mode='success';harness.pending.shift()();});
  await expect(page.locator('.attachments li')).toHaveCount(0);await expect(page.locator('#message')).toHaveValue('first draft');
});

test('source preview is bounded at 256 KiB while full-file download is lossless',async({page},info)=>{
  await openApp(page,390,'en');await expanded(page);await mode(page,'fail');
  const original='# source\r\n'+'中🙂'.repeat(50000)+'\r\nEND-OF-COMPLETE-FILE';
  await paste(page.locator('#message'),original);
  await page.getByRole('button',{name:previews}).click();
  const dialog=page.getByRole('dialog'),source=dialog.locator('pre');
  await expect(source).toContainText('# source');
  const shown=await source.textContent();
  expect(original.startsWith(shown!)).toBe(true);expect(Buffer.byteLength(shown!)).toBeLessThanOrEqual(256*1024);
  // The limit lands inside an emoji: keep the longest complete Unicode prefix.
  expect(shown).toBe('# source\r\n'+'中🙂'.repeat(37447)+'中');
  await expect(dialog).toContainText('Showing the first 256 KiB');await expect(source).not.toContainText('END-OF-COMPLETE-FILE');
  expect((await downloadText(page)).text).toBe(original);
  await page.screenshot({path:info.outputPath('truncated-source-full-download.png')});
  await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:previews})).toBeFocused();
});

test('oversized pasted text stays recoverable without uploading or falling into the textarea limit',async({page})=>{
  const errors=await openApp(page);await expanded(page);
  const input=page.locator('#message');await selectDraft(input);
  const original='x'.repeat(15*1024*1024+1);
  expect(await paste(input,original)).toBe(true);
  const row=page.locator('.attachments li');await expect(row).toContainText('超过 15 MiB');
  expect(await uploads(page)).toHaveLength(0);await checkDraft(input,'旧草稿 old draft');
  await expect(page.locator('.composer .primary')).toBeDisabled();
  await row.getByRole('button',{name:retry}).click();await expect(row).toContainText('超过 15 MiB');
  expect(await uploads(page)).toHaveLength(0);
  const preview=row.getByRole('button',{name:previews});await preview.click();
  const dialog=page.getByRole('dialog');await expect.poll(()=>dialog.locator('pre').textContent()).toBe('x'.repeat(256*1024));
  await expect(dialog).toContainText('仅预览前 256 KiB');expect((await downloadText(page)).text).toBe(original);
  await page.keyboard.press('Escape');await expect(preview).toBeFocused();
  await row.getByRole('button',{name:remove}).click();await expect(row).toHaveCount(0);
  await expect(input).toHaveValue('旧草稿 old draft');await expect(page.locator('.composer .primary')).toBeEnabled();
  expect(errors).toEqual([]);
});
