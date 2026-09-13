import type { TurnSettings } from './TurnOptions.tsx';
import type { Attachment } from './Attachments.tsx';
import type { Submission,Outgoing } from './submission.ts';
export type Draft={creation?:{mode:string;projectId:string;name:string;folder:string;repo:string};text:string;settings:TurnSettings;attachments:Attachment[];outgoing?:Outgoing[];top?:number;follow?:boolean;intent?:Submission['current'];uncertain?:boolean};
export const drafts=new Map<string,Draft>();
