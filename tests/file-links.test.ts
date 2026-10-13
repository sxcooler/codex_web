import test from 'node:test';
import assert from 'node:assert/strict';
import {chatFileUrl,fileUrl,linkedFile,fileImageUrl,relativeFile,previewFilePath} from '../src/web/fileLinks.ts';

test('preview copy resolves host paths including worktrees and selected nested repositories',()=>{
 const path='.worktrees/temporal-pipeline-benchmark/docs/中文 空格.md';
 assert.equal(previewFilePath('C:\\Users\\Developer\\work\\project',path),'C:\\Users\\Developer\\work\\project\\.worktrees\\temporal-pipeline-benchmark\\docs\\中文 空格.md');
 assert.equal(previewFilePath('C:/work/project/',path),'C:/work/project/'+path);
 assert.equal(previewFilePath('/home/project/','docs/readme.md','vendor/sub'),'/home/project/vendor/sub/docs/readme.md');
 assert.equal(previewFilePath('\\\\server\\share\\project\\','docs/readme.md'),'\\\\server\\share\\project\\docs\\readme.md');
 assert.equal(previewFilePath('/','readme.md'),'/readme.md');
 for(const [root,path,repository] of [[undefined,'a.md',''],['C:/work','',''],['C:/work','../escape.md',''],['C:/work','a.md','../escape'],['relative','a.md',''],['C:/work','..\\escape.md',''],['/home/work','/outside.md','']] as const)assert.equal(previewFilePath(root,path,repository),'');
});

test('document links resolve within the active project without opening local protocols',()=>{
  const origin='https://web.example',root='C:\\work\\project';
  const resolve=(url:string,projectRoot=root)=>chatFileUrl('session',projectRoot,url,origin);
  const expected=origin+'/api/sessions/session/files/content?path='+encodeURIComponent('docs/方案.md');
  for(const url of ['docs/方案.md','/C:/work/project/docs/方案.md','c:\\WORK\\project\\docs\\方案.md','file:///C:/work/project/docs/%E6%96%B9%E6%A1%88.md'])assert.equal(resolve(url),expected,url);
  for(const url of ['./docs/方案.md#L12','C:/work/project/docs/方案.md:12:3'])assert.equal(resolve(url),expected+'#L12',url);
  assert.equal(resolve('/home/test/project/docs/方案.md','/home/test/project'),expected);
  for(const url of ['../secret.md','docs/../../secret.md','C:/work/project/../secret.md','C:/work/project-other/secret.md','/etc/passwd','file://remote/share/a.md','//remote/a.md','javascript:alert(1)','javascript%3Aalert(1)','data:text/html,test','https%3A%2F%2Fevil.test','%2f%2fremote/a.md','docs/%00.md','docs/%zz.md'])assert.equal(resolve(url),'',url);
  assert.equal(resolve('/home/test/Project/a.md','/home/test/project'),'');
  assert.equal(resolve('docs/a.md',''),'');
  assert.equal(resolve('https://example.com'),'https://example.com/');
  assert.equal(resolve('#heading'),'#heading');
  const encoded=resolve('docs/space%20%23%2520.md');
  assert.equal(linkedFile('session','',encoded,origin),'docs/space #%20.md');
  assert.equal(fileUrl('session','docs/guide.md','next.md',origin),origin+'/api/sessions/session/files/content?path=docs%2Fnext.md');
  assert.equal(linkedFile('other','',expected,origin),'');
});

test('document references preserve Unicode anchors and Codex line references',()=>{
  const origin='https://web.example',base=origin+'/api/sessions/s/files/content?path=docs%2Fguide.md';
  for(const anchor of ['主要卡点与下一步顺序',encodeURIComponent('主要卡点与下一步顺序'),'repeat-1']){
    assert.equal(fileUrl('s','docs/index.md','guide.md#'+anchor,origin),base+'#'+encodeURIComponent(decodeURIComponent(anchor)));
    assert.equal(chatFileUrl('s','C:/work/project','C:/work/project/docs/guide.md#'+anchor,origin),base+'#'+encodeURIComponent(decodeURIComponent(anchor)));
    assert.equal(fileUrl('s','docs/guide.md','#'+anchor,origin),'#'+encodeURIComponent(decodeURIComponent(anchor)));
  }
  assert.equal(fileUrl('s','docs/index.md','guide.md:12',origin),base+'#L12');
  assert.equal(linkedFile('s','',base+'#L12',origin),'docs/guide.md');
  assert.equal(fileUrl('s','','https://example.com/guide#章节',origin),'https://example.com/guide#%E7%AB%A0%E8%8A%82');
});

test('repository images resolve relative to the document, never to arbitrary URLs',()=>{
  const origin='https://web.example',resolve=(url:string)=>fileImageUrl('session','docs/guide.md',url,origin);
  for(const url of ['../images/图%20片.png','/images/图%20片.png'])assert.equal(resolve(url),origin+'/api/sessions/session/files/image?path='+encodeURIComponent('images/图 片.png'));
  assert.equal(resolve('images/a.png'),origin+'/api/sessions/session/files/image?path=docs%2Fimages%2Fa.png');
  for(const url of ['https://example.com/a.png','https://web.example/api/secret','//remote/a.png','\\\\remote\\a.png','C:/a.png','file:///a.png','data:image/png;base64,AA','../../a.png','%2f%2fremote/a.png','%2e%2e/%2e%2e/a.png','images/%00.png','images/%zz.png','https%3A%2F%2Fexample.com/a.png','#heading',''])assert.equal(resolve(url),'',url);
});

test('absolute project images reuse local file boundary checks and keep document-relative images intact',()=>{
  const origin='https://web.example',root='C:\\Users\\example\\work\\sample-project';
  const resolve=(url:string)=>fileImageUrl('session','docs/report.md',url,origin,root);
  const path='runs/misc/navigation-pair-20261002/roi-example/human-70-roi.png';
  const expected=origin+'/api/sessions/session/files/image?path='+encodeURIComponent(path);
  for(const prefix of [root+'\\', 'c:/users/example/work/sample-project/', '/C:/Users/example/work/sample-project/'])assert.equal(resolve(prefix+path),expected);
  assert.equal(resolve(root+'\\runs\\图%20%231.png'),origin+'/api/sessions/session/files/image?path='+encodeURIComponent('runs/图 #1.png'));
  assert.equal(resolve('../runs/a.png'),origin+'/api/sessions/session/files/image?path=runs%2Fa.png');
  assert.equal(fileImageUrl('s','docs/report.md','/home/project/runs/a.png',origin,'/home/project'),origin+'/api/sessions/s/files/image?path=runs%2Fa.png');
  for(const url of [root+'-other/a.png',root+'/../private.png','C:/outside/private.png','https://evil.invalid/a.png','file://remote/a.png','\\\\remote\\a.png'])assert.equal(resolve(url),'',url);
});

test('local directory links distinguish the project root from invalid or empty targets',()=>{
 const origin='https://web.example',root='C:/work/project',target='https://web.example/api/sessions/s/files/content?path=.';
 for(const path of ['.','./','C:/work/project','C:/work/project/','c:\\WORK\\project\\','file:///C:/work/project/'])assert.equal(chatFileUrl('s',root,path,origin),target,path);
 assert.equal(chatFileUrl('s','/home/test/project','/home/test/project',origin),target);
 assert.equal(fileUrl('s','README.md','./',origin),target);
 assert.equal(fileUrl('s','docs/README.md','../',origin),target);
 assert.equal(linkedFile('s','docs/README.md',target,origin),'.');
 assert.equal(relativeFile('docs/README.md','../'),'.');
 for(const path of ['', '../', 'C:/work/project/../', 'C:/work/project-other', 'javascript:alert(1)', '%2f%2foutside/a'])assert.equal(chatFileUrl('s',root,path,origin),'',path);
 for(const path of ['', '../../', 'javascript:alert(1)', '%zz'])assert.equal(relativeFile('docs/README.md',path),'',path);
 assert.equal(linkedFile('s','',origin+'/api/sessions/s/files/content?path=',origin),'');
 assert.equal(fileImageUrl('s','README.md','./',origin,root),'');
 assert.equal(fileImageUrl('s','README.md',root,origin,root),'');
});

test('absolute Linux project roots cannot become image targets',()=>{
 for(const path of ['/home/project','/home/project/','/home/project///'])assert.equal(fileImageUrl('s','README.md',path,'https://web.example','/home/project'),'');
});
