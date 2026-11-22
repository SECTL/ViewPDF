// 变异测试：逐个改坏 pen_tessellator.js 的不变式，断言 pen-tessellator.mjs 变红。
// 影子目录里改，不碰真实源码、不碰 git；每条变异跑完都写回原文（finally 保证）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/pen-tessellator.mjs';
const SRC = 'src/modules/canvas/pen_tessellator.js';
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const ORIG = readNorm(SRC);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pen-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, 'tests', 'pen-tessellator.mjs'));
fs.mkdirSync(path.join(tmpDir, 'src', 'modules', 'canvas'), { recursive: true });
const dst = path.join(tmpDir, SRC);
fs.writeFileSync(dst, ORIG, 'utf8');

// expect 必须是 harness 里某条 FAIL 标签的子串 —— 只认「预期那条守卫真的响了」。
const M = [
  {
    label: '无效输入不再返回 null（直接吐空笔画对象）',
    expect: 'null 输入返回 null',
    from: '        if (!stroke || !stroke.points || stroke.points.length < 1) return null;',
    to: "        if (!stroke || !stroke.points || stroke.points.length < 1) return { segments: [], color: '#000' };",
  },
  {
    label: '默认线宽从 5 改成 10（未给 lineWidth 的笔画突然变粗）',
    expect: '零长笔迹默认线宽 5',
    from: '        const base_width = stroke.lineWidth || 5;',
    to: '        const base_width = stroke.lineWidth || 10;',
  },
  {
    label: '默认颜色回退被改（#3498db → #000000）',
    expect: '默认颜色回退 #3498db',
    from: "        const color = stroke.color || '#3498db';",
    to: "        const color = stroke.color || '#000000';",
  },
  {
    label: '_runsCache 换成普通 Map（笔画回收时缓存不释放）',
    expect: '_runsCache 是 WeakMap',
    from: '         * 共用同一批 Path2D。WeakMap 保证笔画被回收时缓存随之释放。\n         */\n        this._runsCache = new WeakMap();',
    to: '         * 共用同一批 Path2D。WeakMap 保证笔画被回收时缓存随之释放。\n         */\n        this._runsCache = new Map();',
  },
  {
    label: '缓存封顶从 200000 降到 2000（病态输入内存约束被改）',
    expect: '_MAX_CACHED_RUNS 封顶 200000',
    from: '        this._MAX_CACHED_RUNS = 200000;',
    to: '        this._MAX_CACHED_RUNS = 2000;',
  },
  {
    label: '缓存封顶比较符 > 改成 >=（提前一轮作废）',
    expect: '超上限后整体作废',
    from: '            if (this._cachedRunCount + runs.length > this._MAX_CACHED_RUNS) {',
    to: '            if (this._cachedRunCount + runs.length >= this._MAX_CACHED_RUNS) {',
  },
  {
    label: '缓存键丢掉 ratio（scaleRatio 变化仍返回旧几何）',
    expect: 'ratio 变化重建',
    from: '        if (cached && cached.ratio === scaleRatio) return cached.runs;',
    to: '        if (cached) return cached.runs;',
  },
  {
    label: 'reset_runs_cache 不归零计数（配额虚高，后半程永久冷路径）',
    expect: 'reset 后 _cachedRunCount 归零',
    from: '    reset_runs_cache() {\n        this._runsCache = new WeakMap();\n        this._cachedRunCount = 0;\n    }',
    to: '    reset_runs_cache() {\n        this._runsCache = new WeakMap();\n    }',
  },
  {
    label: '采样细分 SUBDIVS 从 8 改成 4（几何被悄悄改）',
    expect: '采样点数 = len*8+5 = 29',
    from: '        const SUBDIVS = 8;',
    to: '        const SUBDIVS = 4;',
  },
  {
    label: '切段阈值 WIDTH_EPSILON 从 0.5 改成 5（渐变被吞掉）',
    expect: '变宽笔迹切成 9 段',
    from: '        const WIDTH_EPSILON = 0.5;',
    to: '        const WIDTH_EPSILON = 5;',
  },
  {
    label: '起笔渐变段数从 4 改成 0（taper 完全失效）',
    expect: '默认起笔渐变恰好影响前 4 段',
    from: '        const taperSegments = 4;',
    to: '        const taperSegments = 0;',
  },
  {
    label: 'storedWidths 模式也叠加 taper（宽度被二次收窄）',
    expect: 'storedWidths 模式不受 taper 叠加',
    from: '                if (!storedWidths) {',
    to: '                if (true) {',
  },
  {
    label: 'storedWidths 长度判断写错（存储宽度被忽略，退回速度重算）',
    expect: 'storedWidths 模式宽度原样落地',
    from: '        if (storedWidths && storedWidths.length === raw.length - 1) {',
    to: '        if (storedWidths && storedWidths.length === raw.length) {',
  },
  {
    label: '渲染 lineCap 改成 butt（笔锋端点变方）',
    expect: 'lineCap = round',
    from: "        ctx.lineCap = 'round';",
    to: "        ctx.lineCap = 'butt';",
  },
  {
    label: '渲染只 stroke 第一个 run（渐变宽度全丢）',
    expect: '每个 run 发一次 stroke',
    from: '        for (let i = 0; i < runs.length; i++) {',
    to: '        for (let i = 0; i < 1; i++) {',
  },
  {
    label: '采样宽度不乘 scaleRatio（渲染缩放失效）',
    expect: 'scaleRatio=2 时第 0 点宽度翻倍',
    from: '            const curW = seg.line_width * scaleRatio;',
    to: '            const curW = seg.line_width;',
  },
];

let pass = 0, fail = 0, skip = 0, uncaught = 0;

for (const m of M) {
  const hits = ORIG.split(m.from).length - 1;
  if (hits !== 1) {
    skip++;
    console.log('[SKIP]  ' + m.label + '  → 锚点出现 ' + hits + ' 次（必须恰好 1 次）');
    continue;
  }
  const mutated = ORIG.replace(m.from, m.to);
  if (mutated === ORIG) {
    fail++;
    console.log('FAIL  [' + m.label + '] 变异是空操作');
    continue;
  }
  fs.writeFileSync(dst, mutated, 'utf8');
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
    code = typeof e.status === 'number' ? e.status : 1;
  }
  const lines = out.split(/\r?\n/);
  const caught = lines.some((l) => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) {
    pass++;
    console.log('PASS  ' + m.label + '   → ' + m.expect);
  } else if (code !== 0) {
    uncaught++;
    console.log('[UNCAUGHT]  ' + m.label + '  → harness 崩了但没有预期 FAIL 行\n' +
      lines.filter((l) => l.startsWith('FAIL')).slice(0, 3).map((l) => '        ' + l).join('\n'));
  } else {
    fail++;
    console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）');
  }
  fs.writeFileSync(dst, ORIG, 'utf8');   // 还原，避免上一条变异污染下一条
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' captured, ' + fail + ' fail, ' + skip + ' skip, ' + uncaught + ' uncaught ====');
if (fail || skip || uncaught) process.exitCode = 1;
