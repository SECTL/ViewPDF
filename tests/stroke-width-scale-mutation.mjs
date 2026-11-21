// 逐个改坏笔迹线宽折算的不变式，断言 stroke-width-scale.mjs 变红。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/stroke-width-scale.mjs';
const SRC = 'src/modules/pdf/document_reader.js';
const ORIG = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, 'tests', 'stroke-width-scale.mjs'));
fs.mkdirSync(path.join(tmpDir, 'src', 'modules', 'pdf'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'modules', 'canvas'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'modules', 'blackboard'), { recursive: true });
const dst = path.join(tmpDir, SRC);
// harness 还会读小黑板与渲染侧，两个也复制过去
fs.copyFileSync('src/modules/blackboard/drawing-engine.js', path.join(tmpDir, 'src/modules/blackboard/drawing-engine.js'));
fs.copyFileSync('src/modules/canvas/stroke-renderer.js', path.join(tmpDir, 'src/modules/canvas/stroke-renderer.js'));

const M = [
  {
    label: 'lineWidth 不折算（旧实现：放大后画的线屏幕上粗一倍）',
    expect: 'scale=2: lineWidth = penWidth / scale',
    from: "lineWidth: type === 'draw' ? DRAW_CONFIG.penWidth * inv_scale : baseEraserSize,",
    to: "lineWidth: type === 'draw' ? DRAW_CONFIG.penWidth : baseEraserSize,",
  },
  {
    label: '折算方向反了（乘 scale 而不是除）',
    expect: 'scale=2: lineWidth = penWidth / scale',
    from: 'const inv_scale = this.dr_cached_inv_scale || 1;',
    to: 'const inv_scale = this.dr_scale || 1;',
  },
  {
    label: 'scale 字段回到硬编码 1（渲染侧兜底永远算原值）',
    expect: 'scale=2: scale 字段记真实缩放',
    from: 'scale: this.dr_scale || 1,',
    to: 'scale: 1,',
  },
  {
    label: 'current_line_width 没折算（与线宽不同量纲）',
    expect: 'scale=2: current_line_width 同步折算',
    from: 'this.current_line_width = DRAW_CONFIG.penWidth * inv_scale;',
    to: 'this.current_line_width = DRAW_CONFIG.penWidth;',
  },
  {
    label: 'last_line_width 没折算',
    expect: 'scale=2: last_line_width 同步折算',
    from: 'this.last_line_width = DRAW_CONFIG.penWidth * inv_scale;',
    to: 'this.last_line_width = DRAW_CONFIG.penWidth;',
  },
  {
    label: 'cached_draw_line_width 没折算（实时预览与最终结果不符）',
    expect: 'scale=2: cached_draw_line_width 同步折算',
    from: "this.cached_draw_line_width = type === 'draw' ? DRAW_CONFIG.penWidth * inv_scale : baseEraserSize;",
    to: "this.cached_draw_line_width = type === 'draw' ? DRAW_CONFIG.penWidth : baseEraserSize;",
  },
  {
    label: 'eraserSize 也没折算（橡皮擦在放大后粗一倍）',
    expect: 'erase scale=2: eraserSize 折算',
    from: 'const baseEraserSize = DRAW_CONFIG.eraserSize * inv_scale;',
    to: 'const baseEraserSize = DRAW_CONFIG.eraserSize;',
  },
  {
    label: 'eraserSizeRaw 也被折算（渲染侧兜底 eraserSizeRaw/scale 对不上）',
    expect: 'erase scale=2: eraserSizeRaw 保持未折算原值',
    from: 'eraserSizeRaw: DRAW_CONFIG.eraserSize,',
    to: 'eraserSizeRaw: DRAW_CONFIG.eraserSize * inv_scale,',
  },
  {
    label: '_save_stroke_point 的每点重置不折算（抬笔瞬间线宽跳一下）',
    expect: '每点重置的预览宽已折算',
    from: 'this.cached_draw_line_width = DRAW_CONFIG.penWidth * this.dr_cached_inv_scale;',
    to: 'this.cached_draw_line_width = DRAW_CONFIG.penWidth;',
  },
  {
    label: '擦除分支的每点重置不折算',
    expect: 'erase scale=2: 每点重置的预览宽已折算',
    from: 'this.cached_draw_line_width = DRAW_CONFIG.eraserSize * this.dr_cached_inv_scale;',
    to: 'this.cached_draw_line_width = DRAW_CONFIG.eraserSize;',
  },
  {
    label: '折算用固定的 1 而不是真实缩放（缩放后失效）',
    expect: 'scale=4: lineWidth = penWidth / scale',
    from: 'const inv_scale = this.dr_cached_inv_scale || 1;',
    to: 'const inv_scale = 1;',
  },
  {
    label: '小黑板的折算被改坏（三处画布行为分叉）',
    expect: '小黑板同样按 inv_scale 折算',
    from: "lineWidth: type === 'draw' ? DRAW_CONFIG.penWidth * inv_scale : baseEraserSize,",
    to: "lineWidth: type === 'draw' ? DRAW_CONFIG.penWidth : baseEraserSize,",
    other: 'src/modules/blackboard/drawing-engine.js',
  },
  {
    label: '渲染侧开始按 renderScale 再乘一次缩放（双重折算）',
    expect: '渲染侧仍按「书写时已折算」的约定',
    from: 'export async function renderStrokesToContext(ctx, strokes, options = {}) {',
    to: 'export async function renderStrokesToContext(ctx, strokes, options = {}) {\n    const _renderScale = options.renderScale || 1;',
    other: 'src/modules/canvas/stroke-renderer.js',
  },
];

let pass = 0, fail = 0;

for (const m of M) {
  const targetRel = m.other || SRC;
  const orig = m.other ? fs.readFileSync(m.other, 'utf8').replace(/\r\n/g, '\n') : ORIG;
  const dstFile = m.other ? path.join(tmpDir, m.other) : dst;
  const hits = orig.split(m.from).length - 1;
  if (hits !== 1) {
    fail++;
    console.log('FAIL  [' + m.label + '] 锚点在 ' + targetRel + ' 出现 ' + hits + ' 次（必须恰好 1 次）');
    continue;
  }
  const mutated = orig.replace(m.from, m.to);
  if (mutated === orig) { fail++; console.log('FAIL  [' + m.label + '] 空操作变异'); continue; }
  fs.writeFileSync(dstFile, mutated, 'utf8');

  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000, env: { ...process.env, READER_SRC: SRC } }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }

  const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) { pass++; console.log('PASS  ' + m.label); }
  else {
    fail++;
    console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）');
    console.log(out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 2).map((l) => '        ' + l).join('\n'));
  }
  fs.writeFileSync(dstFile, orig, 'utf8');   // 还原
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;