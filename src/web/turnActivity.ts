import {createTranslator,type MessageKey} from './i18n/messages.ts';
import type {Locale} from './i18n/types.ts';
type Item=Record<string,any>;
export const modelOverloadNotice=(error?:Item,locale:Locale='zh-CN'):string|undefined=>error?.codexErrorInfo==='serverOverloaded'?createTranslator(locale)('session.overload'):undefined;
export const stepLabels:Record<string,string>={reasoning:'思考',commandExecution:'命令',fileChange:'文件修改',mcpToolCall:'MCP 工具',dynamicToolCall:'工具调用',webSearch:'搜索',plan:'计划',collabAgentToolCall:'协作',subAgentActivity:'子 Agent',functionCallOutput:'工具输出',sleep:'等待'};

const stepKeys:Record<string,MessageKey>={reasoning:'session.step.reasoning',commandExecution:'session.step.command',fileChange:'session.step.fileChange',mcpToolCall:'session.step.mcp',dynamicToolCall:'session.step.dynamic',webSearch:'session.step.search',plan:'session.step.plan',collabAgentToolCall:'session.step.collaboration',subAgentActivity:'session.step.subagent',functionCallOutput:'session.step.output',sleep:'session.step.sleep'};
export const stepLabel=(type:string,locale:Locale='zh-CN')=>stepKeys[type]?createTranslator(locale)(stepKeys[type]):undefined;
export function executionIssue(item:Item,locale:Locale='zh-CN'):string{
  const t=createTranslator(locale);
  if(item.type==='commandExecution'&&typeof item.exitCode==='number'&&item.exitCode!==0)return t('session.issue.exit',item.exitCode);
  if(item.status==='declined')return t('session.issue.declined');
  if(item.status==='interrupted'||item.type==='subAgentActivity'&&item.kind==='interrupted')return t('session.issue.interrupted');
  if(item.status==='failed')return t('session.issue.failed');
  if(item.error||item.isError===true||item.result?.isError===true||item.success===false)return t('session.issue.toolError');
  return '';
}

export function executionRows(items:Item[]){
  const rows:{items:Item[];records:boolean}[]=[];
  for(const item of items){
    const issueItem=item.type==='commandExecution'&&item.exitCode===1?{...item,exitCode:undefined,status:item.status==='failed'?undefined:item.status}:item;
    const records=Object.hasOwn(stepLabels,item.type)&&!executionIssue(issueItem),last=rows.at(-1);
    if(records&&last?.records)last.items.push(item);else rows.push({items:[item],records});
  }
  return rows;
}

export function turnActivity(turn:Record<string,any>){
  const items:Item[]=turn.items??[],ordinary=items.filter(item=>item.type==='agentMessage'&&item.delivery!=='async');
  const terminal=['completed','failed','interrupted'].includes(turn.status);
  const fallback=terminal&&!ordinary.some(item=>item.phase==='final_answer')
    ?(['failed','interrupted'].includes(turn.status)?ordinary.at(-1):ordinary.filter(item=>item.phase!=='commentary').at(-1)):undefined;
  const blocks:{key:string;items:Item[];process:boolean}[]=[];
  for(const [index,item] of items.entries()){
    const process=Object.hasOwn(stepLabels,item.type)||item.type==='imageView'||(item.type==='agentMessage'&&item.delivery!=='async'&&item.phase!=='final_answer'&&item!==fallback),last=blocks.at(-1);
    if(process&&last?.process)last.items.push(item);else blocks.push({key:turn.id+':'+(item.id??index),items:[item],process});
  }
  return blocks;
}

// Item times are milliseconds; native turn start/completion times are seconds.
export function turnElapsedMs(turn:Record<string,any>,now=Date.now()):number|undefined{
  const seconds=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0&&Number.isSafeInteger(value*1000)&&value*1000<=8_640_000_000_000_000?value*1000:undefined;
  const start=seconds(turn.startedAt);
  if(turn.status==='inProgress')return start!==undefined&&Number.isSafeInteger(now)&&now>=start?now-start:undefined;
  if(typeof turn.durationMs==='number'&&Number.isSafeInteger(turn.durationMs)&&turn.durationMs>=0)return turn.durationMs;
  const end=seconds(turn.completedAt);return start!==undefined&&end!==undefined&&end>=start?end-start:undefined;
}
