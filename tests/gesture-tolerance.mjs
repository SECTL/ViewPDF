/**
 * gesture-tolerance.mjs —— 设备感知容差表的执行型守卫
 *
 * 把真实的 types.js / tolerance.js 源码剥掉 import/export 后在同一个 node:vm
 * 上下文里执行（tolerance 引用 types 的 DeviceType，必须在同一作用域）。
 * 这里不复制公式、不写正则形状断言——所有性质都靠调用函数/读取运行后的常量。
 * 变异测试见 gesture-tolerance-mutation.mjs。
 *
 * 用法：node tests/gesture-tolerance.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';

const DIR = 'src/modules/gesture/';
const read = (f) => fs.readFileSync(DIR + f, 'utf8');

// 把 ESM 的 import / export 剥掉，使声明落在同一脚本作用域里，末尾统一挂到
// globalThis.__G 上再取出。所有 import 都是单行、所有 export 都是声明或再导出。
function stripESM(src) {
  return src
    .replace(/^import\s+[^\n]*;\s*$/gm, '')
    .replace(/^export\s*\{[^\n]*?\}\s*from\s*['"][^'"]*['"];?\s*$/gm, '')
    .replace(/^export\s*\{[^\n]*\};?\s*$/gm, '')
    .replace(/^export\s+(?=(?:const|let|var|class|function|async)\b)/gm, '');
}

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const o = Object.is(got, want);
  if (o) pass++; else fail++;
  console.log((o ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
function ok(label, cond, extra = '') { eq(label + (extra ? '  ' + extra : ''), !!cond, true); }

// TouchEvent 桩：detectDeviceType / isRealMouse 用 instanceof 判断 touch 兜底。
class TouchEvent {}
const win = { TouchEvent };
const ctx = vm.createContext({ TouchEvent, window: win, console });
vm.runInContext(
  stripESM(read('types.js')) + '\n' + stripESM(read('tolerance.js')) +
  '\nglobalThis.__G = { DeviceType, VirtualDeviceType, DeviceButton, TOLERANCE,' +
  ' PINCH_MIN_DISTANCE, PINCH_FRAME_RATIO_MAX, PINCH_FRAME_RATIO_MIN,' +
  ' getTolerance, detectDeviceType, isRealMouse };',
  ctx
);
const G = ctx.__G;

/* ══════════ 1. 常量与单调性 ══════════ */
eq('DeviceType 三个值', [G.DeviceType.Mouse, G.DeviceType.Stylus, G.DeviceType.Touch].join(','), 'mouse,stylus,touch');
ok('DeviceType 被冻结', Object.isFrozen(G.DeviceType));
ok('TOLERANCE 被冻结', Object.isFrozen(G.TOLERANCE));

for (const k of ['DRAG', 'DRAG_LIGHT', 'HIT_TEST', 'PINCH']) {
  const t = G.TOLERANCE[k];
  ok('TOLERANCE.' + k + ' touch>stylus', t.touch > t.stylus,
    '(' + t.touch + ' vs ' + t.stylus + ')');
  ok('TOLERANCE.' + k + ' stylus>mouse', t.stylus > t.mouse,
    '(' + t.stylus + ' vs ' + t.mouse + ')');
}

eq('PINCH_MIN_DISTANCE===20', G.PINCH_MIN_DISTANCE, 20);
eq('PINCH_FRAME_RATIO_MAX===3', G.PINCH_FRAME_RATIO_MAX, 3);
ok('PINCH_FRAME_RATIO_MIN===1/3', Math.abs(G.PINCH_FRAME_RATIO_MIN - 1 / 3) < 1e-12,
  'got=' + G.PINCH_FRAME_RATIO_MIN);
ok('PINCH_FRAME_RATIO_MAX 与 MIN 互为倒数',
  Math.abs(G.PINCH_FRAME_RATIO_MAX * G.PINCH_FRAME_RATIO_MIN - 1) < 1e-12);

/* ══════════ 2. getTolerance 三分支 ══════════ */
{
  const set = { mouse: 1, touch: 2, stylus: 3 };
  eq('getTolerance Touch → touch', G.getTolerance(set, G.DeviceType.Touch), 2);
  eq('getTolerance Stylus → stylus', G.getTolerance(set, G.DeviceType.Stylus), 3);
  eq('getTolerance Mouse → mouse', G.getTolerance(set, G.DeviceType.Mouse), 1);
  eq('getTolerance 未知设备兜底 mouse', G.getTolerance(set, 'eraser'), 1);
  eq('getTolerance 传裸字符串 touch 也命中', G.getTolerance(G.TOLERANCE.PINCH, 'touch'),
    G.TOLERANCE.PINCH.touch);
}

/* ══════════ 3. detectDeviceType 的 pointerType 分支 ══════════ */
eq('detect pointerType touch → Touch', G.detectDeviceType({ pointerType: 'touch' }), 'touch');
eq('detect pointerType pen → Stylus', G.detectDeviceType({ pointerType: 'pen' }), 'stylus');
eq('detect pointerType mouse → Mouse', G.detectDeviceType({ pointerType: 'mouse' }), 'mouse');
eq('detect pointerType 其他 → Mouse', G.detectDeviceType({ pointerType: 'eraser' }), 'mouse');
eq('detect TouchEvent 实例（无 pointerType）→ Touch', G.detectDeviceType(new TouchEvent()), 'touch');
eq('detect 普通对象（无 pointerType）→ Mouse', G.detectDeviceType({}), 'mouse');

/* ══════════ 4. isRealMouse 的 pointerType 分支 ══════════ */
eq('isRealMouse pointerType mouse → true', G.isRealMouse({ pointerType: 'mouse' }), true);
eq('isRealMouse pointerType pen → false', G.isRealMouse({ pointerType: 'pen' }), false);
eq('isRealMouse pointerType touch → false', G.isRealMouse({ pointerType: 'touch' }), false);
eq('isRealMouse TouchEvent 实例 → false', G.isRealMouse(new TouchEvent()), false);
eq('isRealMouse 普通对象 → true', G.isRealMouse({}), true);

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
