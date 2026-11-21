// 新画笔画的线宽必须与坐标用同一个 inv_scale 折算 —— 否则放大后画的线在屏幕上
// 明显更粗，且长宽比失真（同样划 100px：scale=1 得 100×5，scale=2 得 100×10）。
//
// 真跑 _start_stroke / _save_stroke_point，验的是真代码不是复刻品。
import fs from 'node:fs';

const SRC = fs.readFileSync(process.env.READER_SRC || 'src/modules/pdf/document_reader.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);
const near = (label, got, want, tol = 1e-9) => ok(label + '  (' + String(got) + ' ≈ ' + String(want) + ')', Math.abs(got - want) <= tol);

// penWidth=5 / eraserSize=15 —— 取整数值，便于心算核对
const DRAW_CONFIG = { penWidth: 5, eraserSize: 15, penColor: '#f00' };
const MOCK_WINDOW = { DRAW_CONFIG };

// 抠出的方法体要两样东西才对得上：**方法的形参**和 **window**。
// window 用闭包捕获（工厂函数的最后一个形参），**不要**把它当成返回函数的形参：
// 后者会被调用方的实参顶掉 —— 而且这里还有一个更隐蔽的坑：包装器写成
// `function (self, ...args)` 再用 `.call(mock, x)` 调用时，`.call` 的第一个参数
// 是 this 而非形参，于是 self 拿到 x、args 为空，报错却是
// 「Cannot read properties of undefined (reading 'DRAW_CONFIG')」，
// 与真实原因毫无关系。
function extractMethod(name, paramNames) {
  const m = new RegExp('(?:^|\\n)    ' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(SRC);
  if (!m) { console.log('FAIL  未找到 ' + name); return null; }
  try {
    const factory = new Function(...paramNames, 'window',
      'return function (' + paramNames.join(', ') + ') {\n' + m[1] + '\n}');
    // 形参占位传 undefined，window 落进闭包
    return factory(...paramNames.map(() => undefined), MOCK_WINDOW);
  } catch (e) { console.log('FAIL  抠 ' + name + ' 失败: ' + e.message); return null; }
}

const startStroke = extractMethod('_start_stroke', ['type']);
const savePoint = extractMethod('_save_stroke_point', ['from_x', 'from_y', 'to_x', 'to_y', 'pressure']);
eq('抠出 _start_stroke', !!startStroke, true);
eq('抠出 _save_stroke_point', !!savePoint, true);
if (!startStroke || !savePoint) process.exit(1);

// 一个最小可用的 reader mock
const mkReader = (scale) => ({
  dr_scale: scale,
  dr_cached_inv_scale: 1 / scale,
  batch_draw: { batch_draw_init_start() {}, _storedWidths: [] },
});

const run = () => {
  // ===== 1. 基础折算 =====
  for (const scale of [1, 2, 4, 0.5, 3]) {
    const inv = 1 / scale;
    const r = mkReader(scale);
    startStroke.call(r, 'draw');
    near(`scale=${scale}: lineWidth = penWidth / scale`, r.current_stroke.lineWidth, 5 * inv);
    eq(`scale=${scale}: scale 字段记真实缩放`, r.current_stroke.scale, scale);
    near(`scale=${scale}: current_line_width 同步折算`, r.current_line_width, 5 * inv);
    near(`scale=${scale}: last_line_width 同步折算`, r.last_line_width, 5 * inv);
    near(`scale=${scale}: cached_draw_line_width 同步折算`, r.cached_draw_line_width, 5 * inv);
  }

  // ===== 2. 橡皮擦同样折算，eraserSizeRaw 保持原值 =====
  for (const scale of [1, 2, 4]) {
    const inv = 1 / scale;
    const r = mkReader(scale);
    startStroke.call(r, 'erase');
    near(`erase scale=${scale}: eraserSize 折算`, r.current_stroke.eraserSize, 15 * inv);
    eq(`erase scale=${scale}: eraserSizeRaw 保持未折算原值`, r.current_stroke.eraserSizeRaw, 15);
    near(`erase scale=${scale}: cached_draw_line_width 折算`, r.cached_draw_line_width, 15 * inv);
    // stroke-renderer 的兜底：eraserSize 缺失时用 eraserSizeRaw / scale 还原，
    // 两者必须能对上，否则该兜底路径算出的宽度与主路径不同
    const restored = r.current_stroke.eraserSizeRaw / (r.current_stroke.scale || 1);
    near(`erase scale=${scale}: eraserSizeRaw/scale 能还原出 eraserSize`, restored, r.current_stroke.eraserSize);
  }

  // ===== 3. 核心不变式：长宽比与缩放无关 =====
  // 手指划固定 100px **屏幕**距离 → 文档距离 = 100 * inv；
  // 线宽是文档单位，渲染时整块 canvas 乘 scale 才回到屏幕。
  // 比值必须在**同一坐标系**里算 —— 分子取屏幕、分母取文档会凭空得出一个
  // 随 scale 线性变化的结果（第一版就这么写，然后「证明」了 bug 依然存在）。
  const SCREEN_PX = 100;
  const ratios = [];
  for (const scale of [1, 2, 4, 0.5]) {
    const r = mkReader(scale);
    startStroke.call(r, 'draw');
    const docLen = SCREEN_PX / scale;              // 文档空间长度
    const docWidth = r.current_stroke.lineWidth;   // 文档空间线宽
    ratios.push({ scale, ratio: docWidth / docLen });
  }
  const base = ratios[0].ratio;
  near('scale=1: 文档空间长宽比 = penWidth/100', base, 5 / 100);
  for (const r of ratios) {
    near(`scale=${r.scale}: 长宽比与 scale=1 相同`, r.ratio, base);
  }

  // 反证：若线宽**不**折算，文档空间比值会随 scale 线性变化（scale=2 就是两倍）
  {
    const un = [1, 2, 4].map((s) => 5 / (SCREEN_PX / s));   // 不折算：docWidth 恒为 5
    near('（反证）未折算时 scale=2 的比值是 scale=1 的两倍', un[1], un[0] * 2);
    near('（反证）未折算时 scale=4 的比值是四倍', un[2], un[0] * 4);
    // 而折算后 docWidth 与 docLen 同时被 1/scale 缩小，比值被约掉
    const folded = [1, 2, 4].map((s) => (5 / s) / (SCREEN_PX / s));
    near('（反证）折算后比值恒定', folded[2], folded[0]);
  }

  // ===== 4. _save_stroke_point 每点重置也必须折算 =====
  for (const scale of [1, 2, 4]) {
    const inv = 1 / scale;
    const r = {
      dr_scale: scale, dr_cached_inv_scale: inv,
      batch_draw: { batch_draw_init_start() {}, _storedWidths: [] },
      current_pressure: 0.5, current_line_width: 5 * inv, last_line_width: 5 * inv,
      current_stroke: { type: 'draw', lineWidth: 5 * inv, variableWidths: [], points: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } },
      cached_draw_line_width: 5 * inv,
    };
    savePoint.call(r, 0, 0, 10, 10, 0.5);
    near(`scale=${scale}: 每点重置的预览宽已折算（不折算则抬笔瞬间线宽跳变）`,
      r.cached_draw_line_width, 5 * inv);
    eq(`scale=${scale}: variableWidths 与基础宽同量纲`,
      r.current_stroke.variableWidths.length > 0, true);
  }
  {
    // 预览宽必须与当前线宽同量纲，否则 batch-draw 画出来的预览与最终不一致
    const scale = 2, inv = 0.5;
    const r = {
      dr_scale: scale, dr_cached_inv_scale: inv,
      batch_draw: { batch_draw_init_start() {}, _storedWidths: [] },
      current_pressure: 0.5, current_line_width: 5 * inv, last_line_width: 5 * inv,
      current_stroke: { type: 'draw', lineWidth: 5 * inv, variableWidths: [], points: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } },
      cached_draw_line_width: 5 * inv,
    };
    savePoint.call(r, 0, 0, 10, 10, 0.5);
    near('预览宽与 current_line_width 同量纲',
      r.cached_draw_line_width, r.current_line_width, 1e-6);
  }
  {
    // 擦除分支的每点重置同样要覆盖 —— 少了这一段，那个变异一次都抓不到：
    // draw 分支的断言只读 penWidth 折算值，而这条分支重置的是 eraserSize，
    // 两条赋值互不相干。
    for (const scale of [1, 2, 4]) {
      const inv = 1 / scale;
      const r = {
        dr_scale: scale, dr_cached_inv_scale: inv,
        batch_draw: { batch_draw_init_start() {}, _storedWidths: [] },
        current_pressure: 0.5, current_line_width: 5 * inv, last_line_width: 5 * inv,
        current_stroke: { type: 'erase', lineWidth: 15 * inv, eraserSize: 15 * inv, variableWidths: [], points: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } },
        cached_draw_line_width: 15 * inv,
      };
      savePoint.call(r, 0, 0, 10, 10, 0.5);
      near(`erase scale=${scale}: 每点重置的预览宽已折算`,
        r.cached_draw_line_width, 15 * inv);
    }
  }

  // ===== 5. 橡皮提示框仍与实际擦除直径一致 =====
  // _eraser_hint 用 `cached_draw_line_width * dr_scale` 得屏幕像素；
  // 实际擦除直径 = stroke.eraserSize（文档单位）× scale。两者必须相等。
  for (const scale of [1, 2, 4]) {
    const inv = 1 / scale;
    const r = mkReader(scale);
    startStroke.call(r, 'erase');
    const hintPx = r.cached_draw_line_width * scale;
    const realPx = r.current_stroke.eraserSize * scale;
    near(`scale=${scale}: 提示框尺寸 = 实际擦除直径`, hintPx, realPx);
  }

  // ===== 6. 与小黑板的一致性（那边本来就对）=====
  {
    const bb = fs.readFileSync('src/modules/blackboard/drawing-engine.js', 'utf8');
    ok('小黑板同样按 inv_scale 折算 lineWidth',
      /lineWidth:\s*type === 'draw' \? DRAW_CONFIG\.penWidth \* inv_scale : baseEraserSize/.test(bb));
    ok('小黑板同样写真实 scale', /scale:\s*this\.coord\.get_scale\(\) \|\| 1/.test(bb));
  }

  // ===== 7. 渲染侧的约定没被改动破坏 =====
  {
    const sr = fs.readFileSync('src/modules/canvas/stroke-renderer.js', 'utf8');
    ok('渲染侧仍按「书写时已折算」的约定（不乘缩放）',
      !/renderScale/.test(sr.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')));
  }

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) process.exitCode = 1;
};

run();
