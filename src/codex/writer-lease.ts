import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {isAbsolute,join} from 'node:path';

export type WriterLease={released:()=>Promise<boolean>;close:()=>Promise<void>};

// Retain the identity that was positively locked before unsubscribe. A missing
// path or ThreadClosed alone cannot prove that its writer stopped.
export async function retainWriterLease(home:string,threadId:string):Promise<WriterLease>{
 if(process.platform!=='win32'||typeof home!=='string'||!isAbsolute(home)||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId))throw Error('WRITER_CHECK_UNSUPPORTED: Windows, absolute CODEX_HOME and UUID thread identifier are required');
 const directory=join(home,'thread-writer-locks'),coordination=join(directory,'.coordination.lock');
 const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./writer-lease.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let stopped=false,closing:Promise<void>|undefined,stderr='',failure:Error|undefined;
 const waiting=new Set<ReturnType<typeof Promise.withResolvers<any>>>(),queue:ReturnType<typeof Promise.withResolvers<any>>[]=[];
 const fail=(error:Error)=>{failure??=error;stopped=true;for(const pending of waiting)pending.reject(failure);};
 const ended=new Promise<void>(resolve=>child.once('close',(code,signal)=>{
  if(!closing||code!==0)fail(Error(`Writer check exited (code ${code}, signal ${signal})${stderr?': '+stderr:''}`));
  stopped=true;for(const pending of waiting)pending.reject(failure??Error('Writer check stopped'));resolve();
 }));
 child.on('error',error=>fail(new Error(error.message.slice(0,1024),{cause:error})));
 child.stdin.on('error',error=>{fail(new Error(error.message.slice(0,1024),{cause:error}));void close().catch(()=>{});});child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(0,2048);});
 createInterface({input:child.stdout}).on('line',line=>{const pending=queue.shift();if(!pending)return;try{pending.resolve(JSON.parse(line));}catch{pending.reject(Error('WRITER_CHECK_INVALID'));}});
 const close=()=>closing??=Promise.resolve().then(async()=>{
  clearTimeout(lifetime);child.stdin.end();
  const deadline=setTimeout(()=>{failure??=Error('Writer check did not close within 1000ms');child.kill();},1000);deadline.unref();
  try{await ended;if(failure)throw failure;}finally{clearTimeout(deadline);}
 });
 const lifetime=setTimeout(()=>{void close().catch(()=>{});},15000);lifetime.unref();
 async function command(value:any){
  if(stopped||closing)throw failure??Error('WRITER_CHECK_STOPPED');
  const pending=Promise.withResolvers<any>();waiting.add(pending);queue.push(pending);
  const timer=setTimeout(()=>{pending.reject(Error('Writer check did not respond within 3000ms'));void close().catch(()=>{});},3000);timer.unref();
  child.stdin.write(JSON.stringify(value)+'\n');
  try{const result=await pending.promise;if(result?.error){const details=result.error;throw Object.assign(new Error(String(details.message??'Writer check failed').slice(0,1024),{cause:details}),{name:String(details.type??'WriterCheckError'),win32Error:details.win32Error});}return result;}finally{clearTimeout(timer);waiting.delete(pending);}
 }
 try{
  const retained=await command({action:'retain',key:'thread',path:join(directory,threadId+'.lock')});
  const held=await command({action:'probe',key:'thread',coordination});
  if(retained.retained!==true||held.coordinationLocked!==true||held.sameIdentity!==true||held.lockError!==33||held.currentLockError!==33)throw Object.assign(Error('Writer lock could not be confirmed held'),{code:'WRITER_CHECK_NOT_HELD',cause:held});
  return {released:async()=>{
   const result=await command({action:'probe',key:'thread',coordination});
   const win32Error=result.coordinationError??result.lockError;
   if(win32Error!==undefined&&win32Error!==0&&win32Error!==33)throw Object.assign(Error(`Writer lock probe failed (Windows error ${win32Error})`),{win32Error});
   return result.coordinationLocked===true&&result.positiveReleased===true&&result.lockError===0&&(!result.pathPresent||result.sameIdentity===true);
  },close};
 }catch(error){
  try{await close();}catch(cleanup){const original=error instanceof Error?error:Error(String(error)),closingError=cleanup instanceof Error?cleanup:Error(String(cleanup));throw Object.assign(new Error(`${original.message.slice(0,1024)}; helper cleanup: ${closingError.message.slice(0,1024)}`,{cause:new AggregateError([original,closingError])}),{name:original.name,win32Error:(original as any).win32Error});}
  throw error;
 }
}
