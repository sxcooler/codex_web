import {test,expect} from '@playwright/test';

for(const kind of ['async','sync'])for(const width of [1280,390])test(`${kind} question Markdown keeps links and displays images at ${width}px`,async({page},testInfo)=>{
  const posted:any[]=[],imageRequests:string[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width,height:900});
  await page.addInitScript(()=>{window.EventSource=class extends EventTarget{constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('ready')));}close(){}} as any;});
  const title='请确认 **00:01:39.9** 的 [原帧局部图](</C:/project/frames/crop.png>)。\n\n![内嵌图片](</C:/project/frames/inline.png>)\n\n[说明文件](docs/readme.md#details) · [外部说明](https://example.com/help)\n\n![项目外图片](</C:/outside/private.png>)';
  const question=kind==='async'?{title,options:['友方分身/佣兵','敌人']}:{id:'object',question:title,options:[{label:'友方分身/佣兵'},{label:'敌人'}],isOther:true};
  let answered=false;
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;let data:any={};
    if(path==='/api/auth/session')data={authenticated:true,csrfToken:'test'};
    else if(path==='/api/projects')data={projects:[{id:'project',name:'project',path:'C:/project'}]};
    else if(path==='/api/sessions')data={data:[],nextCursor:null};
    else if(path==='/api/models')data={data:[]};
    else if(path==='/api/permission-modes')data={modes:[]};
    else if(path==='/api/sessions/question-markdown')data={thread:{id:'question-markdown',turns:[{id:'turn',status:'completed',items:kind==='async'?[{id:'question',type:'agentMessage',delivery:'async',text:title,questions:[question]}]:[]}]},project:{id:'project',name:'project',path:'C:/project'},phase:kind==='sync'&&!answered?'WAITING_INPUT':'IDLE',pending:kind==='sync'&&!answered?[{requestId:'request',method:'item/tool/requestUserInput',params:{questions:[question]}}]:[],inputAnswers:answered?{'turn:question':{status:'accepted'}}:{}};
    else if(path.endsWith('/files/image')){imageRequests.push(url.searchParams.get('path')!);return route.fulfill({contentType:'image/png',path:'public/assets/icon-mobile-v1-512.png'});}
    else if(path.endsWith('/files/content'))data={path:url.searchParams.get('path'),content:'# Details\n\n说明文件',kind:'text'};
    else if(path.endsWith('/answer')||path.endsWith('/respond')){posted.push(route.request().postDataJSON());answered=true;data={status:'accepted'};}
    await route.fulfill({json:data});
  });
  await page.goto('/sessions/question-markdown');
  const card=page.locator('.question-fields');
  await expect(card.locator('strong')).toHaveText('00:01:39.9');
  const link=card.getByRole('link',{name:'原帧局部图',exact:true});
  await expect(link).toHaveAttribute('href',/\/files\/content\?path=frames%2Fcrop\.png$/);
  await expect(card.locator('img')).toHaveCount(1);
  await expect(card.getByRole('img',{name:'内嵌图片'})).toHaveJSProperty('naturalWidth',512);
  expect(imageRequests).toEqual(['frames/inline.png']);
  await expect(card).toContainText('仅支持项目内图片：项目外图片');
  await expect(card.getByRole('link',{name:'外部说明'})).toHaveAttribute('target','_blank');
  await expect(card.getByRole('link',{name:'说明文件'})).toHaveAttribute('href',/path=docs%2Freadme\.md#details$/);
  await page.locator('.timeline').evaluate(element=>{element.scrollTop=0;});
  await page.screenshot({path:testInfo.outputPath('question-rendering.png')});
  await link.click();
  await expect(page.locator('.git-panel .image-preview img')).toHaveJSProperty('naturalWidth',512);
  expect(imageRequests).toContain('frames/crop.png');
  if(width<680)await page.getByRole('button',{name:'关闭侧栏',exact:true}).click({position:{x:4,y:50}});
  await expect(card.getByRole('radio',{name:'敌人',exact:true})).not.toBeChecked();
  expect(posted).toHaveLength(0);
  await card.getByRole('radio',{name:'敌人',exact:true}).check();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('question-markdown.png')});
  await page.getByRole('button',{name:kind==='async'?'发送回答':'提交回答',exact:true}).click();
  await expect.poll(()=>posted.length).toBe(1);
  expect(kind==='async'?posted[0].answers:posted[0].answer.answers.object.answers).toEqual(['敌人']);
  expect(errors).toEqual([]);
});
