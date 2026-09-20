export type Json=Record<string,any>;
let token='';
export const setCsrfToken=(value:string)=>{token=value;};
export async function api(path:string,payload?:unknown,signal?:AbortSignal):Promise<any>{
  let response:Response|undefined,data:any;
  try{response=await fetch('/api'+path,{credentials:'same-origin',signal,...(payload===undefined?{}:{method:'POST',headers:{'x-csrf-token':token,...(payload instanceof FormData?{}:{'content-type':'application/json'})},body:payload instanceof FormData?payload:JSON.stringify(payload)})});data=await response.json();}
  catch(error){
    if(signal?.aborted&&signal.reason?.name==='TimeoutError')throw new Error(payload===undefined?'读取超时，未能在限定时间内取得完整响应，请重试。':'等待服务器响应超时，提交结果待核实。请先核对历史，不要重复发送。');
    if(response||signal?.aborted)throw error;
    throw new Error(payload===undefined?'无法连接服务器，请检查网络并确认开发机和服务在线。':'连接中断，提交结果待核实。请先核对历史，不要重复发送。');
  }
  if(!response.ok){if(response.status===401&&!path.startsWith('/auth/'))window.dispatchEvent(new Event('auth-lost'));throw Object.assign(new Error(data.error??`请求失败 (${response.status})`),{data,status:response.status});}
  return data;
}
