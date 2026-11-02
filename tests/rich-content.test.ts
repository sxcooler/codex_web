import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRichContent} from '../src/web/richContent.ts';
const vis=(value:unknown)=>'\uE200visualize\uE202'+JSON.stringify(value)+'\uE201';
test('preserves source order, multiple references and source text',()=>{
 const input='Before\n\n'+vis({path:'C:/work/a.html',title:'One',mode:'wide'})+'\n\nBetween\n\n'+vis({path:'/work/b.html'})+'\n\nAfter';
 const parts=parseRichContent(input);
 assert.deepEqual(parts.filter(p=>p.type==='preview').map(p=>p.path),['C:/work/a.html','/work/b.html']);
 assert.equal(parts.map(p=>p.raw).join(''),input);
});
test('code fences, inline code, indented code and escaped directives stay literal',()=>{
 for(const input of ['```text\n'+vis({path:'/a.html'})+'\n```','`'+vis({path:'/a.html'})+'`','    '+vis({path:'/a.html'}),'\\::codex-inline-vis{path="/a.html"}'])assert.deepEqual(parseRichContent(input),[{type:'markdown',raw:input}]);
});
test('unclosed and damaged streamed markers cannot swallow following prose',()=>{
 for(const input of ['\uE200visualize\uE202{"path":\n\nFollowing','::codex-inline-vis{path="/a\n\nFollowing',':::writing{title="Draft"}\nBody\n\nFollowing','<oai-mem-citation>\nBroken\n\nFollowing']){
  for(const streaming of [true,false]){const parts=parseRichContent(input,streaming);assert.equal(parts.map(p=>p.raw).join(''),input);assert.ok(parts.some(p=>p.type==='markdown'&&p.raw.includes('Following')));assert.equal(parts.filter(p=>p.type==='preview').length,0);}
 }
});
test('validates JSON, attributes, byte limits and filename types before preview',()=>{
 for(const value of [{path:''},{path:3},{path:'/a\0.html'},{path:'/a.html',title:3},{path:'/a.html',mode:'full'},{path:'x'.repeat(4097)},{path:'中'.repeat(1366)},{path:'/a',title:'x'.repeat(201)},{path:'/a',extra:'x'.repeat(8192)}])assert.equal(parseRichContent(vis(value))[0].type,'fallback');
 for(const input of ['\uE200visualize\uE202{broken}\uE201','::codex-inline-vis{path="/a" path="/b"}','::code-comment{title="A" body="B" file="/c" start=0}'])assert.equal(parseRichContent(input)[0].type,'fallback');
});
test('known directives have typed passive views, file ranges and safe drafts',()=>{
 const input='【C:/work/a.ts†L12-L18】\n:codex-file-citation{path="/a.docx" purpose="output"}\n::code-comment{title="Bug" body="Details" file="/a.ts" start=12 end=18 priority=1 confidence=0.8}\n:::writing{title="Draft" recipient="a@example.test"}\nHello\n:::\n:::task-stub{title="Fix"}\nDo this\n:::\n:::github-details{summary="More" open="true"}\nDetails\n:::\n::artifact-template{skill_name="artifact-template-report" skill_directory="C:/skills/report" display_name="Report" artifact_kind="document"}\n::page-preview{page_id="p1" block_id="b1"}';
 const parts=parseRichContent(input);assert.deepEqual(parts.filter(p=>p.type!=='markdown').map(p=>p.type),['file','file','comment','writing','task','details','template','page']);
 const file=parts.find(p=>p.type==='file');assert.equal(file?.type==='file'&&file.start,12);
 assert.equal(parts.map(p=>p.raw).join(''),input);
});
test('control and memory receipts are passive, unknown sources remain unresolved',()=>{
 const input='::git-push{branch="main"}\n<oai-mem-citation>\n<citation_entries>MEMORY.md:1-2|note=[x]</citation_entries>\n<rollout_ids></rollout_ids>\n</oai-mem-citation>\n\uE200cite\uE202turn1search0\uE201\n\uE200unknown\uE202data\uE201\nNormal \uE123 text';
 const parts=parseRichContent(input);assert.deepEqual(parts.filter(p=>p.type!=='markdown').map(p=>p.type),['receipt','receipt','fallback','fallback']);assert.ok(parts.at(-1)?.raw.includes('\uE123'));assert.equal(parts.map(p=>p.raw).join(''),input);
});
test('live and online artifact identities are never turned into local files',()=>{
 assert.equal(parseRichContent('::codex-live-vis{file="preview.html"}')[0].type,'preview');
 assert.equal(parseRichContent(':codex-file-citation{artifactRef="id" mode="live" artifact_kind="presentation"}')[0].type,'fallback');
});
test('Windows attribute paths are literal and malformed memory receipts do not hide prose',()=>{
 const parts=parseRichContent('::codex-inline-vis{path="C:\\new\\preview.html" title="A \\"quote\\""}');
 assert.equal(parts[0].type==='preview'&&parts[0].path,'C:\\new\\preview.html');
 const broken='<oai-mem-citation>\nOrdinary following paragraph.\n</oai-mem-citation>';
 assert.ok(parseRichContent(broken).some(part=>part.type==='markdown'&&part.raw.includes('Ordinary following paragraph.')));
});
test('formal quoted numeric locators and legacy memory receipt opening use verified contracts',()=>{
 const parts=parseRichContent(':codex-file-citation{path="/report.docx" purpose="output" page_number="4" line_range_start="12" line_range_end="18"}');
 assert.equal(parts[0].type,'file');assert.equal(parts[0].type==='file'&&parts[0].fields?.page_number,4);assert.equal(parts[0].type==='file'&&parts[0].start,12);
 const receipt='[oai-mem-citation]\n<citation_entries>MEMORY.md:1-2|note=[x]</citation_entries>\n<rollout_ids></rollout_ids>\n</oai-mem-citation>';
 assert.equal(parseRichContent(receipt)[0].type,'receipt');
 assert.deepEqual(parseRichContent('`'+receipt+'`'),[{type:'markdown',raw:'`'+receipt+'`'}]);
 const unverified=receipt.replace('</oai-mem-citation>','[/oai-mem-citation]')+'\nFollowing paragraph';
 assert.ok(parseRichContent(unverified).some(part=>part.type==='markdown'&&part.raw.includes('Following paragraph')));
});
test('verified private source labels remain readable without guessing any URL',()=>{
 const parts=parseRichContent('\uE200entity\uE202["company","Example Company"]\uE201\n\uE200link_title\uE202A readable source title\uE201');
 assert.equal(parts[0].type==='fallback'&&parts[0].label,'Example Company');assert.equal(parts.at(-1)?.type==='fallback'&&parts.at(-1)?.label,'A readable source title');assert.ok(!JSON.stringify(parts).includes('href'));
});
test('container closing delimiters inside fenced examples do not expose preview instructions',()=>{
 for(const fence of ['~~~','```']){
  const input=':::writing{title="Sample"}\n'+fence+'text\n:::\n'+vis({path:'preview.html'})+'\n'+fence+'\n:::\n\nAfter container';
  const parts=parseRichContent(input);assert.equal(parts[0].type,'writing');assert.equal(parts[0].type==='writing'&&parts[0].body,fence+'text\n:::\n'+vis({path:'preview.html'})+'\n'+fence+'\n');assert.equal(parts.filter(part=>part.type==='preview').length,0);assert.equal(parts.map(part=>part.raw).join(''),input);assert.ok(parts.at(-1)?.raw.includes('After container'));
 }
});
test('blockquote and list fenced or indented code preserve every literal directive',()=>{
 const citation=':codex-file-citation{path="/work/example.txt" purpose="source"}';
 for(const fence of ['~~~','```'])for(const [open,prefix,close] of [
  ['> '+fence+'text','> ','> '+fence],
  ['> > '+fence+'text','> > ','> > '+fence],
  ['- '+fence+'text','  ','  '+fence],
  ['1. '+fence+'text','   ','   '+fence],
  ['> - '+fence+'text','>   ','>   '+fence],
  ['  - '+fence+'text','    ','    '+fence],
 ]){
  const input=[open,prefix+citation,prefix+vis({path:'/work/example.html'}),close].join('\n');
  assert.deepEqual(parseRichContent(input),[{type:'markdown',raw:input}],input);
  const followed=input+'\n\n'+vis({path:'/outside.html'});assert.equal(parseRichContent(followed).filter(part=>part.type==='preview').length,1,'only the outside reference is actionable');
 }
 const indented='>     '+citation+'\n>     '+vis({path:'/example.html'});assert.deepEqual(parseRichContent(indented),[{type:'markdown',raw:indented}]);
});
test('new quote or list prefixes within code cannot impersonate a closing fence',()=>{
 for(const fence of ['~~~','```'])for(const fakeClose of ['- '+fence,'> '+fence,'1. '+fence]){
  const input=[fence+'text',fakeClose,vis({path:'/inside.html'}),fence].join('\n');assert.deepEqual(parseRichContent(input),[{type:'markdown',raw:input}]);
 }
});
test('tab-indented list fence continuations retain code protection',()=>{
 const input='- ~~~text\n\t:codex-file-citation{path="/work/example.txt" purpose="source"}\n  '+vis({path:'/inside.html'})+'\n  ~~~';assert.deepEqual(parseRichContent(input),[{type:'markdown',raw:input}]);
});
test('primary visualize requires its own paragraph rather than merely its own line',()=>{
 for(const input of ['Before\n'+vis({path:'/a.html'})+'\nAfter',vis({path:'/a.html'})+'\nAfter','Before\n'+vis({path:'/a.html'})])assert.equal(parseRichContent(input).filter(part=>part.type==='preview').length,0);
 assert.equal(parseRichContent('Before\n\n'+vis({path:'/a.html'})+'\n\nAfter').filter(part=>part.type==='preview').length,1);
});
