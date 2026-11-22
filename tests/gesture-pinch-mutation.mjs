// 断言 gesture-pinch.mjs 的每条守卫都能被对应变异触发。
// 临时目录复制 harness + gesture 源码，逐项变异后运行 harness（不改变仓库源码）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/gesture-pinch.mjs';
const GESTURE = 'src/modules/gesture';
const FILES = ['types.js', 'tolerance.js', 'pinch-zoom-v2.js'];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-pinch-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, GESTURE), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const ORIG = {};
for (const f of FILES) {
  fs.copyFileSync(path.join(GESTURE, f), path.join(tmpDir, GESTURE, f));
  ORIG[f] = fs.readFileSync(path.join(GESTURE, f), 'utf8').replace(/\r\n/g, '\n');
}

const M = [
  {
    label: '单帧增量比上限钳制被去掉',
    expect: '高于上限被钳到 PINCH_FRAME_RATIO_MAX',
    file: 'pinch-zoom-v2.js',
    from: `if (incrementalRatio > PINCH_FRAME_RATIO_MAX) incrementalRatio = PINCH_FRAME_RATIO_MAX;`,
    to: `if (false) incrementalRatio = PINCH_FRAME_RATIO_MAX;`,
  },
  {
    label: '单帧增量比下限钳制被去掉',
    expect: '低于下限被钳到 PINCH_FRAME_RATIO_MIN',
    file: 'pinch-zoom-v2.js',
    from: `else if (incrementalRatio < PINCH_FRAME_RATIO_MIN) incrementalRatio = PINCH_FRAME_RATIO_MIN;`,
    to: `else if (false) incrementalRatio = PINCH_FRAME_RATIO_MIN;`,
  },
  {
    label: '两指最小距离冻结被去掉（并拢时比值爆炸）',
    expect: '两指距离<MIN 时不发射',
    file: 'pinch-zoom-v2.js',
    from: `if (currentDist < PINCH_MIN_DISTANCE) return;`,
    to: `/* 最小距离冻结被移除 */ ;`,
  },
  {
    label: '微动死区跳过被去掉（触控噪声逐帧发射）',
    expect: '超容差但比值≈1 帧不发射',
    file: 'pinch-zoom-v2.js',
    from: `if (Math.abs(incrementalRatio - 1) < EMIT_DEAD_BAND_RATIO &&\n            emitMidDx * emitMidDx + emitMidDy * emitMidDy < EMIT_DEAD_BAND_MID_SQ) {\n            return;\n        }`,
    to: `/* 微动死区被移除 */ ;`,
  },
  {
    label: '待激活的 BOTH 语义被改成 OR（一指动即误触缩放）',
    expect: '仅一指移动不激活',
    file: 'pinch-zoom-v2.js',
    from: `if (f0Moved && f1Moved) {`,
    to: `if (f0Moved || f1Moved) {`,
  },
];

let pass = 0, fail = 0, skip = 0;
try {
  for (const m of M) {
    const orig = ORIG[m.file];
    const hits = orig.split(m.from).length - 1;
    if (hits !== 1) { skip++; console.log('SKIP  [' + m.label + '] 锚点出现 ' + hits + ' 次'); continue; }
    const mutated = orig.replace(m.from, m.to);
    if (mutated === orig) { skip++; console.log('SKIP  [' + m.label + '] 空操作'); continue; }
    const dst = path.join(tmpDir, GESTURE, m.file);
    try {
      fs.writeFileSync(dst, mutated, 'utf8');
      let out = '', code = 0;
      try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 }); }
      catch (e) { code = e.status ?? 1; out = (e.stdout || '') + (e.stderr || ''); }
      const lines = out.split('\n');
      const failLines = lines.filter((l) => l.startsWith('FAIL'));
      const hit = failLines.find((l) => l.includes(m.expect));
      const caught = !!hit || (code !== 0 && failLines.length === 0);
      if (caught) {
        pass++;
        console.log('PASS  ' + m.label + (hit ? '\n      -> ' + hit.trim().slice(0, 160) : '  [崩溃]'));
      }
      else {
        fail++;
        console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）');
        console.log('      ' + (failLines[0] || out.split('\n').slice(0, 3).join(' | ')).slice(0, 300));
      }
    } finally {
      fs.writeFileSync(dst, orig, 'utf8');
    }
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log('\n==== ' + pass + ' caught, ' + fail + ' missed, ' + skip + ' skip ====');
if (fail || skip) process.exitCode = 1;
