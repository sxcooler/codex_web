import assert from 'node:assert/strict';
import test from 'node:test';
import * as feedback from '../src/web/turnFeedback.ts';
import * as activity from '../src/web/turnActivity.ts';
const {turnActivity,stepLabel}=activity;
const executionGroupIssue=(items:any[],locale:any)=>{assert.equal(typeof activity.executionGroupIssue,'function');return activity.executionGroupIssue(items,locale);};

const compact='Error running remote compact task: stream disconnected before completion: idle timeout waiting for SSE';
test('failed turns explain compaction conservatively and keep raw diagnostics',()=>{
 assert.equal(typeof feedback.turnOutcome,'function');
 const turn={id:'t',status:'failed',error:{message:compact,codexErrorInfo:'other'},items:[]};
 assert.equal(feedback.turnOutcome(turn,'zh-CN')?.reason,'上下文压缩超时');
 assert.equal(feedback.turnOutcome(turn,'en')?.title,'Turn incomplete');
 assert.equal(feedback.turnOutcome({...turn,error:{message:'stream disconnected'}},'zh-CN')?.reason,undefined);
 assert.equal(feedback.turnOutcome({...turn,error:{message:compact,codexErrorInfo:'serverOverloaded'}},'en')?.reason,'The model service was overloaded. This turn was interrupted.');
 assert.equal(turn.error.message,compact);
});
test('only a failed native turn is a confirmed failure, and stopped stays neutral',()=>{
 assert.equal(typeof feedback.turnOutcome,'function');
 for(const status of ['inProgress','completed'])assert.equal(feedback.turnOutcome({status,error:{message:compact}},'en')?.kind,'warning');
 assert.equal(feedback.turnOutcome({status:'completed'},'en'),undefined);
 assert.equal(feedback.turnOutcome({status:'interrupted'},'en')?.kind,'interrupted');
 assert.match(feedback.turnOutcome({status:'failed'},'en')!.detail,/specific reason/);
});
test('copy contains only the native error and turn timing, never the conversation or path',()=>{
 assert.equal(typeof feedback.turnErrorText,'function');
 const copied=feedback.turnErrorText({id:'t',status:'failed',startedAt:100,completedAt:110,error:{message:'native <b>failure</b>',codexErrorInfo:'other'},cwd:'private-path',items:[{text:'private-message'}]});
 assert.match(copied,/native <b>failure<\/b>/);assert.match(copied,/other/);
 assert.doesNotMatch(copied,/private-path|private-message/);
});
test('group feedback respects exit one, actual exceptions and unfinished items',()=>{
 assert.equal(executionGroupIssue([{type:'commandExecution',status:'failed',exitCode:1}],'en'),'');
 assert.equal(executionGroupIssue([{type:'commandExecution',status:'failed',exitCode:1,error:{message:'cannot run'}}],'en'),'Contains issues');
 assert.equal(executionGroupIssue([{type:'mcpToolCall',status:'completed',result:{isError:true}}],'en'),'Contains issues');
 assert.equal(executionGroupIssue([{type:'commandExecution',status:'inProgress'}],'en'),'Contains unfinished items');
 assert.equal(executionGroupIssue([{type:'commandExecution',status:'completed',exitCode:0}],'en'),'');
});
test('context compaction stays a named process record without rewriting native data',()=>{
 const item={id:'compact',type:'contextCompaction',status:'completed'};
 assert.equal(stepLabel(item.type,'en'),'Compacting context');
 assert.equal(turnActivity({id:'t',status:'failed',items:[item]})[0].process,true);
 assert.equal(item.status,'completed');
});
test('native retry labels do not invent progress or diagnose arbitrary disconnections',()=>{
 assert.equal(typeof feedback.nativeRetryText,'function');
 assert.equal(feedback.nativeRetryText({message:'Reconnecting... 2/5'},'en'),'Reconnecting 2/5');
 assert.equal(feedback.nativeRetryText({message:compact},'zh-CN'),'原生执行正在重连');
 assert.equal(feedback.nativeRetryText({message:'Reconnecting 9/5'},'en'),'Native execution is reconnecting');
});


test('current active terminal needs verification while historical outcomes stay confirmed',()=>{
 for(const status of ['completed','interrupted','failed']){
  const turn={id:'current',status,error:{message:'native error'}};
  assert.equal(feedback.turnOutcome(turn,'en','current'),undefined);
 }
 assert.equal(feedback.turnOutcome({id:'old',status:'interrupted'},'en','new')?.kind,'interrupted');
});
