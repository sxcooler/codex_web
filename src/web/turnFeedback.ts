import {createTranslator} from './i18n/messages.ts';
import type {Locale} from './i18n/types.ts';
import {modelOverloadNotice} from './turnActivity.ts';
import {validItemTime} from '../codex/itemTimes.ts';
type Turn=Record<string,any>;
type Outcome={kind:'failed'|'interrupted'|'warning';title:string;reason?:string;detail:string};

export function turnOutcome(turn:Turn,locale:Locale='zh-CN'):Outcome|undefined{
  const t=createTranslator(locale);
  if(turn.status==='interrupted')return {kind:'interrupted',title:t('session.feedback.interrupted'),detail:t('session.feedback.stopped')};
  if(turn.status!=='failed')return turn.error?{kind:'warning',title:t('session.feedback.warning'),detail:t('session.feedback.warningDetail')}:undefined;
  const message=typeof turn.error==='string'?turn.error:turn.error?.message;
  const reason=modelOverloadNotice(turn.error,locale)??(typeof message==='string'&&/error running remote compact task/i.test(message)&&/idle timeout waiting for SSE/i.test(message)?t('session.feedback.compactionTimeout'):undefined);
  const detail=!turn.error?t('session.feedback.noReason'):(turn.items??[]).some((item:Turn)=>item.type==='agentMessage')?t('session.feedback.preserved'):t('session.feedback.noReply');
  return {kind:'failed',title:t('session.feedback.incomplete'),reason,detail};
}

export function turnErrorText(turn:Turn):string{
  const lines=[typeof turn.error==='string'?turn.error:turn.error?JSON.stringify(turn.error,null,2):''];
  for(const field of ['startedAt','completedAt']){
    const value=turn[field];
    if(typeof value==='number'&&value>0&&validItemTime(value*1000))lines.push(field+': '+new Date(value*1000).toISOString());
  }
  return lines.filter(Boolean).join('\n');
}

export function nativeRetryText(retry:Turn,locale:Locale='zh-CN'):string{
  const t=createTranslator(locale),match=typeof retry.message==='string'?/^Reconnecting(?:\.\.\.)?\s+(\d+)\/(\d+)$/i.exec(retry.message.trim()):null;
  if(match){const attempt=Number(match[1]),total=Number(match[2]);if(Number.isSafeInteger(attempt)&&attempt>0&&Number.isSafeInteger(total)&&attempt<=total)return t('session.feedback.reconnectingProgress',attempt,total);}
  return t('session.feedback.reconnecting');
}
