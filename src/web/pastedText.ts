export function pastedMarkdown(text:string):File|null {
  return text.length>=5000?new File([text],`pasted-text-${Date.now()}.md`,{type:'text/markdown'}):null;
}

export async function pastedTextPreview(file:Blob):Promise<string>{
  // A streaming decode omits an incomplete character at the byte limit; preserve any original BOM.
  return new TextDecoder('utf-8',{ignoreBOM:true}).decode(await file.slice(0,256*1024).arrayBuffer(),{stream:true});
}
