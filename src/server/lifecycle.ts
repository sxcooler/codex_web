import {appendFileSync,mkdirSync,readdirSync,renameSync,statSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';

type Fields={reason?:string;port?:number;controlPort?:number;signal?:string;diagnosticsEnabled?:boolean;exitCode?:number;origin?:string};
const FILE_BYTES=1048576;

function text(value:unknown,limit:number){
 if(typeof value!=='string')return undefined;
 // shortcut: known credential patterns only; arbitrary free text and Node stderr are not fully sanitized.
 const safe=value.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi,'[redacted]')
  .replace(/["']?\b(?:[\w-]*token|authorization|proxy-authorization|cookie|set-cookie|credentials?|password|api[_-]?key|secret)["']?\s*[:=]\s*[^\r\n]*/gi,'[redacted]')
  .replace(/(https?:\/\/)[^/\s@]+@/gi,'$1[redacted]@');
 if(safe.length<=limit)return safe;
 const half=Math.floor((limit-15)/2);return safe.slice(0,half)+'\n[truncated]\n'+safe.slice(-half);
}
export {text as redactLifecycleText};

// Fatal and exit hooks cannot await diagnostics; local evidence must survive Node's default fatal exit.
export class Lifecycle {
 port?:number;
 private directory:string;
 private diagnosticsEnabled:boolean;
 constructor(directory:string,diagnosticsEnabled=false){
  this.diagnosticsEnabled=diagnosticsEnabled;
  this.directory=directory;
  const reports=join(directory,'crash-reports');
  const nativePrivacy=process.execArgv.includes('--report-exclude-env')&&process.execArgv.includes('--report-exclude-network')&&process.report.excludeEnv&&process.report.excludeNetwork;
  process.report.directory=reports;
  process.report.filename='';
  process.report.excludeEnv=true;
  process.report.excludeNetwork=true;
  // Native OOM reports require startup flags; runtime excludeEnv only protects JS writeReport.
  process.report.reportOnFatalError=nativePrivacy;
  // JS errors use a sanitized Error below; automatic uncaught reports would retain the original.
  process.report.reportOnUncaughtException=false;
  try{
   mkdirSync(reports,{recursive:true,mode:0o700});
   const files=readdirSync(reports,{withFileTypes:true}).filter(file=>file.isFile()&&/^report\..*\.json$/.test(file.name))
    .map(file=>{const path=join(reports,file.name);return {path,mtime:statSync(path).mtimeMs};})
    .sort((a,b)=>b.mtime-a.mtime||b.path.localeCompare(a.path));
   for(const file of files.slice(5))unlinkSync(file.path);
  }catch{/* Report retention failure must not stop the service. */}
  process.on('uncaughtExceptionMonitor',(error,origin)=>{
   this.record('fatal',{reason:'uncaught_exception',origin},error);
   try{
    const safe=new Error(text(error.message,2048));
    safe.name=text(error.name,128)??'Error';safe.stack=text(error.stack,8192)??safe.stack;
    process.report.writeReport(undefined,safe);
   }catch{/* Reporting failure must preserve Node's default fatal exit. */}
  });
  process.once('exit',exitCode=>this.record('exit',{reason:'node_exit',exitCode}));
 }
 record(event:string,fields:Fields={},error?:unknown){
  Lifecycle.record(this.directory,event,{port:this.port,diagnosticsEnabled:this.diagnosticsEnabled,...fields},error);
 }
 static record(directory:string,event:string,fields:Fields={},error?:unknown){
  try{
   const file=join(directory,'lifecycle.jsonl');
   let exception={};
   try{const value=error as Error&{code?:unknown},code=value?.code;exception=error===undefined?{}:{name:text(value?.name,128),code:typeof code==='number'&&Number.isSafeInteger(code)?code:typeof code==='string'&&/^[A-Z0-9_]{1,64}$/.test(code)?code:undefined,message:text(typeof error==='string'?error:value?.message,2048),stack:text(value?.stack,8192)};}catch{/* Unreadable error fields cannot change the exit. */}
   const line=JSON.stringify({time:new Date().toISOString(),event,pid:process.pid,parentPid:process.ppid,...fields,...exception})+'\n';
   mkdirSync(dirname(file),{recursive:true,mode:0o700});
   let size=0;try{size=statSync(file).size;}catch(error:any){if(error.code!=='ENOENT')throw error;}
   if(size+Buffer.byteLength(line)>FILE_BYTES)renameSync(file,file+'.1');
   appendFileSync(file,line,{mode:0o600});
  }catch{/* Logging failure must preserve shutdown and Node's fatal behavior. */}
 }
}
