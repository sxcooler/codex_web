export type SendShortcut='enter'|'mod-enter';
export type SessionSort='updated_at'|'created_at';
export const sessionSortKey='codex-web:session-sort:v1';
export function readSessionSort():SessionSort{
  try{return localStorage.getItem(sessionSortKey)==='created_at'?'created_at':'updated_at';}catch{return 'updated_at';}
}
export function writeSessionSort(value:SessionSort):boolean{
  if(value!=='updated_at'&&value!=='created_at')return false;
  try{localStorage.setItem(sessionSortKey,value);if(localStorage.getItem(sessionSortKey)!==value)return false;window.dispatchEvent(new Event('session-sort-changed'));return true;}catch{return false;}
}
const key='codex-web:send-shortcut:v1';
export function readSendShortcut():SendShortcut{
  try{return localStorage.getItem(key)==='mod-enter'?'mod-enter':'enter';}catch{return 'enter';}
}
export function writeSendShortcut(value:SendShortcut):boolean{
  if(value!=='enter'&&value!=='mod-enter')return false;
  try{localStorage.setItem(key,value);return localStorage.getItem(key)===value;}catch{return false;}
}
export function shouldSubmit(event:{key:string;shiftKey:boolean;ctrlKey:boolean;metaKey:boolean;isComposing?:boolean;keyCode?:number},{mobile,shortcut}:{mobile:boolean;shortcut:SendShortcut}):boolean{
  return !mobile&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&(shortcut==='enter'||event.ctrlKey||event.metaKey);
}
