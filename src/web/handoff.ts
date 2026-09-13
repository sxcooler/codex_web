import {api,type Json} from './api.ts';
const operations=new Map<string,Promise<Json>>();
function enqueue(id:string,work:()=>Promise<Json>):Promise<Json>{
  const previous=operations.get(id);
  const pending=(previous??Promise.resolve()).catch(()=>{}).then(work);
  operations.set(id,pending);
  void pending.finally(()=>{if(operations.get(id)===pending)operations.delete(id);}).catch(()=>{});
  return pending;
}
export function releaseOnLeave(id:string){
  return enqueue(id,()=>api('/sessions/'+id+'/release-on-leave',{}));
}
export function cancelReleaseOnReturn(id:string,current:()=>boolean){
  return enqueue(id,()=>current()?api('/sessions/'+id+'/cancel-release',{}):Promise.resolve({}));
}
