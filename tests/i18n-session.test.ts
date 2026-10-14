import assert from 'node:assert/strict';
import test from 'node:test';
import {executionIssue,modelOverloadNotice,executionRows,turnActivity} from '../src/web/turnActivity.ts';
import {formatText,msg} from '../src/web/i18n/text.ts';
import {prependHistory} from '../src/web/sessionSync.ts';

test('English issue and overload labels leave native records and grouping intact',()=>{
 const command={id:'command',type:'commandExecution',exitCode:1,status:'failed',aggregatedOutput:'原始 command output'};
 const error={codexErrorInfo:'serverOverloaded',message:'Original capacity error'};
 assert.equal(executionIssue(command,'en'),'Command exit code 1');
 assert.equal(modelOverloadNotice(error,'en'),'The model service was overloaded. This turn was interrupted.');
 assert.equal(modelOverloadNotice({...error,codexErrorInfo:'internalServerError'},'en'),undefined);
 assert.equal(executionIssue(command),'命令退出码 1');
 assert.equal(executionRows([command])[0].items[0],command);
 assert.deepEqual(turnActivity({id:'turn',status:'failed',items:[command]}).map(block=>block.items),[[command]]);
 assert.equal(command.aggregatedOutput,'原始 command output');assert.equal(error.message,'Original capacity error');
});

test('invalid history pages retain their raw exception but display a localized recovery action',()=>{
 let failure:Error|undefined;
 try{prependHistory({thread:{turns:[]},history:{nextCursor:'older'}},{},'older');}catch(error){failure=error as Error;}
 assert.ok(failure);assert.equal(failure.message,'历史分页无效，请刷新会话后重试');
 assert.equal(formatText(failure,'en'),'Invalid history page. Refresh the conversation and retry');
 assert.equal(formatText(failure,'zh-CN'),'历史分页无效，请刷新会话后重试');
});

test('cached ownership and nested option errors render in the current language without losing diagnostics',()=>{
 const error=Object.assign(new Error('raw ownership detail'),{status:503,data:{code:'RUNTIME_ERROR'}});
 const ownership=msg('session.open.failed',true,error),options=msg('session.options.failed',error);
 assert.match(formatText(ownership,'zh-CN'),/将自动重试/);
 assert.equal(formatText(ownership,'en'),'Conversation ownership is unconfirmed. Will retry automatically. History remains available. raw ownership detail');
 assert.equal(formatText(options,'en'),'Options could not be loaded: raw ownership detail');
 assert.equal(error.message,'raw ownership detail');assert.equal(error.status,503);assert.equal(error.data.code,'RUNTIME_ERROR');
});
