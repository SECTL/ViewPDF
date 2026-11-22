/**
 * gesture-pinch.mjs —— 两指捏合 V2 的执行型守卫
 *
 * 真实 types.js / tolerance.js / pinch-zoom-v2.js 剥掉 ESM 关键字后在同一 node:vm
 * 上下文执行。用可控的假 InputSource 驱动 _startPinch / _emit_pinch_frame /
 * _onInputMove，断言增量比限幅、最小距离冻结、微动死区、BOTH 容差语义。
 * 变异测试见 gesture-pinch-mutation.mjs。
 *
 * 用法：node tests/gesture-pinch.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';

const DIR = 'src/modules/gesture/';
const read = (f) => fs.readFileSync(DIR + f, 'utf8');
function stripESM(src) {
  return src
    .replace(/^import\s+[^\n]*;\s*$/gm, '')
    .replace(/^export\s*\{[^\n]*?\}\s*from\s*['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^export\s*\{[^\n]*\};?\s*$/gm, '')
    .replace(/^export\s+(?=(?:const|let|var|class|function|async)\b)/gm, '');
}

let NOW = 1000;
const perf = { now: () => NOW };
const ctx = vm.createContext({
  performance: perf,
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  window: { TouchEvent: class {} },
  console,
});
vm.runInContext(
  stripESM(read('types.js')) + '\n' + stripESM(read('tolerance.js')) + '\n' +
  stripESM(read('pinch-zoom-v2.js')) +
  '\nglobalThis.__G = { DeviceType, VirtualDeviceType, TOLERANCE,' +
  ' PINCH_MIN_DISTANCE, PINCH_FRAME_RATIO_MAX, PINCH_FRAME_RATIO_MIN,' +
  ' PinchZoomSourceV2 };',
  ctx
);
const G = ctx.__G;
const { PinchZoomSourceV2, VirtualDeviceType, PINCH_MIN_DISTANCE,
  PINCH_FRAME_RATIO_MAX, PINCH_FRAME_RATIO_MIN } = G;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const o = Object.is(got, want);
  if (o) pass++; else fail++;
  console.log((o ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
function ok(label, cond, extra = '') { eq(label + (extra ? '  ' + extra : ''), !!cond, true); }

function makePinch(options = {}) {
  const events = [];
  const input = {
    get activeCount() { return events.length; },
    get activeEvents() { return events.map((e) => ({ id: e.id, position: { x: e.x, y: e.y } })); },
    on() {}, off() {},
    set(list) { events.length = 0; for (const e of list) events.push(e); },
  };
  const p = new PinchZoomSourceV2(input, options);
  const deltas = [], starts = [], completes = [];
  p.onPinchDelta = (d) => deltas.push({
    scale: d.scale, centerX: d.centerX, centerY: d.centerY,
    originScale: d.originScale, deltaScale: d.deltaScale,
  });
  p.onPinchStarted = (d) => starts.push(d);
  p.onPinchCompleted = (d) => completes.push(d);
  return { p, input, deltas, starts, completes };
}
// 起点 (0,0)-(100,0)，中点 50，距离 100。_startPinch 不设置 _pinchIds，手动补上。
function begin(ctxPinch) {
  ctxPinch.p._startPinch({ x: 0, y: 0 }, { x: 100, y: 0 });
  ctxPinch.p._pinchIds = [1, 2];
}

/* ══════════ 1. 增量比限幅 [MIN,MAX] + 增量比公式 ══════════ */
{
  const c = makePinch();
  begin(c);
  // 帧 A：距离 130（超容差），中点不变 → 重建参考距离，比值 1 → 死区不发射
  c.input.set([{ id: 1, x: -15, y: 0 }, { id: 2, x: 115, y: 0 }]);
  c.p._emit_pinch_frame();
  eq('首次超容差帧重建参考、不发射', c.deltas.length, 0);
  eq('  prevDistance 重置为当前距离', c.p._prevDistance, 130);

  // 帧 B：距离 200 → 增量比 200/130
  c.input.set([{ id: 1, x: 0, y: 0 }, { id: 2, x: 200, y: 0 }]);
  c.p._emit_pinch_frame();
  eq('第二帧发射一次', c.deltas.length, 1);
  ok('增量比 = 当前距离/上帧距离（200/130）',
    Math.abs(c.deltas[0].scale - 200 / 130) < 1e-9, 'scale=' + c.deltas[0].scale);
  ok('deltaScale === scale-1', Math.abs(c.deltas[0].deltaScale - (c.deltas[0].scale - 1)) < 1e-12);
  eq('centerX 为两指中点', c.deltas[0].centerX, 100);

  // 帧 C：距离 20（恰不小于 MIN）→ 比值 0.1 被钳到下限
  c.input.set([{ id: 1, x: 90, y: 0 }, { id: 2, x: 110, y: 0 }]);
  c.p._emit_pinch_frame();
  eq('第三帧发射', c.deltas.length, 2);
  ok('低于下限被钳到 PINCH_FRAME_RATIO_MIN',
    Math.abs(c.deltas[1].scale - PINCH_FRAME_RATIO_MIN) < 1e-9, 'scale=' + c.deltas[1].scale);

  // 帧 D：距离 400 → 比值 20 被钳到上限
  c.input.set([{ id: 1, x: -100, y: 0 }, { id: 2, x: 300, y: 0 }]);
  c.p._emit_pinch_frame();
  eq('第四帧发射', c.deltas.length, 3);
  ok('高于上限被钳到 PINCH_FRAME_RATIO_MAX',
    Math.abs(c.deltas[2].scale - PINCH_FRAME_RATIO_MAX) < 1e-9, 'scale=' + c.deltas[2].scale);
}

/* ══════════ 2. 两指最小距离冻结（不发射、不更新参考距离） ══════════ */
{
  const c = makePinch();
  begin(c);
  c.input.set([{ id: 1, x: -15, y: 0 }, { id: 2, x: 115, y: 0 }]); // 建参考 130
  c.p._emit_pinch_frame();
  const prev = c.p._prevDistance;
  // 并拢到 10px < PINCH_MIN_DISTANCE
  c.input.set([{ id: 1, x: 45, y: 0 }, { id: 2, x: 55, y: 0 }]);
  c.p._emit_pinch_frame();
  eq('两指距离<MIN 时不发射', c.deltas.length, 0);
  eq('  不更新参考距离', c.p._prevDistance, prev);
  // 重新拉开后能自愈并继续发射
  c.input.set([{ id: 1, x: 0, y: 0 }, { id: 2, x: 200, y: 0 }]);
  c.p._emit_pinch_frame();
  ok('  跨过冻结区后恢复发射', c.deltas.length >= 1, 'n=' + c.deltas.length);
}

/* ══════════ 3. 微动死区（比值与中点位移同时低于阈值才跳过） ══════════ */
{
  const c = makePinch();
  begin(c);
  c.input.set([{ id: 1, x: -15, y: 0 }, { id: 2, x: 115, y: 0 }]);
  c.p._emit_pinch_frame(); // 建参考 130，死区跳过
  eq('超容差但比值≈1 帧不发射', c.deltas.length, 0);
  // 距离 130.05 → 比值 1.00038 < 0.001 阈值，中点不变 → 仍跳过
  c.input.set([{ id: 1, x: -15.025, y: 0 }, { id: 2, x: 115.025, y: 0 }]);
  c.p._emit_pinch_frame();
  eq('  微动帧仍不发射（死区）', c.deltas.length, 0);
  // 中点明显移动但比值≈1 → 不应被死区吞掉
  c.input.set([{ id: 1, x: -5.025, y: 0 }, { id: 2, x: 125.025, y: 0 }]);
  c.p._emit_pinch_frame();
  ok('  中点位移大时仍发射（死区是 AND 条件）', c.deltas.length >= 1, 'n=' + c.deltas.length);
}

/* ══════════ 4. pending 阶段 BOTH 语义（两指都动才激活） ══════════ */
{
  const c = makePinch();
  c.p._isPending = true;
  c.p._pendingPinchIds = [1, 2];
  c.p._pendingStartPos0 = { x: 0, y: 0 };
  c.p._pendingStartPos1 = { x: 100, y: 0 };
  // 只有 finger0 移动 20px（> touch 容差 8），finger1 不动
  c.input.set([{ id: 1, x: 20, y: 0 }, { id: 2, x: 100, y: 0 }]);
  c.p._onInputMove({});
  eq('仅一指移动不激活（BOTH 语义）', c.p._isPinching, false);
  eq('  仍保持 pending', c.p._isPending, true);
  // finger1 也移动 30px
  c.input.set([{ id: 1, x: 20, y: 0 }, { id: 2, x: 130, y: 0 }]);
  c.p._onInputMove({});
  eq('两指都移动后激活', c.p._isPinching, true);
  eq('  pending 清除', c.p._isPending, false);
  eq('  onPinchStarted 触发一次', c.starts.length, 1);
}

/* ══════════ 5. 完成事件透传 virtualType ══════════ */
{
  const c = makePinch();
  begin(c);
  c.p._finishPinch(VirtualDeviceType.LostCapture);
  eq('完成事件 virtualType 透传', c.completes[0].virtualType, VirtualDeviceType.LostCapture);
  eq('完成后 isPinching=false', c.p.isPinching, false);
  eq('完成事件仅一次（幂等）', c.completes.length, 1);
  c.p._finishPinch(VirtualDeviceType.Device);
  eq('  重复 finish 不再发射', c.completes.length, 1);
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
