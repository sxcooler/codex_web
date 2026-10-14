import test from 'node:test';
import assert from 'node:assert/strict';

test('locale formatters keep time units and support English plurals without changing values',async()=>{
  const helpers=await import('../src/web/i18n/format.ts').catch(()=>null);
  assert.ok(helpers,'Intl helpers must exist');
  assert.equal(helpers.formatDuration(3_661_000,'zh-CN'),'1小时 1分 1秒');
  assert.equal(helpers.formatDuration(3_661_000,'en'),'1h 1m 1s');
  assert.equal(helpers.formatNumber(12345,'en'),'12,345');
  assert.equal(helpers.formatDateTime(Number.NaN,'en'),'Unknown');
  assert.equal(helpers.formatDateTime('invalid','zh-CN'),'未知');
  assert.equal(helpers.formatDateTime(null as any,'en'),'Unknown');
  const time=Date.UTC(2026,0,2,3,4,5);
  assert.equal(helpers.formatDateTime(time,'en',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}),'01/02/2026');
  assert.equal(helpers.formatDateTime(time,'zh-CN',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}),'2026/01/02');
});
