import test from 'node:test';
import assert from 'node:assert/strict';

test('instruction comparison preserves changed lines, line numbers and bounded large-input fallback',async()=>{
 const module=await import('../src/web/textDiff.ts').catch(()=>({textDiff:undefined}));assert.equal(typeof module.textDiff,'function');
 const diff=module.textDiff!('same\r\nold\r\nlast','same\nnew\nlast');
 assert.deepEqual(diff.hunks[0].lines.map(line=>[line.kind,line.text,line.oldLine,line.newLine]),[['context','same',1,1],['delete','old',2,undefined],['add','new',undefined,2],['context','last',3,3]]);
 assert.equal(module.textDiff!('same','same').hunks.length,0);
 assert.deepEqual(module.textDiff!('','new').hunks[0].lines,[{kind:'add',text:'new',newLine:1}]);
 const large=module.textDiff!(Array(1000).fill('old').join('\n'),Array(1000).fill('new').join('\n'));assert.equal(large.simplified,true);assert.equal(large.hunks[0].lines.length,2000);
 const capped=module.textDiff!('a\n'.repeat(30000),'b\n'.repeat(30000));assert.equal(capped.truncated,true);assert.ok(capped.hunks[0].lines.length<=4000);
 const crOnly=module.textDiff!('a\r'.repeat(3000),'b\r'.repeat(3000));assert.equal(crOnly.truncated,true);assert.ok(crOnly.hunks[0].lines.length<=4000);
 const crlf=module.textDiff!('a\r\n'.repeat(1000),'b\r\n'.repeat(1000));assert.equal(crlf.truncated,false);
});
