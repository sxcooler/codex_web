import test from 'node:test';
import assert from 'node:assert/strict';
import {chatFileUrl,fileUrl,linkedFile,fileImageUrl} from '../src/web/fileLinks.ts';

test('document links resolve within the active project without opening local protocols',()=>{
  const origin='https://web.example',root='C:\\work\\project';
  const resolve=(url:string,projectRoot=root)=>chatFileUrl('session',projectRoot,url,origin);
  const expected=origin+'/api/sessions/session/files/content?path='+encodeURIComponent('docs/方案.md');
  for(const url of ['docs/方案.md','./docs/方案.md#L12','C:/work/project/docs/方案.md:12:3','/C:/work/project/docs/方案.md','c:\\WORK\\project\\docs\\方案.md','file:///C:/work/project/docs/%E6%96%B9%E6%A1%88.md'])assert.equal(resolve(url),expected,url);
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

test('repository images resolve relative to the document, never to arbitrary URLs',()=>{
  const origin='https://web.example',resolve=(url:string)=>fileImageUrl('session','docs/guide.md',url,origin);
  for(const url of ['../images/图%20片.png','/images/图%20片.png'])assert.equal(resolve(url),origin+'/api/sessions/session/files/image?path='+encodeURIComponent('images/图 片.png'));
  assert.equal(resolve('images/a.png'),origin+'/api/sessions/session/files/image?path=docs%2Fimages%2Fa.png');
  for(const url of ['https://example.com/a.png','https://web.example/api/secret','//remote/a.png','\\\\remote\\a.png','C:/a.png','file:///a.png','data:image/png;base64,AA','../../a.png','%2f%2fremote/a.png','%2e%2e/%2e%2e/a.png','images/%00.png','images/%zz.png','https%3A%2F%2Fexample.com/a.png','#heading',''])assert.equal(resolve(url),'',url);
});
