import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLayout, fitLayout, resizeLayout } from '../src/web/layout.ts';

test('saved proportions restore across widths without overwriting preference at minimum bounds', () => {
  const preference = {left:.2,center:.55,right:.25};
  assert.deepEqual(fitLayout(preference, 1200), [240,660,300]);
  fitLayout(preference, 840).forEach((width,i)=>assert.ok(Math.abs(width-[180,420,240][i])<1e-8));
  fitLayout(preference, 1600).forEach((width,i)=>assert.ok(Math.abs(width-[320,880,400][i])<1e-8));
  assert.deepEqual(preference, {left:.2,center:.55,right:.25});
});
test('dragging adjusts adjacent panes and preserves hidden pane share', () => {
  const preference = {left:.2,center:.55,right:.25};
  const moved = resizeLayout(preference, 1200, 'left', 60, true);
  assert.equal(moved.left,.25); assert.equal(moved.center,.5); assert.equal(moved.right,.25);
  const hidden = resizeLayout(preference,1200,'left',60,false);
  assert.equal(hidden.right,.25); assert.equal(hidden.left,.25);
  const clamped = resizeLayout(preference,1200,'right',2000,true);
  assert.ok(fitLayout(clamped,1200)[1]>=420);
});
test('corrupt or incompatible persisted layouts fall back without NaN widths', () => {
  for (const raw of ['bad','null','{}','{"version":2,"left":.2}', JSON.stringify({version:1,left:-1,center:1,right:1}),JSON.stringify({version:1,left:.2,center:.3,right:.1})]) assert.equal(parseLayout(raw),null);
  assert.deepEqual(parseLayout('{"version":1,"left":0.2,"center":0.55,"right":0.25}'),{left:.2,center:.55,right:.25});
});

test('right resize with left collapsed preserves the left preference and ignores hidden dividers', () => {
  const preference={left:.2,center:.55,right:.25};
  const moved=resizeLayout(preference,1200,'right',-60,true,false);
  assert.equal(moved.left,.2);assert.equal(moved.right,.3);assert.equal(moved.center,.5);
  assert.deepEqual(resizeLayout(preference,1200,'left',60,true,false),preference);
  assert.deepEqual(resizeLayout(preference,1200,'right',60,false,true),preference);
});

test('a hidden wide-screen preference cannot produce negative shares after shrinking the window', () => {
  for(const [layout,side,right,left] of [[{left:.868,center:.084,right:.048},'right',true,false],[{left:.048,center:.084,right:.868},'left',false,true]] as const){
    const moved=resizeLayout(layout,1100,side,-10,right,left);
    assert.ok(parseLayout(JSON.stringify({version:1,...moved})),'Saved layout must remain valid');
  }
});
