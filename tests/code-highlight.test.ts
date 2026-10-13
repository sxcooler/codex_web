import test from 'node:test';
import assert from 'node:assert/strict';
import type {CodeHighlighterPlugin} from 'streamdown';
import {checkedHighlighter,type HighlightResult} from '../src/web/codeHighlight.ts';

const source=(result:HighlightResult)=>result.tokens.map(line=>line.map(token=>token.content).join('')).join('\n');
const plugin=(highlight:CodeHighlighterPlugin['highlight']):CodeHighlighterPlugin=>({name:'shiki',type:'code-highlighter',highlight,getSupportedLanguages:()=>['javascript'],getThemes:()=>['github-dark','github-dark'],supportsLanguage:()=>true});
const options=(code:string)=>({code,language:'javascript' as const,themes:['github-dark','github-dark'] as ['github-dark','github-dark']});

test('same-edge upstream cache collision falls back to the complete requested source',()=>{
 const first='//'+ 'a'.repeat(110)+'\nconst value = 1;\n//'+ 'z'.repeat(110),second=first.replace('= 1','= 2');
 assert.equal(first.length,second.length);assert.equal(first.slice(0,100),second.slice(0,100));assert.equal(first.slice(-100),second.slice(-100));
 const cached:HighlightResult={tokens:first.split('\n').map(content=>[{content,color:'#f00'}])};
 const native=plugin(()=>cached);assert.equal(source(native.highlight(options(second))!),first);
 const result=checkedHighlighter(native).highlight(options(second))!;
 assert.equal(source(result),second);assert.equal(result.tokens.some(line=>line.some(token=>token.color)),false);
});

test('callback mismatch preserves whitespace, CR and trailing empty lines',()=>{
 const requested=' \tconst answer = 2;\r\n\r\n\n';let emit:((result:HighlightResult)=>void)|undefined,received:HighlightResult|undefined;
 const checked=checkedHighlighter(plugin((_options,callback)=>{emit=callback;return null;}));
 assert.equal(checked.highlight(options(requested),result=>received=result),null);
 emit!({tokens:[[{content:'const answer = 1;'}]]});
 assert.equal(source(received!),requested);assert.equal(received!.tokens.length,4);
});

test('exact synchronous and callback tokens retain their syntax colors',()=>{
 const correct:HighlightResult={tokens:[[{content:'const answer = 42;',color:'#79b8ff'}],[]]};let callbackResult:HighlightResult|undefined;
 const checked=checkedHighlighter(plugin((_options,callback)=>{callback?.(correct);return correct;}));
 assert.equal(checked.highlight(options('const answer = 42;\n'),result=>callbackResult=result),correct);
 assert.equal(callbackResult,correct);
});
