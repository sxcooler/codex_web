import test from 'node:test';
import assert from 'node:assert/strict';

test('message catalogs provide typed bilingual keys and preserve render-time nested errors',async()=>{
  const messages=await import('../src/web/i18n/messages.ts').catch(()=>null);
  assert.ok(messages,'Message catalogs must exist');
  assert.equal(messages.createTranslator('zh-CN')('common.cancel'),'取消');
  assert.equal(messages.createTranslator('en')('common.cancel'),'Cancel');
  for(const [count,want] of [[0,'0 items'],[1,'1 item'],[2,'2 items']] as const)assert.equal(messages.createTranslator('en')('common.items',count),want);
  const {formatText}=await import('../src/web/i18n/text.ts');
  const {formatDisplayError}=await import('../src/web/i18n/errors.ts');
  const error=Object.assign(new Error('original transport message'),{i18n:messages.msg('api.read.timeout')});
  const context=messages.msg('common.errorDetail',error);
  assert.match(formatText(context,'zh-CN'),/读取超时/);
  assert.match(formatText(context,'en'),/timed out/);
  assert.equal(error.message,'original transport message');
  const raw=Object.assign(new Error('provider original'),{status:503,data:{code:'RUNTIME_ERROR',partial:{threadId:'keep'}}});
  assert.equal(formatDisplayError(raw,'en'),'provider original');
  assert.deepEqual(raw.data,{code:'RUNTIME_ERROR',partial:{threadId:'keep'}});
  assert.equal(messages.createTranslator('en')('missing.key' as any),'[missing.key]');
});

test('unknown prototype-named codes preserve native diagnostics',async()=>{
 const {formatDisplayError}=await import('../src/web/i18n/errors.ts');
 for(const code of ['constructor','toString','__proto__'])assert.equal(formatDisplayError(Object.assign(new Error('native original'),{code}),'en'),'native original');
});

test('prototype-named missing message keys use a string fallback',async()=>{
 const {createTranslator}=await import('../src/web/i18n/messages.ts');
 for(const key of ['constructor','toString','__proto__'])assert.equal(createTranslator('en')(key as any),`[${key}]`);
});

test('missing production messages warn once using only the key',async t=>{
 const {createTranslator}=await import('../src/web/i18n/messages.ts');const warnings:unknown[][]=[];
 t.mock.method(console,'warn',(...values:unknown[])=>warnings.push(values));
 const translate=createTranslator('en') as (key:string,...args:unknown[])=>string;
 assert.equal(translate('missing.production.key','private argument'),'[missing.production.key]');
 translate('missing.production.key','another private argument');
 assert.equal(warnings.length,1);assert.deepEqual(warnings[0],['Missing interface message: missing.production.key']);
});
