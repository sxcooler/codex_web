type Line={kind:'context'|'add'|'delete';text:string;oldLine?:number;newLine?:number};
export function textDiff(before:string,after:string){
 // ponytail: at most 250k LCS cells and 4k rendered lines; large edits use a linear replacement, not another diff engine.
 const newline=/\r\n|\r|\n/;
 const read=(text:string)=>text===''?[]:text.slice(0,524288).split(newline,2001).slice(0,2000);
 const old=read(before),next=read(after),truncated=before.length>524288||after.length>524288||before.split(newline,2001).length>2000||after.split(newline,2001).length>2000;
 if(before===after)return {binary:false,truncated,simplified:false,hunks:[] as {oldStart:number;newStart:number;oldLines:number;newLines:number;lines:Line[]}[]};
 let start=0,end=0;while(start<old.length&&start<next.length&&old[start]===next[start])start++;
 while(end<old.length-start&&end<next.length-start&&old[old.length-1-end]===next[next.length-1-end])end++;
 const a=old.slice(start,old.length-end),b=next.slice(start,next.length-end),lines:Line[]=[];let oldLine=1,newLine=1;
 const emit=(kind:Line['kind'],text:string)=>lines.push({kind,text,...(kind!=='add'?{oldLine:oldLine++}:{}),...(kind!=='delete'?{newLine:newLine++}:{})});
 for(let i=0;i<start;i++)emit('context',old[i]);
 const simplified=(a.length+1)*(b.length+1)>250000;
 if(simplified){for(const text of a)emit('delete',text);for(const text of b)emit('add',text);}
 else{
  const width=b.length+1,table=new Uint16Array((a.length+1)*width);
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i*width+j]=a[i]===b[j]?table[(i+1)*width+j+1]+1:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
  let i=0,j=0;while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){emit('context',a[i++]);j++;}else if(i<a.length&&(j===b.length||table[(i+1)*width+j]>=table[i*width+j+1]))emit('delete',a[i++]);else emit('add',b[j++]);}
 }
 for(let i=old.length-end;i<old.length;i++)emit('context',old[i]);
 return {binary:false,truncated,simplified,hunks:[{oldStart:1,newStart:1,oldLines:old.length,newLines:next.length,lines}]};
}
