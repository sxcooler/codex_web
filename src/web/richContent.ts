type Fields=Record<string,string|number|boolean>;
type Base={raw:string};
export type RichPart=Base&(
 |{type:'markdown'}
 |{type:'preview';path:string;title?:string;mode?:string;live?:boolean}
 |{type:'file';path:string;title?:string;purpose?:string;start?:number;end?:number;fields?:Fields}
 |{type:'comment';title:string;body:string;path:string;start?:number;end?:number;priority?:number;confidence?:number}
 |{type:'writing'|'task';title:string;body:string;fields:Fields}
 |{type:'details';title:string;body:string;open:boolean}
 |{type:'template'|'page';fields:Fields}
 |{type:'receipt';name:string}
 |{type:'fallback';name:string;label?:string;reason:'invalid'|'unsupported'|'unresolved'|'pending'});
const bytes=(value:string)=>new TextEncoder().encode(value).length;
const string=(value:unknown):value is string=>typeof value==='string';
const pathValid=(path:unknown):path is string=>string(path)&&!!path.trim()&&bytes(path)<=4096&&!/[\x00-\x1f\x7f]/.test(path)&&!/^[/\\]{2}/.test(path)&&!(/^[a-z][a-z\d+.-]*:/i.test(path)&&!/^[a-z]:[\\/]/i.test(path));
const titleValid=(title:unknown)=>title===undefined||string(title)&&Array.from(title).length<=200;
const positive=(value:unknown)=>value===undefined||typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const controls=new Set(['inbox-item','archive-thread','thread-purpose-changed','created-thread','git-stage','git-commit','git-create-branch','git-push','git-create-pr','pr-auto-fix-progress']);
function attributes(source:string):Fields|null{
 if(bytes(source)>8192)return null;
 const result:Fields=Object.create(null);let rest=source;
 while(rest.trim()){
  const match=/^\s*([\w-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s{}]+)(?=\s|$)/.exec(rest);if(!match||Object.hasOwn(result,match[1]))return null;
  const value=match[2];result[match[1]]=value.startsWith('"')||value.startsWith("'")?value.slice(1,-1).replace(/\\([\\"'])/g,'$1'):/^-?\d+(?:\.\d+)?$/.test(value)?Number(value):value;
  rest=rest.slice(match[0].length);
 }
 return result;
}
function directive(name:string,fields:Fields|null,raw:string,body?:string):RichPart{
 const fail=(reason:'invalid'|'unsupported'|'unresolved'='invalid'):RichPart=>({type:'fallback',name,reason,raw});
 if(!fields||Object.values(fields).some(v=>string(v)&&v.includes('\0')))return fail();
 for(const key of ['line_range_start','line_range_end','page_number','start','end','priority','confidence'])if(string(fields[key])&&/^-?\d+(?:\.\d+)?$/.test(fields[key] as string))fields[key]=Number(fields[key]);
 const title=fields.title;if(!titleValid(title))return fail();
 if(name==='visualize'||name==='codex-inline-vis'||name==='codex-live-vis'){
  const path=fields.path??(name!=='visualize'?fields.file:undefined);
  if(!pathValid(path)||fields.mode!==undefined&&fields.mode!=='wide')return fail();
  return {type:'preview',raw,path,title:title as string|undefined,mode:fields.mode as string|undefined,live:name==='codex-live-vis'};
 }
 if(name==='codex-file-citation'){
  if(fields.mode==='live'||fields.artifactRef)return fail('unsupported');
  if(!pathValid(fields.path)||!['source','output'].includes(String(fields.purpose)))return fail();
  for(const key of ['line_range_start','line_range_end','page_number'])if(!positive(fields[key]))return fail();
  if(fields.line_range_end!==undefined&&Number(fields.line_range_end)<Number(fields.line_range_start??1))return fail();
  return {type:'file',raw,path:fields.path,title:title as string|undefined,purpose:String(fields.purpose),start:fields.line_range_start as number|undefined,end:fields.line_range_end as number|undefined,fields};
 }
 if(name==='code-comment'){
  if(!string(title)||!title.trim()||!string(fields.body)||!fields.body.trim()||!pathValid(fields.file)||!positive(fields.start)||!positive(fields.end)||fields.end!==undefined&&Number(fields.end)<Number(fields.start??1))return fail();
  if(fields.priority!==undefined&&(!Number.isInteger(fields.priority)||Number(fields.priority)<0||Number(fields.priority)>3)||fields.confidence!==undefined&&(typeof fields.confidence!=='number'||fields.confidence<0||fields.confidence>1))return fail();
  return {type:'comment',raw,title,body:fields.body,path:fields.file,start:fields.start as number|undefined,end:fields.end as number|undefined,priority:fields.priority as number|undefined,confidence:fields.confidence as number|undefined};
 }
 if(name==='writing'||name==='task-stub')return body===undefined?fail():{type:name==='writing'?'writing':'task',raw,title:string(title)?title:'',body,fields};
 if(name==='github-details')return body===undefined||!titleValid(fields.summary)?fail():{type:'details',raw,title:string(fields.summary)?fields.summary:'',body,open:fields.open==='true'};
 if(name==='artifact-template'){
  if(!string(fields.skill_name)||!fields.skill_name.startsWith('artifact-template-')||!pathValid(fields.skill_directory)||!/^([a-z]:[\\/]|\/)/i.test(fields.skill_directory)||!string(fields.display_name)||!titleValid(fields.display_name)||!['document','spreadsheet','presentation','image'].includes(String(fields.artifact_kind))||fields.artifact_kind==='image'&&!string(fields.gallery_kind))return fail();
  return {type:'template',raw,fields};
 }
 if(name==='page-preview')return string(fields.page_id)&&!!fields.page_id&&(!fields.block_id||string(fields.block_id))?{type:'page',raw,fields}:fail();
 if(controls.has(name))return {type:'receipt',raw,name};
 return fail('unsupported');
}

function codeLine(line:string):{content:string;containers:('quote'|number)[]}{
 let content=line;const containers:('quote'|number)[]=[];
 while(true){
  const quote=/^ {0,3}>[ \t]?/.exec(content);if(quote){containers.push('quote');content=content.slice(quote[0].length);continue;}
  const list=/^ {0,3}(?:[-+*]|\d{1,9}[.)])([ \t]+)/.exec(content);
  if(list){const width=list[0].length-(list[1].length>4?list[1].length-1:0);containers.push(width);content=content.slice(width);continue;}
  break;
 }
 return {content,containers};
}
type Fence={mark:string;containers:('quote'|number)[]}|null;
function fenceLine(line:string,fence:Fence):{fence:Fence;protected:boolean}{
 let column=0;line=line.replace(/\t|[^\t]+/g,part=>{if(part==='\t'){const width=4-column%4;column+=width;return ' '.repeat(width);}column+=part.length;return part;});
 let content=line;
 if(fence){
  if(!line.trim())return {fence,protected:true};
  for(const container of fence.containers){
   const prefix=container==='quote'?/^ {0,3}>[ \t]?/.exec(content)?.[0]:/^ */.exec(content)![0].length>=container?' '.repeat(container):undefined;
   if(prefix===undefined)return fenceLine(line,null);
   content=content.slice(prefix.length);
  }
  const match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
  return {fence:match&&match[1][0]===fence.mark[0]&&match[1].length>=fence.mark.length&&!match[2].trim()?null:fence,protected:true};
 }
 const normalized=codeLine(line),match=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(normalized.content);
 if(/^(?: {4}|\t)/.test(normalized.content))return {fence:null,protected:true};
 if(match&&!(match[1][0]==='`'&&match[2].includes('`')))return {fence:{mark:match[1],containers:normalized.containers},protected:true};
 return {fence:null,protected:false};
}
function containerEnd(text:string,start:number):{start:number;end:number}|null{
 let cursor=start,fence:Fence=null;
 while(cursor<text.length){
  const newline=text.indexOf('\n',cursor),end=newline<0?text.length:newline,line=text.slice(cursor,end),code=fenceLine(line,fence);fence=code.fence;
  if(!code.protected&&/^ {0,3}:::\s*$/.test(line))return {start:cursor,end};
  cursor=end+(newline>=0?1:0);
 }
 return null;
}

export function parseRichContent(text:string,streaming=false):RichPart[]{
 const parts:RichPart[]=[];
 const push=(part:RichPart)=>{const last=parts.at(-1);if(part.type==='markdown'&&last?.type==='markdown')last.raw+=part.raw;else parts.push(part);};
 // Code is scanned before directives, so examples never gain host capabilities.
 let cursor=0,inline=0;let fence:Fence=null;
 while(cursor<text.length){
  const start=cursor===0||text[cursor-1]==='\n',lineEnd=text.indexOf('\n',cursor),end=lineEnd<0?text.length:lineEnd;
  if(start){
   const line=text.slice(cursor,end),code=fenceLine(line,fence);fence=code.fence;
   if(code.protected){push({type:'markdown',raw:text.slice(cursor,end+(lineEnd>=0?1:0))});cursor=end+(lineEnd>=0?1:0);continue;}
   if(!inline){
    const dm=/^ {0,3}(:{1,3})([\w-]+)\{(.*)\}\s*$/.exec(line);
    if(dm){
     let finish=end,body:string|undefined;
     if(dm[1]===':::'){
      const close=containerEnd(text,end+1);
      if(close){body=text.slice(end+1,close.start);finish=close.end;}
      else{push({type:'fallback',raw:line,name:dm[2],reason:streaming?'pending':'invalid'});cursor=end;continue;}
     }
     push(directive(dm[2],attributes(dm[3]),text.slice(cursor,finish),body));cursor=finish;continue;
    }
    if(/^ {0,3}:{1,3}[\w-]+\{/.test(line)){push({type:'fallback',raw:line,name:'directive',reason:streaming?'pending':'invalid'});cursor=end;continue;}
   }
  }
  if(text[cursor]==='\\'&&cursor+1<text.length){push({type:'markdown',raw:text.slice(cursor,cursor+2)});cursor+=2;continue;}
  if(text[cursor]==='`'){
   const run=/^`+/.exec(text.slice(cursor))![0];if(!inline)inline=run.length;else if(inline===run.length)inline=0;
   push({type:'markdown',raw:run});cursor+=run.length;continue;
  }
  if(!inline){
   const legacy=/^【([^\n]+?)†L([1-9]\d*)(?:-L?([1-9]\d*))?】/.exec(text.slice(cursor));
   if(legacy){const raw=legacy[0],start=Number(legacy[2]),end=legacy[3]?Number(legacy[3]):undefined;push(pathValid(legacy[1])&&Number.isSafeInteger(start)&&(!end||Number.isSafeInteger(end)&&end>=start)?{type:'file',raw,path:legacy[1],start,end}:{type:'fallback',raw,name:'file',reason:'invalid'});cursor+=raw.length;continue;}
   const file=/^:codex-file-citation\{([^\n]*?)\}/.exec(text.slice(cursor));
   if(file){push(directive('codex-file-citation',attributes(file[1]),file[0]));cursor+=file[0].length;continue;}
   const receipt=/^(<oai-mem-citation>|\[oai-mem-citation\])/.exec(text.slice(cursor));
   if(receipt){
    const close='</oai-mem-citation>',finish=text.indexOf(close,cursor+receipt[0].length),raw=finish>=0?text.slice(cursor,finish+close.length):text.slice(cursor,end);
    const inner=finish>=0?text.slice(cursor+receipt[0].length,finish):'';
    const valid=finish>=0&&bytes(raw)<=8192&&/^\s*<citation_entries>[^<>]*<\/citation_entries>\s*<rollout_ids>[^<>]*<\/rollout_ids>\s*$/.test(inner);
    const displayed=valid?raw:text.slice(cursor,end);
    push(valid?{type:'receipt',raw:displayed,name:'memory'}:{type:'fallback',raw:displayed,name:'memory',reason:streaming&&finish<0?'pending':'invalid'});cursor+=displayed.length;continue;
   }
   if(text[cursor]==='\uE200'){
    const finish=text.indexOf('\uE201',cursor+1),sameLine=finish>=0&&finish<end,raw=text.slice(cursor,sameLine?finish+1:end),match=/^\uE200([^\uE202\uE201]+)(?:\uE202([\s\S]*))?\uE201$/.exec(raw);
    if(match&&match[1]==='visualize'){
     const lineStart=text.lastIndexOf('\n',cursor-1)+1,prefix=text.slice(lineStart,cursor),suffix=text.slice(finish+1,end);
     const beforeBlank=lineStart===0||!text.slice(text.lastIndexOf('\n',lineStart-2)+1,lineStart-1).trim();
     const nextEnd=text.indexOf('\n',end+1),afterBlank=end===text.length||!text.slice(end+1,nextEnd<0?text.length:nextEnd).trim();let fields:Fields|null=null;
     try{const payload=match[2]??'';if(bytes(payload)<=8192){const parsed=JSON.parse(payload);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))fields=parsed;}}catch{}
     push(prefix.trim()||suffix.trim()||!beforeBlank||!afterBlank?{type:'fallback',raw,name:match[1],reason:'invalid'}:directive(match[1],fields,raw));
    }else{
     let label:string|undefined;const payload=match?.[2]??'';
     if(match&&bytes(payload)<=8192){
      if(match[1]==='link_title'&&titleValid(payload))label=payload;
      if(match[1]==='entity')try{const entity=JSON.parse(payload);if(Array.isArray(entity)&&string(entity[0])&&string(entity[1])&&titleValid(entity[1]))label=entity[1];}catch{}
     }
     push({type:'fallback',raw,name:match?.[1]??'marker',...(label?{label}:{}),reason:sameLine?'unresolved':streaming?'pending':'invalid'});
    }
    cursor+=raw.length;continue;
   }
  }
  push({type:'markdown',raw:text[cursor]});cursor++;
 }
 return parts.length?parts:[{type:'markdown',raw:''}];
}

export type ToolPart={type:'text'|'structured'|'audio'|'resource'|'widget'|'image'|'unsupported';text?:string;name?:string;mime?:string;src?:string;truncated?:boolean};
const record=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const bounded=(value:unknown,max=12000)=>{const text=string(value)?value:'';return {text:text.slice(0,max),truncated:text.length>max};};
function audioSource(value:unknown,mime?:unknown):{src:string;mime:string}|null{
 const data=string(value)?value:'',source=string(mime)?'data:'+mime+';base64,'+data:data;
 if(source.length>14_000_000)return null;
 const match=/^data:(audio\/(?:wav|x-wav|mpeg|ogg|webm|mp4|flac));base64,([a-z\d+/]*={0,2})$/i.exec(source);
 if(!match||!match[2]||match[2].length%4||match[2].length/4*3>10*1024*1024)return null;
 let head:string;try{head=atob(match[2].slice(0,64));}catch{return null;}
 const type=match[1].toLowerCase(),valid=type.includes('wav')?head.startsWith('RIFF')&&head.slice(8,12)==='WAVE':type==='audio/ogg'?head.startsWith('OggS'):type==='audio/flac'?head.startsWith('fLaC'):type==='audio/webm'?head.startsWith('\x1a\x45\xdf\xa3'):type==='audio/mp4'?head.slice(4,8)==='ftyp':head.startsWith('ID3')||head.charCodeAt(0)===255&&(head.charCodeAt(1)&224)===224;
 return valid?{src:source,mime:type}:null;
}
export function toolContentParts(value:unknown):ToolPart[]{
 const item=record(value),mcp=item.type==='mcpToolCall',dynamic=item.type==='dynamicToolCall',compat=item.type==='functionCallOutput';
 if(!mcp&&!dynamic&&!compat)return [];
 const parts:ToolPart[]=[],result=record(item.result),content=mcp?result.content:dynamic?item.contentItems:item.output;
 if(string(content))parts.push({type:'text',...bounded(content)});
 if(Array.isArray(content))for(const entry of content.slice(0,100)){
  const c=record(entry),type=c.type;
  if(type===(mcp?'text':dynamic?'inputText':'input_text')&&string(c.text))parts.push({type:'text',...bounded(c.text)});
  else if(type===(mcp?'audio':dynamic?'inputAudio':'input_audio')){const audio=audioSource(mcp?c.data:dynamic?c.audioUrl:c.audio_url,mcp?c.mimeType:undefined);parts.push(audio?{type:'audio',...audio}:{type:'unsupported',name:'audio'});}
  else if(type===(mcp?'image':dynamic?'inputImage':'input_image'))parts.push({type:'image',name:c.file_id?'file_id':undefined});
  else if(mcp&&(type==='resource_link'||type==='resource')){const resource=type==='resource'?record(c.resource):c;parts.push({type:'resource',name:String(resource.name??resource.uri??'resource').slice(0,4096),mime:string(resource.mimeType)?resource.mimeType.slice(0,200):undefined,...bounded(resource.text)});}
  else parts.push({type:'unsupported',name:string(type)?type.slice(0,200):'unknown'});
 }
 if(Array.isArray(content)&&content.length>100)parts.push({type:'unsupported',name:'content limit',truncated:true});
 if(mcp&&result.structuredContent!==undefined&&result.structuredContent!==null){let remaining=12000;const seen=new WeakSet<object>();let text='';try{text=JSON.stringify(result.structuredContent,(_key,value)=>{if(remaining<=0)return '[…]';remaining-=16;if(string(value)){const result=value.slice(0,Math.max(0,remaining));remaining-=value.length;return result;}if(value&&typeof value==='object'){if(seen.has(value))return '[circular]';seen.add(value);if(Array.isArray(value))return value.slice(0,100);return Object.fromEntries(Object.entries(value).slice(0,100));}return value;},2)??'';}catch{text='[unavailable]';}parts.push({type:'structured',...bounded(text),truncated:remaining<=0||text.length>12000});}
 const widget=mcp?(record(item.mcpAppUi).resourceUri??item.mcpAppResourceUri):undefined;
 if(widget)parts.push({type:'widget',name:String(widget).slice(0,4096)});
 return parts;
}
