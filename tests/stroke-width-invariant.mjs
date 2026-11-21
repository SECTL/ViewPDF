// 笔迹线宽：落笔折算 + 渲染还原 = 屏幕粗细恒定；旧笔画不参与。
//
// 数学（否则这些断言看着莫名其妙）：
//   画布在页内容坐标系里尺寸恒定，显示缩放由外层 transform: scale(S) 提供。
//   画布上画 W，屏幕上看到 W × S。
//   要屏幕粗细恒为用户设定 P：  W × S = P  →  落笔时存 L = P / S_落笔
//   渲染时还原：                 W = L × S_落笔 / S_当前
//
// 两条硬约束：
//  1. 实时绘制期 S_当前 == S_落笔，折算因子为 1 —— 所以 batch-draw 不折算。
//     在那里乘 1/S 会把线宽缩小 S 倍，落笔瞬间看到的粗细就是错的。
//  2. **旧笔画没有 drawnScale 字段**，必须走旧行为（不折算）。旧 lineWidth 是
//     未经折算的内容单位，乘任何因子都会让已画的批注在缩放后粗细突变 —— 那正是
//     本功能要避免的（"过去的笔画绘制了就保持不变"）。
import fs from 'node:fs';

const READ = (p) => fs.readFileSync(p, 'utf8');
// 断言前剥注释：本项目注释极详细且常点名被断言的标识符，不剥会命中注释
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);
const none = (label, arr) => eq(label, arr.length, 0);

const SR = stripComments(READ('src/modules/canvas/stroke-renderer.js'));
const BD = stripComments(READ('src/modules/canvas/batch-draw.js'));
const TR = stripComments(READ('src/modules/canvas/tile-renderer.js'));
const DR = stripComments(READ('src/modules/pdf/document_reader.js'));
const DE = stripComments(READ('src/modules/blackboard/drawing-engine.js'));
const MAIN = READ('src/main.js');

const run = () => {
  // ===== 1. 落笔折算：两个面板都必须除以落笔缩放 =====
  ok('阅读器 lineWidth 除以落笔缩放',
    /lineWidth: type === 'draw' \? DRAW_CONFIG\.penWidth \/ s : baseEraserSize/.test(DR));
  ok('黑板 lineWidth 除以落笔缩放',
    /lineWidth: type === 'draw' \? DRAW_CONFIG\.penWidth \/ drawnScale : baseEraserSize/.test(DE));
  ok('阅读器记录 drawnScale', /drawnScale: s,/.test(DR));
  ok('黑板记录 drawnScale', /^\s*drawnScale,$/m.test(DE));
  ok('阅读器落笔缩放有分母保护', /_fetch_safe_reader_scale\(\)[\s\S]{0,200}> 0\.01 \? s : 1/.test(DR));

  // ===== 2. 渲染还原：drawnScale / renderScale =====
  ok('渲染侧算 rs（renderScale 带分母保护）',
    /const rs = Number\.isFinite\(renderScale\) && renderScale > 0\.01 \? renderScale : 1;/.test(SR));
  ok('折算因子 = 落笔缩放 / 当前缩放',
    /const strokeWScale = isErase \? 1 : \(strokeScale \/ rs\);/.test(SR));
  ok('drawnScale 读自 stroke 自身',
    /const drawn = Number\(stroke\.drawnScale\);/.test(SR));

  // ===== 3. 旧笔画同样要折算（落笔缩放取 1） =====
  // 曾经写成 `!hasDrawnScale ? 1 : ...`（旧笔画不折算），结果缩放时**所有**旧笔画
  // 都随页面变粗变细 —— 正是「缩放后所有笔画大小都变了」的成因。
  ok('折算因子对 erase 返回 1', /const strokeWScale = isErase \? 1 : \(strokeScale \/ rs\);/.test(SR));
  ok('旧笔画取落笔缩放 1（仍除 renderScale）',
    /const strokeScale = Number\.isFinite\(drawn\) && drawn > 0\.01 \? drawn : 1;/.test(SR));
  ok('baseLineWidth 仅在因子≠1 时才乘',
    /if \(strokeWScale !== 1\) baseLineWidth \*= strokeWScale;/.test(SR));

  // ===== 4. 每一处线宽读取都要折算（漏一处 = 同笔内粗细比例失真） =====
  {
    const n = [...SR.matchAll(/lineWidth = stroke\.(storedWidths|variableWidths)\[i\] \* strokeWScale;/g)].length;
    eq('逐点宽度折算 4 处（两循环 × 两数组）', n, 4);
  }
  ok('笔锋 scaleRatio 复用同一因子',
    /render_tessellated_stroke\(ctx, tessellated, strokeWScale\)/.test(SR));

  // ===== 5. 实时绘制不折算（折算因子此时恒为 1） =====
  ok('batch-draw 绘制用未折算的 lineWidth',
    /const drawWidth = lineWidth;/.test(BD));
  ok('batch-draw 里没有残留的 1/S 折算', !/_wScale\(\)/.test(BD));
  ok('storedWidths 存内容单位（与 lineWidth 同源）',
    /this\._storedWidths\.push\(lineWidth\);/.test(BD));

  // ===== 6. scale 通道确实接通 =====
  none('tile-renderer 不再有裸调用', [...TR.matchAll(/main_render_strokes_to_context\((ctx|offCtx), (\[\]|relevant)\)/g)]);
  eq('tile-renderer 4 个调用点都接了 _lastScale',
    [...TR.matchAll(/main_render_strokes_to_context\([^)]+, this\._lastScale\)/g)].length, 4);
  ok('main 转发 renderScale 且默认 1',
    /main_render_strokes_to_context\(ctx, strokes, renderScale = 1\)/.test(MAIN)
    && /renderStrokesToContext\(ctx, strokes, \{[\s\S]{0,120}renderScale\s*\}/.test(stripComments(MAIN)));
  ok('不得回到「临时改 window.state.scale」的全局做法',
    !/renderStrokesToContext[\s\S]{0,3000}window\.state\.scale\s*=/.test(SR));

  // ===== 7. 橡皮：尺寸不参与折算，但提示框要屏幕尺寸 =====
  ok('erase 不折算', /const strokeWScale = isErase \? 1 : \(strokeScale \/ rs\);/.test(SR));
  ok('黑板橡皮提示 = 内容单位 × 当前缩放',
    /eraser_size = \(this\.cached_draw_line_width[\s\S]{0,120}\* this\._fetch_safe_scale\(\)/.test(DE));
  ok('阅读器橡皮提示 = 内容单位 × dr_scale',
    /eraser_size = \(this\.cached_draw_line_width[\s\S]{0,120}\* \(this\.dr_scale \|\| 1\)/.test(DR));

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) process.exitCode = 1;
};

run();