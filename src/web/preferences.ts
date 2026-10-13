export type SendShortcut='enter'|'mod-enter';
export type SessionSort='updated_at'|'created_at';
export type SessionGrouping='flat'|'project';
export const sessionGroupingKey='codex-web:session-grouping:v2';
export function readSessionGrouping():SessionGrouping{
  try{const value=localStorage.getItem(sessionGroupingKey);if(value==='project'||value==='flat')return value;const legacy=localStorage.getItem('codex-web:session-grouping:v1'),migrated=value==='directory'?'project':legacy==='flat'?'flat':'project';try{localStorage.setItem(sessionGroupingKey,migrated);}catch{}return migrated;}catch{return 'project';}
}
export function writeSessionGrouping(value:SessionGrouping):boolean{
  if(value!=='flat'&&value!=='project')return false;
  try{localStorage.setItem(sessionGroupingKey,value);if(localStorage.getItem(sessionGroupingKey)!==value)return false;window.dispatchEvent(new Event('session-grouping-changed'));return true;}catch{return false;}
}
export const projectCollapseKey='codex-web:project-collapse:v2';
export function readCollapsedProjects():Set<string>{
  try{const saved=localStorage.getItem(projectCollapseKey),value=JSON.parse(saved??localStorage.getItem('codex-web:project-collapse:v1')??'[]');const keys=Array.isArray(value)?value.filter((key:unknown)=>typeof key==='string'&&!key.startsWith('project:')).map((key:string)=>key.startsWith('directory:')?key.slice(10):key):[];if(saved!==JSON.stringify(keys))try{localStorage.setItem(projectCollapseKey,JSON.stringify(keys));}catch{}return new Set(keys);}catch{return new Set();}
}
export function writeCollapsedProjects(value:Set<string>):boolean{
  try{const encoded=JSON.stringify([...value]);localStorage.setItem(projectCollapseKey,encoded);if(localStorage.getItem(projectCollapseKey)!==encoded)return false;window.dispatchEvent(new Event('project-collapse-changed'));return true;}catch{return false;}
}
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
