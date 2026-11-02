import assert from 'node:assert/strict';
import test from 'node:test';
import {pastedMarkdown,pastedTextPreview} from '../src/web/pastedText.ts';

test('short pastes stay in the textarea and 5000 UTF-16 units become a Markdown file',async()=>{
  assert.equal(pastedMarkdown(''),null);
  assert.equal(pastedMarkdown('a'.repeat(4999)),null);
  for(const length of [5000,5001]){
    const text='a'.repeat(length),file=pastedMarkdown(text);
    assert.ok(file instanceof File);
    assert.match(file.name,/^pasted-text-.+\.md$/);
    assert.equal(file.type,'text/markdown');
    assert.equal(await file.text(),text);
    assert.equal(file.size,length);
  }
});

test('emoji count as UTF-16 pairs rather than Unicode points or UTF-8 bytes',async()=>{
  assert.equal(pastedMarkdown('😀'.repeat(2499)+'a'),null);
  const text='😀'.repeat(2500),file=pastedMarkdown(text);
  assert.ok(file);
  assert.equal(file.size,10000);
  assert.equal(await file.text(),text);
  assert.equal(pastedMarkdown('中'.repeat(4999)),null);
  assert.equal(pastedMarkdown('中'.repeat(5000))?.size,15000);
});

test('raw CRLF and whitespace count toward the threshold and survive UTF-8 output unchanged',async()=>{
  const text=' \r\n# 标题\r\n<script>window.pasted=true</script>\r\n'+'中'.repeat(4951)+' \r\n';
  assert.equal(text.length,5000);
  const file=pastedMarkdown(text);
  assert.ok(file);
  assert.equal(await file.text(),text);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()),new TextEncoder().encode(text));
  assert.equal(pastedMarkdown('a'.repeat(4998)+'\r'),null);
  assert.ok(pastedMarkdown('a'.repeat(4998)+'\r\n'));
});

test('bounded previews omit an incomplete UTF-8 character and keep the original prefix',async()=>{
  for(const [character,remainingBytes] of [['中',1],['😀',2]] as const){
    const prefix='a'.repeat(262144-remainingBytes),original=prefix+character+'tail';
    const shown=await pastedTextPreview(new File([original],'unicode.md'));
    assert.equal(shown,prefix);
    assert.ok(original.startsWith(shown));
    assert.ok(new TextEncoder().encode(shown).length<=262144);
  }
  const intact='a'.repeat(262141)+'中';
  assert.equal(await pastedTextPreview(new File([intact+'tail'],'boundary.md')),intact);
  const replacement='�'.repeat(87381)+'x';
  assert.equal(await pastedTextPreview(new File([replacement+'tail'],'replacement.md')),replacement);
  assert.equal(await pastedTextPreview(new File(['\uFEFF# title'],'bom.md')),'\uFEFF# title');
});
