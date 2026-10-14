import test from 'node:test';
import assert from 'node:assert/strict';
import {balanceText,windowLabel,countdown,absoluteTime} from '../src/web/accountUsage.ts';
test('account display localizes units and unknowns without rounding exact balances',()=>{
 assert.equal(windowLabel(300,'en'),'5 hours');assert.equal(windowLabel(10080,'en'),'Weekly');assert.equal(windowLabel(null,'en'),'Quota window');
 assert.equal(countdown(3600,0,'en'),'1 hour 0 minutes remaining');assert.equal(absoluteTime(null,'en'),'Unavailable');
 assert.equal(balanceText({hasCredits:false,unlimited:false,balance:null},'en'),'No available credits');
 const precise='90071992547409931234567890.012';
 assert.equal(balanceText({hasCredits:true,unlimited:false,balance:precise},'en'),'90,071,992,547,409,931,234,567,890.012');
});

test('countdown retains ceiling boundaries and never claims an estimated reset happened',()=>{
 assert.equal(countdown(1,0,'en'),'1 minute remaining');assert.equal(countdown(60,0,'en'),'1 minute remaining');assert.equal(countdown(61,0,'en'),'2 minutes remaining');assert.equal(countdown(86400,0,'en'),'1 day 0 hours remaining');assert.equal(countdown(86400,86400000,'en'),'Estimated reset time reached. Waiting for an update.');assert.equal(countdown(-1,0,'en'),'Unavailable');assert.equal(countdown(null,0,'zh-CN'),'暂不可用');
 assert.equal(windowLabel(1440,'en'),'1 day');assert.equal(windowLabel(120,'en'),'2 hours');assert.equal(windowLabel(1,'en'),'1 minute');assert.equal(windowLabel(0,'en'),'Quota window');
 assert.equal(balanceText({hasCredits:true,unlimited:true,balance:'90071992547409931234567890.012'},'en'),'Unlimited');assert.equal(balanceText({hasCredits:true,unlimited:false,balance:'-1'},'en'),'Unavailable');assert.equal(balanceText({hasCredits:true,unlimited:false,balance:'00001.0000'},'en'),'00,001.0000');
});
