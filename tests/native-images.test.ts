import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {renderNativeImage} from '../src/server/native-images.ts';

test('native previews bound noisy thumbnails, preserve raster originals, and reject unsafe inputs',async()=>{
  const bytes=await sharp(randomBytes(900*600*3),{raw:{width:900,height:600,channels:3}}).png().toBuffer();
  const thumbnail=await renderNativeImage(bytes,false),metadata=await sharp(thumbnail.bytes).metadata();
  assert.equal(thumbnail.type,'image/webp');assert.ok(thumbnail.bytes.length<=65536);
  assert.ok(metadata.width!<=384&&metadata.height!<=384);
  assert.deepEqual((await renderNativeImage(bytes,true)).bytes,bytes);
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
  assert.equal((await renderNativeImage(svg,true)).type,'image/png');
  for(const invalid of [Buffer.from('not an image'),Buffer.alloc(10*1024*1024+1),Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"/>')]){
    await assert.rejects(renderNativeImage(invalid,false),(error:any)=>error.statusCode===415);
    await assert.rejects(renderNativeImage(invalid,true),(error:any)=>error.statusCode===415);
  }
});
