// 钢笔笔锋曲面细分：node:vm 沙箱里跑真实 pen_tessellator.js，钉死三条口径——
//  1. 无效输入返回 null、成功时至少一段；
//  2. 段的几何只由 segments + scaleRatio 决定，与 DPR / 瓦片 / 视图变换 / 无关 options 无关；
//  3. 缓存是 WeakMap、封顶 200000、reset 后重建，storedWidths 与速度重算同构。
import fs from 'node:fs';
import vm from 'node:vm';

const PEN = 'src/modules/canvas/pen_tessellator.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);
const near = (label, got, want, tol = 1e-9) => ok(label + '  (' + String(got) + ' ≈ ' + String(want) + ')', Math.abs(got - want) <= tol);

// 剥注释：URL 里的双斜杠不能当注释头（沿用 dpr-harness 的口径）。
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const penSrc = fs.readFileSync(PEN, 'utf8');

// Path2D stub：只记录 moveTo/lineTo，便于验证「相邻 run 共享一个采样点」。
class Path2D {
  constructor() { this.ops = []; }
  moveTo(x, y) { this.ops.push(['M', x, y]); }
  lineTo(x, y) { this.ops.push(['L', x, y]); }
}

const sandbox = {
  window: { DRAW_CONFIG: { penMinWidthRatio: 0.4 } },
  Path2D,
  // 注入 host 的内建类型，保证 instanceof 在同一 realm 内可判定。
  WeakMap, Float32Array, Set, Map, Math, console, JSON, Number, Array, Object,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(penSrc, sandbox, { filename: 'pen_tessellator.js' });

const pt = sandbox.window.penTessellator;
eq('源文件创建了 window.penTessellator 实例', !!pt, true);
if (!pt) process.exit(1);

// 一条笔画：n 个点，坐标随 i 线性变化（几何可心算）。
const mkStroke = (n, extra = {}) => {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push({ fromX: i * 10, fromY: i * 20, toX: (i + 1) * 10, toY: (i + 1) * 20 });
  }
  return Object.assign({ points, lineWidth: 8, color: '#abc123' }, extra);
};
const geom = (ts) => ts.segments.map((s) => [s.x1, s.y1, s.x2, s.y2].join(',')).join('|');
const widths = (ts) => ts.segments.map((s) => s.line_width).join(',');

console.log('--- 1. 无效输入与默认回退 ---');
eq('null 输入返回 null', pt.tessellator_build_stroke_from_stroke_data(null), null);
eq('undefined 输入返回 null', pt.tessellator_build_stroke_from_stroke_data(undefined), null);
eq('空对象（无 points）返回 null', pt.tessellator_build_stroke_from_stroke_data({}), null);
eq('points 为空数组返回 null', pt.tessellator_build_stroke_from_stroke_data({ points: [] }), null);

const built = pt.tessellator_build_stroke_from_stroke_data(mkStroke(5), { noStartTaper: true });
ok('合法输入返回对象', !!built);
eq('返回 color 原样落地', built.color, '#abc123');
ok('成功时 segments >= 1', built.segments.length >= 1);
eq('段数 = 采样点数', built.segments.length, 5);
eq('段字段恰好是 x1/y1/x2/y2/line_width', Object.keys(built.segments[0]).sort().join(','), 'line_width,x1,x2,y1,y2');

{
  const noColor = pt.tessellator_build_stroke_from_stroke_data({ points: mkStroke(1).points }, { noStartTaper: true });
  eq('默认颜色回退 #3498db', noColor.color, '#3498db');
  const zero = {
    points: [
      { fromX: 0, fromY: 0, toX: 0, toY: 0 },
      { fromX: 0, fromY: 0, toX: 0, toY: 0 },
    ],
  };
  const zr = pt.tessellator_build_stroke_from_stroke_data(zero, { noStartTaper: true });
  for (let i = 0; i < zr.segments.length; i++) {
    near('零长笔迹默认线宽 5（未给 lineWidth 时回退）第 ' + i + ' 段', zr.segments[i].line_width, 5);
  }
}

console.log('--- 2. 缓存：WeakMap / 封顶 / reset / ratio 键 ---');
ok('_runsCache 是 WeakMap', pt._runsCache instanceof WeakMap);
eq('_MAX_CACHED_RUNS 封顶 200000', pt._MAX_CACHED_RUNS, 200000);

const cacheTs = pt.tessellator_build_stroke_from_stroke_data(mkStroke(4), {});
const runsA = pt._runs(cacheTs, 1);
const runsB = pt._runs(cacheTs, 1);
ok('同一 ts + 同一 ratio 命中缓存（返回同一数组引用）', runsA === runsB);
const runsC = pt._runs(cacheTs, 2);
ok('ratio 变化重建（缓存键含 ratio）', runsC !== runsA);
pt.reset_runs_cache();
eq('reset 后 _cachedRunCount 归零', pt._cachedRunCount, 0);
ok('reset 后旧条目不再命中', pt._runs(cacheTs, 1) !== runsA);

{
  const savedCap = pt._MAX_CACHED_RUNS;
  pt._MAX_CACHED_RUNS = 3;
  pt.reset_runs_cache();
  const arr = [0, 1, 2, 3].map(() => pt.tessellator_build_stroke_from_stroke_data(mkStroke(1), {}));
  const first = pt._runs(arr[0], 1);
  pt._runs(arr[1], 1);
  pt._runs(arr[2], 1);
  eq('未超上限时计数累加到 3', pt._cachedRunCount, 3);
  pt._runs(arr[3], 1);   // 3+1>3 → 整体作废，重新累计到 1
  eq('超上限后整体作废、计数从新段重新累计', pt._cachedRunCount, 1);
  ok('超上限作废后旧条目被清出缓存', pt._runs(arr[0], 1) !== first);
  pt._MAX_CACHED_RUNS = savedCap;
  pt.reset_runs_cache();
}

console.log('--- 3. 几何只由 segments + scaleRatio 决定 ---');
// 变宽笔画：storedWidths 长度必须 = points.length = raw.length-1 = 3。
const rampTs = pt.tessellator_build_stroke_from_stroke_data(mkStroke(3), { storedWidths: [10, 10, 20], noStartTaper: true });
const d1 = pt._build_sample_points(rampTs, 1);
ok('_build_sample_points 返回 Float32Array', d1 instanceof Float32Array);
eq('采样点数 = len*8+5 = 29', d1.length / 3, 29);

// 塞满 DPR / 瓦片 / 视图上下文，几何必须逐字节不变。
const baseline = Array.from(d1).join(',');
sandbox.window.devicePixelRatio = 3;
sandbox.window.DRAW_CONFIG.dpr = 4;
sandbox.window.DRAW_CONFIG.canvasW = 9999;
sandbox.window.DRAW_CONFIG.canvasH = 8888;
const dEnv = pt._build_sample_points(rampTs, 1);
eq('DPR / 画布尺寸等外部环境不影响几何', Array.from(dEnv).join(','), baseline);
sandbox.window.devicePixelRatio = 1;
sandbox.window.DRAW_CONFIG.dpr = 1;
delete sandbox.window.DRAW_CONFIG.canvasW;
delete sandbox.window.DRAW_CONFIG.canvasH;

// 无关 options 不影响分段几何（density 被读但未参与，dpr/tile/viewTransform 根本没读）。
const gBase = geom(pt.tessellator_build_stroke_from_stroke_data(mkStroke(3), {}));
const gNoisy = geom(pt.tessellator_build_stroke_from_stroke_data(mkStroke(3), {
  density: 9, dpr: 3, tile: { x: 1, y: 2 }, viewTransform: { a: 2, e: 5 },
}));
eq('DPR / 瓦片 / 视图 / density 等无关 options 不改变段几何', gNoisy, gBase);

// scaleRatio 只缩放宽度，x/y 不变。
const d2 = pt._build_sample_points(rampTs, 2);
for (const i of [0, 5, 17, 28]) {
  near('scaleRatio=2 时第 ' + i + ' 点 x 不变', d2[i * 3], d1[i * 3]);
  near('scaleRatio=2 时第 ' + i + ' 点 y 不变', d2[i * 3 + 1], d1[i * 3 + 1]);
  near('scaleRatio=2 时第 ' + i + ' 点宽度翻倍', d2[i * 3 + 2], d1[i * 3 + 2] * 2);
}

console.log('--- 4. 按宽度切段（WIDTH_EPSILON / 相邻段重叠一点） ---');
const rampRuns = pt._build_runs(rampTs, 1);
eq('变宽笔迹切成 9 段（WIDTH_EPSILON=0.5）', rampRuns.length, 9);
eq('9 段的宽度序列 = 10,11.25,...,20',
  rampRuns.map((r) => r.w).join(','), '10,11.25,12.5,13.75,15,16.25,17.5,18.75,20');
for (let i = 1; i < rampRuns.length; i++) {
  const prevOps = rampRuns[i - 1].path.ops;
  const prevLast = prevOps[prevOps.length - 1];
  const curFirst = rampRuns[i].path.ops[0];
  ok('run ' + (i - 1) + '/' + i + ' 共享一个采样点（交界无缺口）',
    prevLast[0] === 'L' && curFirst[0] === 'M' && prevLast[1] === curFirst[1] && prevLast[2] === curFirst[2]);
}
const constTs = pt.tessellator_build_stroke_from_stroke_data(mkStroke(3), { storedWidths: [8, 8, 8], noStartTaper: true });
eq('等宽笔迹只有 1 段', pt._build_runs(constTs, 1).length, 1);

console.log('--- 5. storedWidths 与速度重算同构 ---');
{
  const sw = [4, 6, 8, 10, 12];
  const a = pt.tessellator_build_stroke_from_stroke_data(mkStroke(5), { storedWidths: sw, noStartTaper: true });
  const b = pt.tessellator_build_stroke_from_stroke_data(mkStroke(5), { noStartTaper: true });
  eq('两模式结构同构（segments 数组 + color 字符串）',
    [Array.isArray(a.segments), typeof a.color].join(','), 'true,string');
  eq('两模式段数一致', a.segments.length, b.segments.length);
  eq('两模式几何一致', geom(a), geom(b));
  eq('storedWidths 模式宽度原样落地', widths(a), sw.join(','));
  ok('速度重算模式确实在算（宽度非恒定）', new Set(b.segments.map((s) => s.line_width)).size > 1);
}

console.log('--- 6. 起笔渐变（taper） ---');
{
  const taper = pt.tessellator_build_stroke_from_stroke_data(mkStroke(6), {});
  const noTaper = pt.tessellator_build_stroke_from_stroke_data(mkStroke(6), { noStartTaper: true });
  let diff = 0;
  for (let i = 0; i < 4; i++) if (!Object.is(taper.segments[i].line_width, noTaper.segments[i].line_width)) diff++;
  eq('默认起笔渐变恰好影响前 4 段', diff, 4);
  const sw = [5, 5, 5, 5, 5, 5];
  const sTaper = pt.tessellator_build_stroke_from_stroke_data(mkStroke(6), { storedWidths: sw });
  const sNoTaper = pt.tessellator_build_stroke_from_stroke_data(mkStroke(6), { storedWidths: sw, noStartTaper: true });
  eq('storedWidths 模式不受 taper 叠加（宽度已含渐变）', widths(sTaper), widths(sNoTaper));
}

console.log('--- 7. 渲染 ---');
{
  const calls = [];
  const ctx = {
    stroke() { calls.push(this.lineWidth); },
  };
  pt.tessellator_render_stroke(ctx, rampTs, 1);
  eq('strokeStyle 取自笔画颜色', ctx.strokeStyle, rampTs.color);
  eq('lineCap = round', ctx.lineCap, 'round');
  eq('lineJoin = round', ctx.lineJoin, 'round');
  eq('globalCompositeOperation = source-over', ctx.globalCompositeOperation, 'source-over');
  eq('每个 run 发一次 stroke（9 次）', calls.length, 9);
  eq('stroke 宽度序列与 run 宽度一致', calls.join(','), rampRuns.map((r) => r.w).join(','));

  const calls2 = [];
  pt.tessellator_render_stroke({ stroke() { calls2.push(1); } }, null, 1);
  eq('无效笔画不触发任何 stroke', calls2.length, 0);
}

console.log('--- 8. 源码常量（剥注释后判定） ---');
{
  const t = strip(penSrc);
  ok('SUBDIVS = 8（源码常量）', /const\s+SUBDIVS\s*=\s*8\s*;/.test(t));
  ok('WIDTH_EPSILON = 0.5（源码常量）', /const\s+WIDTH_EPSILON\s*=\s*0\.5\s*;/.test(t));
  ok('_runsCache 声明为 new WeakMap()（源码常量）', /this\._runsCache\s*=\s*new\s+WeakMap\(\)/.test(t));
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
