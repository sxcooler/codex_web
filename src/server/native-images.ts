import sharp from 'sharp';

const invalid=()=>Object.assign(new Error('图片损坏、格式不支持或超过 10 MiB / 4000 万像素限制。'),{code:'RUNTIME_INVALID_IMAGE',statusCode:415});

export async function renderNativeImage(bytes:Buffer,original:boolean):Promise<{bytes:Buffer;type:string}>{
  if(bytes.length>10*1024*1024)throw invalid();
  try{
    const image=sharp(bytes,{limitInputPixels:40_000_000,failOn:'error'}),metadata=await image.metadata();
    if(!metadata.width||!metadata.height||metadata.width*metadata.height>40_000_000)throw invalid();
    const types:Record<string,string>={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif'};
    if(original&&types[metadata.format??''])return {bytes,type:types[metadata.format!]};
    // SVG is always rasterized; never serve executable image source.
    if(!['png','jpeg','webp','gif','avif','heif','svg'].includes(metadata.format??''))throw invalid();
    if(original)return {bytes:await image.rotate().png().toBuffer(),type:'image/png'};
    let thumbnail=await image.rotate().resize({width:384,height:384,fit:'inside',withoutEnlargement:true}).webp({quality:55}).toBuffer();
    if(thumbnail.length>65536)thumbnail=await sharp(thumbnail).resize({width:192,height:192,fit:'inside'}).webp({quality:35}).toBuffer();
    if(thumbnail.length>65536)throw invalid();
    return {bytes:thumbnail,type:'image/webp'};
  }catch{throw invalid();}
}
