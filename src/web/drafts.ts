import type { TurnSettings } from './TurnOptions.tsx';
import type { Attachment } from './Attachments.tsx';
import type { Submission,Outgoing } from './submission.ts';
import type {Json} from './api.ts';
import type {UiText} from './i18n/types.ts';
export type ForkResult={status:'pending'|'created'|'failed'|'unknown';threadId?:string;message?:UiText};
export type Draft={initialSnapshot?:Json;creation?:{mode:string;projectId:string;nativeSelection?:string;selectedWorkspace?:string;name:string;folder:string;repo:string};text:string;settings:TurnSettings;attachments:Attachment[];outgoing?:Outgoing[];top?:number;follow?:boolean;intent?:Submission['current'];uncertain?:boolean;forkResults?:Record<string,ForkResult>};
export const drafts=new Map<string,Draft>();
export function suggestedDraft(current:string,value:unknown):string|null{
 if(typeof value!=='string'||!value.trim()||value.length>12000)return null;
 const next=current?current+'\n\n'+value:value;
 return next.length<=12000?next:null;
}
