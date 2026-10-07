import type {TurnSettings} from './TurnOptions.tsx';

const key='codex-web:turn-settings:v2';
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200;

export function loadTurnSettings():TurnSettings {
  try {
    const value=JSON.parse(localStorage.getItem(key)??'null');
    if(!text(value?.model))return {};
    return {model:value.model,...(text(value.effort)?{effort:value.effort}:{}),...(['ask','auto-review','full-access'].includes(value.permissionMode)?{permissionMode:value.permissionMode}:{})};
  }catch{return {};}
}

export function rememberNewTaskSettings(value:TurnSettings):void {
  const {model,effort,permissionMode}=value;
  if(!text(model))return;
  const next=JSON.stringify({model,...(text(effort)?{effort}:{}),...(permissionMode&&['ask','auto-review','full-access'].includes(permissionMode)?{permissionMode}:{})});
  try{if(localStorage.getItem(key)!==next)localStorage.setItem(key,next);}catch{}
}
