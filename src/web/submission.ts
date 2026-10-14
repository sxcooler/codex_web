import type { TurnSettings } from './TurnOptions.tsx';
import type { Attachment } from './Attachments.tsx';
import type {UiText} from './i18n/types.ts';
export type Outgoing = { id:string; text:string; settings:TurnSettings; attachments:Attachment[]; expectedTurnId?:string; status:'sending'|'accepted'|'failed'|'unknown'; error?:UiText };
export function reconcileMessages(messages:Outgoing[],items:Array<{type?:string;clientId?:string|null}>):Outgoing[]{
  const confirmed=new Set(items.filter(item=>item.type==='userMessage'&&item.clientId).map(item=>item.clientId));
  const remaining=messages.filter(message=>!confirmed.has(message.id));
  return remaining.length===messages.length?messages:remaining;
}
export type Submission = { current: { signature: string; id: string } | null };
// Keep the identity of an ambiguous submission until it is reconciled.
export function submissionId(ref: Submission, payload: unknown): string {
  const signature = JSON.stringify(payload);
  if (ref.current?.signature !== signature) ref.current = { signature, id: crypto.randomUUID() };
  return ref.current!.id;
}
