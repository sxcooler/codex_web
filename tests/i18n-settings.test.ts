import test from 'node:test';
import assert from 'node:assert/strict';
import {msg} from '../src/web/i18n/messages.ts';
import {formatText} from '../src/web/i18n/text.ts';
test('configuration read failures keep nested errors and translate when rendered',()=>{
 const raw=Object.assign(new Error('Native raw model diagnostic'),{status:503,data:{code:'RUNTIME_ERROR',partial:true}});
 const value=msg('settings.config.readFailures','',msg('settings.config.modelsFailed',raw),msg('settings.config.permissionsFailed',new Error('Raw permissions diagnostic')));
 assert.equal(formatText(value,'zh-CN'),'模型目录读取失败：Native raw model diagnostic；权限能力读取失败：Raw permissions diagnostic');
 assert.equal(formatText(value,'en'),'Failed to read model catalog: Native raw model diagnostic\nFailed to read permission capabilities: Raw permissions diagnostic');
 assert.equal(raw.message,'Native raw model diagnostic');assert.equal(raw.status,503);assert.deepEqual(raw.data,{code:'RUNTIME_ERROR',partial:true});
});
test('settings count messages cover zero, one and many without changing stored descriptors',()=>{
 for(const count of [0,1,2]){const value=msg('settings.config.changed',count);assert.equal(formatText(value,'zh-CN'),`${count} 项已修改`);assert.equal(formatText(value,'en'),`${count} ${count===1?'setting':'settings'} modified`);assert.deepEqual(value.args,[count]);}
});
