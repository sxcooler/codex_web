import type { TurnSettings } from './TurnOptions.tsx';
import type { Attachment } from './Attachments.tsx';
import type { Submission,Outgoing } from './submission.ts';
import type {Json} from './api.ts';
export type ForkResult={status:'pending'|'created'|'failed'|'unknown';threadId?:string;message?:string};
export type Draft={initialSnapshot?:Json;creation?:{mode:string;projectId:string;nativeSelection?:string;selectedWorkspace?:string;name:string;folder:string;repo:string};text:string;settings:TurnSettings;attachments:Attachment[];outgoing?:Outgoing[];top?:number;follow?:boolean;intent?:Submission['current'];uncertain?:boolean;forkResults?:Record<string,ForkResult>};
export const drafts=new Map<string,Draft>();
