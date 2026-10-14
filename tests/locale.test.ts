import test from 'node:test';
import assert from 'node:assert/strict';

const locale=()=>import('../src/web/i18n/locale.ts');
test('locale follows the first supported browser language without claiming Traditional Chinese',async()=>{
  const helpers=await locale().catch(()=>null);
  assert.ok(helpers,'Locale helpers must exist');
  assert.equal(helpers.resolveLocale('system',['zh-TW','en-US']),'en');
  assert.equal(helpers.resolveLocale('system',['fr-FR','zh-Hans-SG','en']),'zh-CN');
  assert.equal(helpers.resolveLocale('system',['zh-Hant','de']),'zh-CN');
  assert.equal(helpers.resolveLocale('system',['en-GB','zh-CN']),'en');
  assert.equal(helpers.resolveLocale('zh-CN',['en']),'zh-CN');
  assert.equal(helpers.resolveLocale('en',['zh-CN']),'en');
});
test('locale storage validates canonical values and confirms writes by reading them back',async()=>{
  const helpers=await locale().catch(()=>null);assert.ok(helpers,'Locale storage must exist');
  const values=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  assert.equal(helpers.localeKey,'codex-web:locale:v1');
  assert.equal(helpers.readLocalePreference(storage),'system');
  values.set(helpers.localeKey,'EN');assert.equal(helpers.readLocalePreference(storage),'system');
  assert.equal(helpers.writeLocalePreference('en',storage),true);assert.equal(helpers.readLocalePreference(storage),'en');
  assert.equal(helpers.writeLocalePreference('system',storage),true);
  assert.equal(helpers.writeLocalePreference('invalid' as any,storage),false);
  assert.equal(helpers.writeLocalePreference('en',{getItem:()=>null,setItem:()=>{}}),false);
  const blocked={getItem:()=>{throw Error('blocked');},setItem:()=>{throw Error('blocked');}};
  assert.equal(helpers.readLocalePreference(blocked),'system');assert.equal(helpers.writeLocalePreference('en',blocked),false);
});
