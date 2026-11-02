import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join,parse} from 'node:path';
import sharp from 'sharp';
import {createPluginIconReader} from '../src/codex/extension-icons.ts';
import {initializeAuth} from '../src/server/auth.ts';

const png=await sharp({create:{width:192,height:128,channels:4,background:'#ff0000'}}).png().toBuffer();
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/></svg>';
async function fixture(run:(home:string,cache:string)=>Promise<void>){const home=await mkdtemp(join(process.cwd(),'.local/icon-test-')),cache=join(home,'plugins/cache');await mkdir(cache,{recursive:true});try{await run(home,cache);}finally{await rm(home,{recursive:true,force:true});}}

async function decoded(value:string|null){assert.ok(value?.startsWith('data:image/png;base64,'));return sharp(Buffer.from(value.split(',')[1],'base64')).metadata();}

test('icons become small metadata-free PNGs and invalid images keep a null fallback',async()=>fixture(async(home,cache)=>{
 const path=join(cache,'logo.png');await writeFile(path,await sharp(png).withMetadata({exif:{IFD0:{Copyright:'not-public'}}}).png().toBuffer());const read=createPluginIconReader(home),meta=await decoded(await read(path));
 assert.equal(meta.format,'png');assert.equal(meta.width,96);assert.equal(meta.height,64);assert.equal(meta.exif,undefined);assert.equal(meta.icc,undefined);
 await writeFile(join(cache,'false.png'),'not PNG');for(const bad of ['logo.png',join(cache,'missing.png'),join(cache,'false.png')])assert.equal(await read(bad),null);
}));

test('native signed remote logos retain their query and only trust the exact HTTPS image provider',async()=>fixture(async(home)=>{
 const read=createPluginIconReader(home),url='https://files.openai.com/plugins/logo.png?sig=opaque%2Fsignature&se=2026-12-01T00%3A00%3A00Z';assert.equal(await read(url),url);
 for(const bad of ['https://example.com/logo.png','http://files.openai.com/logo.png','https://files.openai.com.evil.test/logo.png','https://user:pass@files.openai.com/logo.png','https://@files.openai.com/logo.png','https://files.openai.com:444/logo.png','https://files.openai.com./logo.png','//files.openai.com/logo.png','\\\\files.openai.com\\logo.png','data:image/svg+xml,<svg/>','https://files.openai.com/lo\ng.png','https://files.openai.com\\@evil.test/logo.png','not a URL',null])assert.equal(await read(bad),null);
}));

test('remote cache fallback verifies exact native identity and refuses ambiguous versions or escaping manifest logos',async()=>fixture(async(home,cache)=>{
 const url='https://files.openai.com/plugins/logo.png?sig=opaque%2Fsignature',parent=join(cache,'official/brand');
 const create=async(version:string,manifest:any)=>{const pkg=join(parent,version);await mkdir(join(pkg,'.codex-plugin'),{recursive:true});await writeFile(join(pkg,'.codex-plugin/plugin.json'),JSON.stringify(manifest));await writeFile(join(pkg,'logo.png'),png);return pkg;};
 const one=await create('1.0.0',{name:'brand',version:'1.0.0',interface:{logo:'./logo.png'}}),identity={marketplace:'official',name:'brand'};
 assert.ok((await createPluginIconReader(home)(url,undefined,identity))?.startsWith('data:image/png;base64,'));
 await create('2.0.0',{name:'brand',version:'2.0.0',interface:{logo:'./logo.png'}});assert.equal(await createPluginIconReader(home)(url,undefined,identity),url);
 assert.ok((await createPluginIconReader(home)(url,undefined,{...identity,version:'1.0.0'}))?.startsWith('data:image/png;base64,'));
 assert.equal(await createPluginIconReader(home)(url,undefined,{...identity,version:'3.0.0'}),url);
 for(const manifest of [{name:'wrong',version:'1.0.0',interface:{logo:'./logo.png'}},{name:'brand',version:'wrong',interface:{logo:'./logo.png'}},{name:'brand',version:'1.0.0',interface:{logo:'../2.0.0/logo.png'}},{name:'brand',version:'1.0.0',interface:{logo:'https://example.com/logo.png'}}]){await writeFile(join(one,'.codex-plugin/plugin.json'),JSON.stringify(manifest));assert.equal(await createPluginIconReader(home)(url,undefined,{...identity,version:'1.0.0'}),url);}
 for(const bad of [{...identity,marketplace:'../official'},{...identity,name:'../brand'},{...identity,version:'../1.0.0'}])assert.equal(await createPluginIconReader(home)(url,undefined,bad),url);
 await writeFile(join(one,'.codex-plugin/plugin.json'),' '.repeat(65537));assert.equal(await createPluginIconReader(home)(url,undefined,{...identity,version:'1.0.0'}),url);
 await symlink(join(parent,'2.0.0'),join(one,'linked'),'junction');await writeFile(join(one,'.codex-plugin/plugin.json'),JSON.stringify({name:'brand',version:'1.0.0',interface:{logo:'./linked/logo.png'}}));assert.equal(await createPluginIconReader(home)(url,undefined,{...identity,version:'1.0.0'}),url);
 const outside=join(home,'outside-version');await mkdir(join(outside,'.codex-plugin'),{recursive:true});await writeFile(join(outside,'.codex-plugin/plugin.json'),JSON.stringify({name:'brand',version:'3.0.0',interface:{logo:'./logo.png'}}));await writeFile(join(outside,'logo.png'),png);await symlink(outside,join(parent,'3.0.0'),'junction');assert.equal(await createPluginIconReader(home)(url,undefined,{...identity,version:'3.0.0'}),url);
}));

test('absolute remote icons stay inside their verified native cache package',async()=>fixture(async(home,cache)=>{
 const pkg=join(cache,'official/brand/1.0.0'),other=join(cache,'official/other/0.0.0');
 for(const [path,name,version]of [[pkg,'brand','1.0.0'],[other,'other','0.0.0']]){await mkdir(join(path,'.codex-plugin'),{recursive:true});await writeFile(join(path,'.codex-plugin/plugin.json'),JSON.stringify({name,version,interface:{logo:'./logo.png'}}));await writeFile(join(path,'logo.png'),png);}
 const path=join(pkg,'logo.png'),identity={marketplace:'official',name:'brand',version:'1.0.0'};
 assert.equal(await createPluginIconReader(home)(path,undefined,{marketplace:'official',name:'other',version:'0.0.0'}),null);
 assert.equal(await createPluginIconReader(home)(path,pkg,{marketplace:'not-official',name:'unrelated',version:'0.0.0'}),null);
 assert.ok((await createPluginIconReader(home)(path,undefined,identity))?.startsWith('data:image/png;base64,'));
 assert.ok((await createPluginIconReader(home)(path))?.startsWith('data:image/png;base64,'),'legacy calls without native identity retain the cache-only boundary');
}));

test('large local PNGs and self-contained SVG package logos normalize within the same bounded reader',async()=>fixture(async(home,cache)=>{
 const path=join(cache,'ponytail.png');await writeFile(path,Buffer.concat([png,Buffer.alloc(567655-png.length)]));assert.equal((await decoded(await createPluginIconReader(home)(path))).width,96);
 const root=join(home,'.tmp/marketplaces/agentmemory/plugin');await mkdir(join(root,'.codex-plugin'),{recursive:true});await mkdir(join(root,'assets'));await writeFile(join(root,'.codex-plugin/plugin.json'),'{}');const icon=join(root,'assets/icon.svg');await writeFile(icon,svg);
 assert.equal(await createPluginIconReader(home)(icon),null);assert.equal((await decoded(await createPluginIconReader(home)(icon,root))).format,'png');
}));

test('icon roots cannot expose outside files, broad directories or junction escapes',async()=>fixture(async(home,cache)=>{
 const outside=join(home,'outside'),pkg=join(home,'package');for(const root of [outside,pkg]){await mkdir(root);await writeFile(join(root,'logo.png'),png);}await mkdir(join(pkg,'.codex-plugin'));await writeFile(join(pkg,'.codex-plugin/plugin.json'),'{}');await symlink(outside,join(pkg,'escape'),'junction');await symlink(outside,join(cache,'escape'),'junction');
 const read=createPluginIconReader(home);for(const [path,root]of [[join(outside,'logo.png'),undefined],[join(outside,'logo.png'),outside],[join(pkg,'escape/logo.png'),pkg],[join(cache,'escape/logo.png'),undefined],[join(outside,'logo.png'),home],[join(outside,'logo.png'),parse(home).root]])assert.equal(await read(path,root),null);
 assert.ok(await read(join(pkg,'logo.png'),pkg));await symlink(pkg,join(home,'linked-package'),'junction');assert.equal(await read(join(home,'linked-package/logo.png'),join(home,'linked-package')),null);
 await rm(cache,{recursive:true});await symlink(outside,cache,'junction');assert.equal(await createPluginIconReader(home)(join(cache,'logo.png')),null);
}));

test('SVG rejects external references, entities, CSS and executable content before rasterization',async()=>fixture(async(home,cache)=>{
 const bad=['<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///secret">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///secret"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://example.com/secret.svg#x"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="u&#114;l(file:///secret)"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/x.css"</style></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="4" height="4"/></svg>',
  '<?xml-stylesheet href="file:///secret"?><svg xmlns="http://www.w3.org/2000/svg"/>'];
 const read=createPluginIconReader(home);for(let i=0;i<bad.length;i++){const path=join(cache,i+'.svg');await writeFile(path,bad[i]);assert.equal(await read(path),null);}
}));

test('each inventory bounds input, output, candidate count and declared image pixels',async()=>fixture(async(home,cache)=>{
 const small=join(cache,'logo.png');await writeFile(small,png);const read=createPluginIconReader(home);for(let i=0;i<32;i++)assert.ok(await read(small));assert.equal(await read(small),null);
 const full=join(cache,'full.png');await writeFile(full,Buffer.concat([png,Buffer.alloc(1048576-png.length)]));const inputs=createPluginIconReader(home);for(let i=0;i<4;i++)assert.ok(await inputs(full));assert.equal(await inputs(full),null);
 const large=join(cache,'large.png');await writeFile(large,Buffer.alloc(1048577));assert.equal(await createPluginIconReader(home)(large),null);
 const noisy=join(cache,'noisy.png');await writeFile(noisy,await sharp(randomBytes(96*96*4),{raw:{width:96,height:96,channels:4}}).png().toBuffer());const outputs=createPluginIconReader(home);let bytes=0,accepted=0;for(let i=0;i<32;i++){const result=await outputs(noisy);if(result){bytes+=Buffer.byteLength(result);accepted++;}}assert.ok(accepted>0&&accepted<32);assert.ok(bytes<=1048576);
 const pixels=join(cache,'pixels.svg');await writeFile(pixels,'<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"/>');assert.equal(await createPluginIconReader(home)(pixels),null);
}));

test('real native remote fields use signed logoUrl when local logo is null',async()=>fixture(async(home)=>{
 const {readExtensionSources}=await import('../src/codex/extensions.ts');
 const url='https://files.openai.com/plugins/logo.png?sig=opaque%2Fsignature',peer={home,cli:async()=>({}),request:async(method:string)=>{assert.equal(method,'plugin/installed');return {marketplaces:[{name:'openai-curated-remote',plugins:[{id:'build-web-apps@openai-curated-remote',installed:true,source:{type:'remote'},interface:{logo:null,logoUrl:url}}]}],marketplaceLoadErrors:[]};}};
 const {snapshot}=await readExtensionSources(peer,home,{sources:['plugins']});assert.equal(snapshot.items[0].iconUrl,url);
}));

test('native app/read icons select a valid dark image, fall back to light and preserve missing branding',async()=>fixture(async(home)=>{
 const {readExtensionSources}=await import('../src/codex/extensions.ts');
 const signed='https://files.openai.com/content/brand.png?sig=opaque%2Fsignature',light='https://chatgpt.com/images/ecosystem/apps/sites/icon.png',dark='https://chatgpt.com/images/ecosystem/apps/sites/icon_dark.png';
 const metadata=[{id:'dark',iconUrl:light,iconUrlDark:dark},{id:'signed',iconUrl:signed,iconUrlDark:null},{id:'fallback',iconUrl:light,iconUrlDark:'https://example.com/untrusted.png'},{id:'empty',iconUrl:null,iconUrlDark:null},{id:'invalid',iconUrl:'https://chatgpt.com/private/avatar.png',iconUrlDark:'https://files.openai.com:444/brand.png'}];
 const peer={home,cli:async()=>({}),request:async(method:string)=>{if(method==='app/installed')return {apps:metadata.map(a=>({id:a.id,enabled:true,callable:true}))};assert.equal(method,'app/read');return {apps:metadata.map(a=>({...a,name:a.id,pluginDisplayNames:[]})),missingAppIds:[]};}};
 const {snapshot}=await readExtensionSources(peer,home,{sources:['apps']});assert.deepEqual(snapshot.items.map(a=>a.iconUrl),[dark,signed,light,null,null]);
}));

test('legacy app/list logo fields apply the same dark priority and exact image boundaries',async()=>fixture(async(home)=>{
 const {readExtensionSources}=await import('../src/codex/extensions.ts');
 const light='https://files.openai.com/content/light.png?sig=opaque',dark='https://chatgpt.com/images/ecosystem/apps/github/icon_dark.png';
 const peer={home,cli:async()=>({}),request:async(method:string)=>{if(method==='app/installed')throw Object.assign(Error('unsupported'),{code:-32601});assert.equal(method,'app/list');return {data:[{id:'legacy',name:'Legacy',isAccessible:true,logoUrl:light,logoUrlDark:dark},{id:'fallback',name:'Fallback',isAccessible:true,logoUrl:light,logoUrlDark:'http://files.openai.com/dark.png'},{id:'missing',name:'Missing',isAccessible:true,logoUrl:null,logoUrlDark:null}],nextCursor:null};}};
 const {snapshot}=await readExtensionSources(peer,home,{sources:['apps']});assert.deepEqual(snapshot.items.map(a=>a.iconUrl),[dark,light,null]);
}));

test('app image boundaries reject authority tricks and non-static ChatGPT paths without widening plugin origins',async()=>fixture(async(home)=>{
 const {readExtensionSources}=await import('../src/codex/extensions.ts');
 const bad=['http://files.openai.com/icon.png','https://files.openai.com.evil.test/icon.png','https://user:pass@files.openai.com/icon.png','https://@files.openai.com/icon.png','https://files.openai.com:443/icon.png','https://chatgpt.com:444/images/ecosystem/apps/a/icon.png','https://chatgpt.com/images/ecosystem/apps-evil/a/icon.png','https://chatgpt.com/images/ecosystem/apps/a/../../private/icon.png','https://chatgpt.com/images/ecosystem/apps/a/run.html','https://chatgpt.com/private/icon.png','//files.openai.com/icon.png','\\\\files.openai.com\\icon.png','https://files.openai.com/lo\ng.png','https://files.openai.com\\@evil.test/icon.png','data:image/png;base64,AAAA'];
 const peer={home,cli:async()=>({}),request:async(method:string)=>{if(method==='app/installed')return {apps:bad.map((_,i)=>({id:String(i),enabled:true,callable:true}))};assert.equal(method,'app/read');return {apps:bad.map((iconUrl,i)=>({id:String(i),name:String(i),iconUrl,iconUrlDark:null,pluginDisplayNames:[]})),missingAppIds:[]};}};
 const {snapshot}=await readExtensionSources(peer,home,{sources:['apps']});assert.ok(snapshot.items.every(a=>a.iconUrl===null));assert.equal(await createPluginIconReader(home)('https://chatgpt.com/images/ecosystem/apps/a/icon.png'),null);
}));

test('HTTP CSP grants only the exact provider image hosts without changing other source directives',async()=>fixture(async(home)=>{
 const {buildServer}=await import('../src/server/app.ts');
 await initializeAuth(home,'extension-icon-test-password');const app=await buildServer({dataDir:home,origin:'http://localhost:3000'});try{const response=await app.inject({url:'/api/auth/session',headers:{host:'localhost:3000'}});assert.equal(response.statusCode,200);assert.equal(response.headers['content-security-policy'],"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://files.openai.com https://chatgpt.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");}finally{await app.close();}
}));
