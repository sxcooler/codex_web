import type {Json} from './api.ts';
import type {TurnSettings} from './TurnOptions.tsx';

const key='codex-web:turn-settings:v1';
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200;

export function loadTurnSettings():TurnSettings {
  try {
    const value=JSON.parse(localStorage.getItem(key)??'null');
    if(!text(value?.model))return {};
    return {model:value.model,...(text(value.effort)?{effort:value.effort}:{}),...(['ask','auto-review','full-access'].includes(value.permissionMode)?{permissionMode:value.permissionMode}:{})};
  }catch{return {};}
}

export function rememberTurnSettings(snapshot:Json):void {
  if(!['IDLE','RUNNING','WAITING_APPROVAL','WAITING_INPUT'].includes(snapshot.phase)||snapshot.error||snapshot.thread?.status?.type==='notLoaded'||!snapshot.permissions)return;
  const model=snapshot.model??snapshot.thread?.model,effort=snapshot.reasoningEffort!==undefined?snapshot.reasoningEffort:snapshot.thread?.reasoningEffort;
  if(!text(model))return;
  const {approvalPolicy,approvalsReviewer,sandbox}=snapshot.permissions;
  let permissionMode:string|undefined;
  if(sandbox?.type==='dangerFullAccess'&&approvalPolicy==='never'&&approvalsReviewer==='user')permissionMode='full-access';
  // Only carry exact presets: custom roots/network rules belong to their original project.
  if(sandbox?.type==='workspaceWrite'&&approvalPolicy==='on-request'&&sandbox.networkAccess===false&&sandbox.excludeTmpdirEnvVar===true&&sandbox.excludeSlashTmp===true
    &&Array.isArray(sandbox.writableRoots)&&sandbox.writableRoots.every((root:unknown)=>typeof root==='string'&&root===snapshot.thread?.cwd)){
    if(approvalsReviewer==='user')permissionMode='ask';
    if(approvalsReviewer==='auto_review')permissionMode='auto-review';
  }
  const value=JSON.stringify({model,...(text(effort)?{effort}:{}),...(permissionMode?{permissionMode}:{})});
  try{if(localStorage.getItem(key)!==value)localStorage.setItem(key,value);}catch{}
}
