/**
 * gesture-drag-tap.mjs —— 拖拽/轻触转换与事件源归一化的执行型守卫
 *
 * 真实 types.js / tolerance.js / drag-tap-converter.js / input-source.js /
 * drag-tap-source.js 剥掉 ESM 关键字后在同一 node:vm 上下文执行。
 * 断言：tap/drag 阈值判定（含 >= 边界）、欧氏距离、delta 偏移、
 * 设备容差选择、指针按钮归一化、活跃指针追踪。
 * 变异测试见 gesture-drag-tap-mutation.mjs。
 *
 * 用法：node tests/gesture-drag-tap.mjs
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

class TouchEvent {}
const ctx = vm.createContext({
  window: { TouchEvent, PointerEvent: function () {} },
  TouchEvent,
  console,
});
vm.runInContext([
  'types.js', 'tolerance.js', 'drag-tap-converter.js', 'input-source.js', 'drag-tap-source.js',
].map((f) => stripESM(read(f))).join('\n') +
  '\nglobalThis.__G = { DeviceType, VirtualDeviceType, DeviceButton,' +
  ' DeviceInputDragEvent, TOLERANCE, getTolerance, detectDeviceType,' +
  ' DragTapConverter, InputSource, DragTapSource };',
  ctx
);
const G = ctx.__G;
const { DeviceType, VirtualDeviceType, DeviceButton, DragTapConverter,
  InputSource, DragTapSource } = G;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const o = Object.is(got, want);
  if (o) pass++; else fail++;
  console.log((o ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
function ok(label, cond, extra = '') { eq(label + (extra ? '  ' + extra : ''), !!cond, true); }

/* ══════════ 1. DragTapConverter: tap vs drag ══════════ */
{
  const c = new DragTapConverter();
  let tap = null, started = 0, completed = 0;
  c.onTap = (...a) => { tap = a; };
  c.onDragStarted = () => { started++; };
  c.onDragCompleted = () => { completed++; };
  c.down(10, 10, 5);
  c.move(12, 10); // 距离 2 < 5
  c.up(12, 10);
  ok('dist<tolerance → tap', tap !== null);
  eq('  tap 参数 (ox,oy,cx,cy)', tap ? tap.join(',') : 'null', '10,10,12,10');
  eq('  tap 路径无 drag', started + completed, 0);
  eq('  up 后 isDragging=false', c.isDragging, false);
}
{
  const c = new DragTapConverter();
  let started = null, completed = null;
  const deltas = [];
  c.onDragStarted = (...a) => { started = a; };
  c.onDragDelta = (...a) => { deltas.push(a); };
  c.onDragCompleted = (...a) => { completed = a; };
  c.down(0, 0, 5);
  c.move(3, 4); // 欧氏距离恰 5 === tolerance
  ok('dist===tolerance → drag started（>= 边界）', c.isDragging);
  eq('  started (ox,oy,cx,cy)', started ? started.slice(0, 4).join(',') : 'null', '0,0,3,4');
  eq('  started 四个偏移全 0', started ? started.slice(4).join(',') : 'null', '0,0,0,0');
  eq('  首个 delta 已发射', deltas.length, 1);
  c.move(6, 4); // dxo=6,dyo=4, ddx=3,ddy=0
  eq('  第二个 delta', deltas.length, 2);
  eq('  delta 偏移 dxo,dyo,ddx,ddy', deltas[1] ? deltas[1].slice(4).join(',') : 'null', '6,4,3,0');
  c.up(10, 10); // dxo=10,dyo=10, ddx=4,ddy=6
  eq('  completed 偏移', completed ? completed.slice(4).join(',') : 'null', '10,10,4,6');
  eq('  up 后 isDragging=false', c.isDragging, false);
}
{
  const c = new DragTapConverter();
  let started = 0;
  c.onDragStarted = () => { started++; };
  c.down(0, 0, 5);
  c.move(3, 3); // 欧氏 4.24 < 5；曼哈顿 6 >= 5
  eq('对角线用欧氏距离（3,3 在 tol=5 内不触发）', started, 0);
  c.move(4, 4); // 欧氏 5.657 >= 5
  eq('  超过后触发 drag', started, 1);
}
/* ══════════ 2. DragTapSource: 按设备类型选择容差 ══════════ */
function fakeInput() {
  const handlers = {};
  return {
    handlers,
    on(n, f) { (handlers[n] || (handlers[n] = [])).push(f); },
    off() {},
    emit(n, d) { (handlers[n] || []).forEach((f) => f(d)); },
  };
}
{
  const input = fakeInput();
  const src = new DragTapSource(input, {});
  const taps = [];
  let dragStarted = 0;
  src.onTap = (e) => taps.push(e);
  src.onDragStarted = () => { dragStarted++; };
  input.emit('inputStarting', { id: 1 });
  input.emit('inputStarted', { id: 1, type: DeviceType.Touch, button: DeviceButton.Left });
  input.emit('inputDown', { id: 1, type: DeviceType.Touch, button: DeviceButton.Left, position: { x: 0, y: 0 } });
  input.emit('inputMove', { id: 1, position: { x: 12, y: 0 } }); // touch tol=16 → 仍 tap
  input.emit('inputUp', { id: 1, position: { x: 12, y: 0 }, virtualType: VirtualDeviceType.Device });
  eq('touch 12px 移动仍是 tap（tol=16）', taps.length, 1);
  eq('  无 dragStarted', dragStarted, 0);
  eq('  tap 事件包装 position', taps[0] ? [taps[0].position.x, taps[0].position.y].join(',') : 'null', '12,0');
}
{
  const input = fakeInput();
  const src = new DragTapSource(input, {});
  let dragStarted = 0, completed = 0;
  src.onDragStarted = () => { dragStarted++; };
  src.onDragCompleted = () => { completed++; };
  input.emit('inputStarted', { id: 2, type: DeviceType.Mouse, button: DeviceButton.Left });
  input.emit('inputDown', { id: 2, type: DeviceType.Mouse, button: DeviceButton.Left, position: { x: 0, y: 0 } });
  input.emit('inputMove', { id: 2, position: { x: 12, y: 0 } }); // mouse tol=1 → drag
  input.emit('inputUp', { id: 2, position: { x: 12, y: 0 }, virtualType: VirtualDeviceType.Device });
  eq('mouse 12px 移动触发 drag（tol=1）', dragStarted, 1);
  eq('  并完成 drag', completed, 1);
}

/* ══════════ 3. InputSource: 事件源归一化 ══════════ */
{
  const is = Object.create(InputSource.prototype);
  eq('_getPointerButton button=2 → Right', is._getPointerButton({ button: 2 }), DeviceButton.Right);
  eq('_getPointerButton button=1 → Middle', is._getPointerButton({ button: 1 }), DeviceButton.Middle);
  eq('_getPointerButton buttons=32 → Context', is._getPointerButton({ button: 0, buttons: 32 }), DeviceButton.Context);
  eq('_getPointerButton 默认 → Left', is._getPointerButton({ button: 0, buttons: 0 }), DeviceButton.Left);
}
{
  const listeners = {};
  const el = {
    addEventListener(n, f) { (listeners[n] || (listeners[n] = [])).push(f); },
    removeEventListener() {},
  };
  const src = new InputSource(el);
  src.attach();
  const fire = (n, ev) => (listeners[n] || []).forEach((f) => f(ev));
  const mk = (id, x, type = 'mouse') => ({
    pointerId: id, clientX: x, clientY: 0, pointerType: type,
    button: 0, buttons: 1, preventDefault() {}, target: {},
  });
  fire('pointerdown', mk(1, 10));
  fire('pointerdown', mk(2, 20));
  eq('两指 down 后 activeCount=2', src.activeCount, 2);
  fire('pointermove', mk(1, 30));
  eq('pointermove 更新对应指针位置', src.activeEvents.find((e) => e.id === 1).position.x, 30);
  fire('pointerup', mk(1, 30));
  eq('pointerup 后 activeCount=1', src.activeCount, 1);
  eq('  剩余指针正确', src.activeEvents[0].id, 2);
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
