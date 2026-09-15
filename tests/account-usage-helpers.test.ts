import test from 'node:test';
import assert from 'node:assert/strict';
import {absoluteTime,creditCount,headlineRemaining,remaining,timestamp,usableCredit,usageGroups,windowLabel,type AccountUsage} from '../src/web/accountUsage.ts';

test('account usage distinguishes missing data, main limits, decimal counts and expiry boundaries',()=>{
  for(const value of [null,undefined,'20',NaN,Infinity])assert.equal(remaining({usedPercent:value}),null);
  assert.equal(remaining({usedPercent:120}),0);assert.equal(remaining({usedPercent:-5}),100);
  const data={rateLimitsByLimitId:{spark:{primary:{usedPercent:99}},codex:{primary:{usedPercent:20},secondary:{usedPercent:29}}}} as unknown as AccountUsage;
  assert.equal(headlineRemaining(data),71);assert.equal(usageGroups(data).length,2);
  data.rateLimitsByLimitId!.codex.secondary!.usedPercent=null;assert.equal(headlineRemaining(data),null);
  data.rateLimitsByLimitId={spark:{primary:{usedPercent:40}}};assert.equal(headlineRemaining(data),null);
  data.rateLimitsByLimitId=null;data.rateLimits={primary:{usedPercent:10}};assert.equal(headlineRemaining(data),90);
  assert.equal(windowLabel(300),'5 小时');assert.equal(windowLabel(10080),'每周');assert.equal(windowLabel(null),'额度周期');assert.equal(windowLabel(90),'90 分钟');
  assert.equal(creditCount('9007199254740993123'),'9007199254740993123');for(const value of [null,4,'-1','1.5'])assert.equal(creditCount(value),null);
  assert.equal(timestamp(null),null);assert.equal(timestamp(1.5),null);assert.equal(absoluteTime('100'),'暂不可用');
  const credit={id:'credit',status:'available',resetType:'codexRateLimits',expiresAt:10};
  assert.equal(usableCredit(credit,9999),true);assert.equal(usableCredit(credit,10000),false);
  assert.equal(usableCredit({...credit,expiresAt:null}),true);assert.equal(usableCredit({...credit,expiresAt:undefined}),false);
  assert.equal(usableCredit({...credit,resetType:'unknown',expiresAt:null}),false);assert.equal(usableCredit({...credit,status:'redeeming',expiresAt:null}),false);
});
