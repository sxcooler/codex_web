import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {Projects} from '../src/projects.ts';

const utf16=(text:string,bigEndian=false)=>{const bytes=Buffer.from(text,'utf16le');if(bigEndian)bytes.swap16();return Buffer.concat([Buffer.from(bigEndian?[0xfe,0xff]:[0xff,0xfe]),bytes]);};
async function fixture(run:(projects:Projects,project:{id:string;path:string},root:string)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'codex-file-preview-'));
  try{const projects=new Projects(root),project=await projects.create({name:'Preview',folderName:'preview'});await run(projects,project,root);}
  finally{assert.equal(dirname(root),tmpdir());await rm(root,{recursive:true,force:true});}
}

test('single entry distinguishes root, xml-named directories and files without weakening path safety',()=>fixture(async(projects,p,root)=>{
  await mkdir(join(p.path,'named.xml'));await writeFile(join(p.path,'text.xml'),'<root/>');
  assert.deepEqual(await projects.fileEntry(p.id,'.'),{path:'',type:'directory'});
  assert.deepEqual(await projects.fileEntry(p.id,'named.xml'),{path:'named.xml',type:'directory'});
  assert.deepEqual(await projects.fileEntry(p.id,'./text.xml'),{path:'text.xml',type:'file'});
  assert.deepEqual(await projects.listFiles(p.id,'named.xml'),{files:[]});
  await assert.rejects(projects.readFile(p.id,'named.xml'),(error:any)=>error.statusCode===400);
  await assert.rejects(projects.fileEntry(p.id,'missing.xml'),(error:any)=>error.statusCode===404);
  for(const path of ['../outside','named.xml/../text.xml','C:\\Windows\\win.ini','text.xml:stream','.git/config','.env.xml','secrets.xml'])await assert.rejects(projects.fileEntry(p.id,path),path);
  const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'visible.xml'),'<root/>');await writeFile(join(outside,'.env.xml'),'sensitive');
  await symlink(outside,join(p.path,'linked'),'junction');
  await assert.rejects(projects.fileEntry(p.id,'linked'),(error:any)=>error.statusCode===403);
  const allowed=new Projects(root,true);
  assert.deepEqual(await allowed.fileEntry(p.id,'linked'),{path:'linked',type:'directory'});
  assert.deepEqual(await allowed.fileEntry(p.id,'linked/visible.xml'),{path:'linked/visible.xml',type:'file'});
  await assert.rejects(allowed.fileEntry(p.id,'linked/.env.xml'),(error:any)=>error.statusCode===403);
}));

test('file previews decode BOM text strictly and retain raw patch semantics and untracked counts',()=>fixture(async(projects,p)=>{
  const xml='<?xml version="1.0"?><root>中文</root>\n',cases=[['utf8.xml',Buffer.from(xml)],['utf8-bom.xml',Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(xml)])],['le.xml',utf16(xml)],['be.xml',utf16(xml,true)]] as const;
  for(const [name,bytes] of cases){await writeFile(join(p.path,name),bytes);const result=await projects.readFile(p.id,name);assert.equal(result.binary,false,name);assert.equal(result.text,xml,name);assert.equal(result.size,bytes.length);assert.equal(result.truncated,false);}
  const binaryCases=[['zero.xml',Buffer.from('<root>\0</root>')],['late-nul.xml',Buffer.from('x'.repeat(8192)+'\0')],['le-nul.xml',utf16('<root>\0</root>')],['bad-utf8.xml',Buffer.from([0x3c,0x80,0x3e])],['bad-le.xml',Buffer.from([0xff,0xfe,0x00,0xdc])],['bad-be.xml',Buffer.from([0xfe,0xff,0xdc,0x00])],['odd-le.xml',Buffer.from([0xff,0xfe,0x3c])],['no-bom.xml',Buffer.from(xml,'utf16le')],['binary.xml',Buffer.from([0,1,2,3])]] as const;
  for(const [name,bytes] of binaryCases){await writeFile(join(p.path,name),bytes);const result=await projects.readFile(p.id,name);assert.equal(result.binary,true,name);assert.equal(result.text,'',name);}
  const files=(await projects.gitFiles(p.id)).files;
  for(const name of ['utf8.xml','utf8-bom.xml','le.xml','be.xml']){const file=files.find(file=>file.path===name)!;assert.equal(file.binary,false,name);assert.equal(file.added,1,name);}
  assert.equal(await projects.gitPatch(p.id,'le.xml'),'');assert.equal(await projects.gitPatch(p.id,'be.xml'),'');
  assert.match(await projects.gitPatch(p.id,'utf8.xml'),/中文/);
  await writeFile(join(p.path,'lines.xml'),'<root/>\n'.repeat(20_001));const lines=await projects.readFile(p.id,'lines.xml');assert.equal(lines.binary,false);assert.equal(lines.truncated,true);assert.equal(lines.text.split('\n').length,20_000);
}));

test('byte truncation discards only an incomplete final character and rejects invalid interior sequences',()=>fixture(async(projects,p)=>{
  const limit=1024*1024,prefix='<?xml version="1.0"?><root>',utf8Prefix=prefix+'x'.repeat(limit-1-Buffer.byteLength(prefix)),utf16Prefix='x'.repeat((limit-2)/2-1);
  const cases=[['utf8-cut.xml',Buffer.from(utf8Prefix+'中</root>'),utf8Prefix],['le-cut.xml',utf16(utf16Prefix+'😀tail'),utf16Prefix],['be-cut.xml',utf16(utf16Prefix+'😀tail',true),utf16Prefix]] as const;
  for(const [name,bytes,expected] of cases){await writeFile(join(p.path,name),bytes);const result=await projects.readFile(p.id,name);assert.equal(result.binary,false,name);assert.equal(result.truncated,true,name);assert.equal(result.text,expected,name);}
  const invalid=[['utf8-invalid-cut.xml',Buffer.concat([Buffer.from([0x80]),Buffer.from(utf8Prefix+'中tail')])],['le-invalid-cut.xml',Buffer.concat([Buffer.from([0xff,0xfe,0x00,0xdc]),Buffer.from(utf16Prefix+'😀tail','utf16le')])],['be-invalid-cut.xml',Buffer.concat([Buffer.from([0xfe,0xff,0xdc,0x00]),utf16(utf16Prefix+'😀tail',true).subarray(2)])]] as const;
  for(const [name,bytes] of invalid){await writeFile(join(p.path,name),bytes);const result=await projects.readFile(p.id,name);assert.equal(result.binary,true,name);assert.equal(result.text,'',name);assert.equal(result.truncated,true,name);}
  await writeFile(join(p.path,'exact-limit.xml'),'x'.repeat(limit));const exact=await projects.readFile(p.id,'exact-limit.xml');assert.equal(exact.binary,false);assert.equal(exact.truncated,false);assert.equal(exact.text.length,limit);
  await writeFile(join(p.path,'incomplete-at-limit.xml'),Buffer.concat([Buffer.alloc(limit-1,0x78),Buffer.from([0xe4])]));const incomplete=await projects.readFile(p.id,'incomplete-at-limit.xml');assert.equal(incomplete.binary,true);assert.equal(incomplete.truncated,false);
}));
