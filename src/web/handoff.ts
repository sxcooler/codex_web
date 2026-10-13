import {api,type Json} from './api.ts';
const operations=new Map<string,Promise<Json>>();
const written=new Set<string>();
function enqueue(id:string,work:()=>Promise<Json>):Promise<Json>{
  const previous=operations.get(id);
  const pending=(previous??Promise.resolve()).catch(()=>{}).then(work);
  operations.set(id,pending);
  void pending.finally(()=>{if(operations.get(id)===pending)operations.delete(id);}).catch(()=>{});
  return pending;
}
export function markSessionWrite(id:string){written.add(id);}
export function clearSessionWrite(id:string){written.delete(id);}
export function releaseOnLeave(id:string,force=false):Promise<Json>{
  if(!force&&!written.has(id))return Promise.resolve({});
  written.delete(id);
  return enqueue(id,()=>api('/sessions/'+id+'/release-on-leave',{},AbortSignal.timeout(30_000)));
}
export function writeSession(id:string,work:()=>Promise<Json>){
  written.add(id);
  return enqueue(id,async()=>{await api('/sessions/'+id+'/cancel-release',{},AbortSignal.timeout(30_000));return work();});
}
