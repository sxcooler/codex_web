import {test} from 'node:test';
import assert from 'node:assert/strict';
import {msg} from '../src/web/i18n/messages.ts';
import {formatText} from '../src/web/i18n/text.ts';
test('stored repository notices and nested errors resolve at display time',()=>{
 const notice=msg('panels.history.returned','vendor/原始');assert.equal(formatText(notice,'zh-CN'),'仓库 vendor/原始 已不可用，已返回主仓库。');assert.equal(formatText(notice,'en'),'Repository vendor/原始 is unavailable. Returned to the main repository.');
 const error=new Error('unknown 原始 backend error');const contextual=msg('panels.history.repositoryFailed',error);assert.equal(formatText(contextual,'en'),'Could not read the repository list: unknown 原始 backend error');assert.equal(error.message,'unknown 原始 backend error');
});
test('report counts retain passed failed skipped and error denominators in both languages',()=>{
 const result=msg('panels.report.summary',0,1,2,3);assert.equal(formatText(result,'zh-CN'),'通过 0 · 失败 1 · 跳过 2 · 错误 3');assert.equal(formatText(result,'en'),'Passed 0 · Failed 1 · Skipped 2 · Errors 3');
});
