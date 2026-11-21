// 逐个改坏笔迹线宽的不变式，断言 stroke-width-invariant.mjs 变红。
// 重点：三类真实退化 —— 落笔不折算（新笔画随缩放变粗细）、渲染多折/少折、
// 以及**旧笔画被牵连**（本次的核心约束：过去画的保持不变）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/stroke-width-invariant.mjs';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strokew-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, 'tests', 'stroke-width-invariant.mjs'));

const F = {
  sr: 'src/modules/canvas/stroke-renderer.js',
  bd: 'src/modules/canvas/batch-draw.js',
  tr: 'src/modules/canvas/tile-renderer.js',
  dr: 'src/modules/pdf/document_reader.js',
  de: 'src/modules/blackboard/drawing-engine.js',
  main: 'src/main.js',
};
for (const f of Object.values(F)) {
  fs.mkdirSync(path.join(tmpDir, path.dirname(f)), { recursive: true });
  fs.copyFileSync(f, path.join(tmpDir, f));
}

const M = [
  {
    label: '阅读器落笔不除缩放（新笔画回到「随缩放变粗细」）',
    expect: '阅读器 lineWidth 除以落笔缩放',
    file: F.dr,
    from: 'lineWidth: type === \'draw\' ? DRAW_CONFIG.penWidth / s : baseEraserSize,',
    to: 'lineWidth: type === \'draw\' ? DRAW_CONFIG.penWidth : baseEraserSize,',
  },
  {
    label: '黑板落笔不除缩放',
    expect: '黑板 lineWidth 除以落笔缩放',
    file: F.de,
    from: 'lineWidth: type === \'draw\' ? DRAW_CONFIG.penWidth / drawnScale : baseEraserSize,',
    to: 'lineWidth: type === \'draw\' ? DRAW_CONFIG.penWidth : baseEraserSize,',
  },
  {
    label: '阅读器不记录 drawnScale（渲染无从还原）',
    expect: '阅读器记录 drawnScale',
    file: F.dr,
    from: 'drawnScale: s,',
    to: '',
  },
  {
    label: '黑板不记录 drawnScale',
    expect: '黑板记录 drawnScale',
    file: F.de,
    from: 'drawnScale,',
    to: '',
  },
  {
    label: '折算因子退化成 1（等于没做视觉恒定）',
    expect: '折算因子 = 落笔缩放 / 当前缩放',
    file: F.sr,
    from: ': (strokeScale / rs);',
    to: ': 1;',
  },
  {
    label: '折算方向反了（rs/strokeScale → 缩放时线宽反比变化）',
    expect: '折算因子 = 落笔缩放 / 当前缩放',
    file: F.sr,
    from: '(strokeScale / rs);',
    to: '(rs / strokeScale);',
  },
  // —— 核心约束 ——
  {
    // 这条变异复现的是我改错的那一版：旧笔画不折算 → 缩放时所有旧笔画都变粗变细
    label: '旧笔画不折算（复现「缩放后所有笔画都变了」）',
    expect: '旧笔画取落笔缩放 1（仍除 renderScale）',
    file: F.sr,
    from: 'const strokeScale = Number.isFinite(drawn) && drawn > 0.01 ? drawn : 1;',
    to: 'const strokeScale = Number.isFinite(drawn) && drawn > 0.01 ? drawn : 0;',
  },
  {
    label: '落笔缩放缺字段时整个折算失效（新笔画也随缩放变）',
    expect: '折算因子对 erase 返回 1',
    file: F.sr,
    from: 'const strokeWScale = isErase ? 1 : (strokeScale / rs);',
    to: 'const strokeWScale = 1;',
  },
  {
    label: 'rs 去掉分母保护（renderScale=0 → 折算因子 Infinity）',
    expect: '渲染侧算 rs（renderScale 带分母保护）',
    file: F.sr,
    from: 'Number.isFinite(renderScale) && renderScale > 0.01 ? renderScale : 1;',
    to: 'true ? renderScale : 1;',
  },
  {
    label: 'baseLineWidth 无条件乘（旧笔画被折算）',
    expect: 'baseLineWidth 仅在因子≠1 时才乘',
    file: F.sr,
    from: 'if (strokeWScale !== 1) baseLineWidth *= strokeWScale;',
    to: 'baseLineWidth *= strokeWScale;',
  },
  {
    label: '四处逐点折算漏一处（同一笔内粗细比例失真）',
    expect: '逐点宽度折算 4 处',
    file: F.sr,
    from: 'lineWidth = stroke.variableWidths[i] * strokeWScale;',
    to: 'lineWidth = stroke.variableWidths[i];',
    replaceAll: true,
  },
  {
    label: '笔锋路径漏改（普通笔迹恒定、笔锋仍随缩放）',
    expect: '笔锋 scaleRatio 复用同一因子',
    file: F.sr,
    from: 'render_tessellated_stroke(ctx, tessellated, strokeWScale);',
    to: 'render_tessellated_stroke(ctx, tessellated, 1);',
  },
  {
    label: '实时绘制又折算一次（落笔瞬间线宽缩小 S 倍）',
    expect: 'batch-draw 绘制用未折算的 lineWidth',
    file: F.bd,
    from: 'const drawWidth = lineWidth;',
    to: 'const drawWidth = lineWidth * this._wScale();',
  },
  {
    label: 'tile-renderer 有调用点漏传 scale（局部视觉不一致）',
    expect: 'tile-renderer 4 个调用点都接了 _lastScale',
    file: F.tr,
    from: 'window.main_render_strokes_to_context(ctx, [stroke], this._lastScale);',
    to: 'window.main_render_strokes_to_context(ctx, [stroke]);',
    replaceAll: true,
  },
  {
    label: 'main 转发时丢掉 renderScale',
    expect: 'main 转发 renderScale 且默认 1',
    file: F.main,
    from: 'penManager: realPenManager,\n        renderScale',
    to: 'penManager: realPenManager',
  },
  {
    label: '退回「临时改 window.state.scale」的全局做法',
    expect: '不得回到「临时改 window.state.scale」的全局做法',
    file: F.sr,
    from: '    resetContextState();',
    to: '    window.state.scale = rs;\n    resetContextState();',
  },
  {
    label: '黑板橡皮提示框漏乘缩放（提示框变成内容单位大小）',
    expect: '黑板橡皮提示 = 内容单位 × 当前缩放',
    file: F.de,
    from: '* this._fetch_safe_scale();\n            this._eraser_hint.style.width',
    to: '* 1;\n            this._eraser_hint.style.width',
  },
];

let pass = 0, fail = 0;

for (const m of M) {
  const orig = fs.readFileSync(m.file, 'utf8');
  const hits = orig.split(m.from).length - 1;
  if (hits < 1) { fail++; console.log('FAIL  [' + m.label + '] 锚点出现 0 次'); continue; }
  if (!m.replaceAll && hits !== 1) {
    fail++; console.log('FAIL  [' + m.label + '] 锚点出现 ' + hits + ' 次（需恰好 1 次）'); continue;
  }
  const mutated = m.replaceAll ? orig.split(m.from).join(m.to) : orig.replace(m.from, m.to);
  if (mutated === orig) { fail++; console.log('FAIL  [' + m.label + '] 空操作'); continue; }
  fs.writeFileSync(path.join(tmpDir, m.file), mutated, 'utf8');

  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }

  const crashed = /SyntaxError/.test(out) && !/^FAIL/m.test(out);
  const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) { pass++; console.log('PASS  ' + m.label); }
  else if (crashed) { fail++; console.log('FAIL  [' + m.label + '] harness 崩溃，不算守卫生效'); }
  else {
    fail++;
    console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）');
    console.log(out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 3).map((l) => '        ' + l).join('\n'));
  }
  fs.writeFileSync(path.join(tmpDir, m.file), orig, 'utf8');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;