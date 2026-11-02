import test from 'node:test';
import assert from 'node:assert/strict';
import {toolContentParts} from '../src/web/richContent.ts';

test('absent structured MCP data does not create an empty result panel',()=>{
 assert.deepEqual(toolContentParts({type:'mcpToolCall',result:{content:[],structuredContent:null}}),[]);
});
test('separates MCP, dynamic and compatibility fields without executing tool text',()=>{
 for(const item of [{type:'mcpToolCall',result:{content:[{type:'text',text:'\uE200visualize\uE202{}\uE201'}],structuredContent:{ok:true}}},{type:'dynamicToolCall',contentItems:[{type:'inputText',text:'hello'}]},{type:'functionCallOutput',output:[{type:'input_text',text:'hello'}]},{type:'functionCallOutput',output:'hello'}])assert.equal(toolContentParts(item)[0].type,'text');
 assert.deepEqual(toolContentParts({type:'dynamicToolCall',contentItems:[{type:'input_text',text:'wrong protocol'}]}).map(p=>p.type),['unsupported']);
});
test('only bounded base64 audio with verified MIME is playable',()=>{
 const wav='UklGRgQAAABXQVZF';
 for(const item of [{type:'mcpToolCall',result:{content:[{type:'audio',data:wav,mimeType:'audio/wav'}]}},{type:'dynamicToolCall',contentItems:[{type:'inputAudio',audioUrl:'data:audio/wav;base64,'+wav}]},{type:'functionCallOutput',output:[{type:'input_audio',audio_url:'data:audio/wav;base64,'+wav}]}])assert.equal(toolContentParts(item)[0].type,'audio');
 for(const source of ['https://evil.test/a.wav','data:text/html;base64,'+wav,'data:audio/mpeg;base64,'+wav,'data:audio/wav;base64,invalid','data:audio/wav;base64,'+'A'.repeat(15_000_000)])assert.equal(toolContentParts({type:'dynamicToolCall',contentItems:[{type:'inputAudio',audioUrl:source}]})[0].type,'unsupported');
});
test('resource and widget identities have explicit host fallback, images remain delegated',()=>{
 const parts=toolContentParts({type:'mcpToolCall',mcpAppUi:{resourceUri:'ui://widget'},result:{content:[{type:'resource_link',uri:'ui://a',name:'A'},{type:'resource',resource:{uri:'id',text:'Readable'}},{type:'image',data:'abc',mimeType:'image/png'}]}});
 assert.deepEqual(parts.map(p=>p.type),['resource','resource','image','widget']);assert.ok(!JSON.stringify(parts).includes('href'));
 assert.equal(toolContentParts({type:'mcpToolCall',mcpAppResourceUri:'ui://old'})[0].type,'widget');
});
test('text, structured values and old or unknown history remain bounded',()=>{
 const parts=toolContentParts({type:'mcpToolCall',result:{content:[{type:'text',text:'a'.repeat(100_000)},null,{type:'mystery'}],structuredContent:{big:'x'.repeat(100_000)}}});
 assert.ok(JSON.stringify(parts).length<40_000);assert.ok(parts.some(p=>p.truncated));assert.ok(parts.some(p=>p.type==='unsupported'));
 assert.deepEqual(toolContentParts({type:'mcpToolCall'}),[]);
});
