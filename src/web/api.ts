export type Json=Record<string,any>;
let token='';
export const setCsrfToken=(value:string)=>{token=value;};
export async function api(path:string,payload?:unknown,signal?:AbortSignal):Promise<any>{
  let response:Response;
  try{response=await fetch('/api'+path,{credentials:'same-origin',signal,...(payload===undefined?{}:{method:'POST',headers:{'x-csrf-token':token,...(payload instanceof FormData?{}:{'content-type':'application/json'})},body:payload instanceof FormData?payload:JSON.stringify(payload)})});}
  catch{throw new Error(payload===undefined?'无法连接服务器，请检查 Tailscale 和电脑状态。':'连接中断，提交结果待核实。请先核对历史，不要重复发送。');}
  const data=await response.json();
  if(!response.ok){if(response.status===401&&!path.startsWith('/auth/'))window.dispatchEvent(new Event('auth-lost'));throw Object.assign(new Error(data.error??`请求失败 (${response.status})`),{data,status:response.status});}
  return data;
}
