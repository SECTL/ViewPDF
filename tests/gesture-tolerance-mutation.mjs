// 断言 gesture-tolerance.mjs 的每条守卫都能被对应变异触发。
// 在临时目录里复制 harness + gesture 源码，改写一份源码后运行 harness，
// 不触碰仓库里的真实源码；每个变异跑完都在 finally 里还原临时副本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/gesture-tolerance.mjs';
const GESTURE = 'src/modules/gesture';
const FILES = ['types.js', 'tolerance.js'];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tol-mut-'));
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
    label: 'DRAG 容差 touch 被改成小于 stylus（单调性破坏）',
    expect: 'TOLERANCE.DRAG touch>stylus',
    file: 'tolerance.js',
    from: `DRAG:                         { mouse: 1,  touch: 16, stylus: 4  },`,
    to: `DRAG:                         { mouse: 1,  touch: 2,  stylus: 4  },`,
  },
  {
    label: 'PINCH_MIN_DISTANCE 从 20 被改小',
    expect: 'PINCH_MIN_DISTANCE===20',
    file: 'tolerance.js',
    from: `export const PINCH_MIN_DISTANCE = 20;`,
    to: `export const PINCH_MIN_DISTANCE = 19;`,
  },
  {
    label: 'PINCH_FRAME_RATIO_MIN 不再等于 1/3（互倒数破坏）',
    expect: 'PINCH_FRAME_RATIO_MIN===1/3',
    file: 'tolerance.js',
    from: `export const PINCH_FRAME_RATIO_MIN = 1 / 3;`,
    to: `export const PINCH_FRAME_RATIO_MIN = 1 / 4;`,
  },
  {
    label: 'getTolerance 的 Stylus 分支误返回 mouse',
    expect: 'getTolerance Stylus',
    file: 'tolerance.js',
    from: `if (deviceType === DeviceType.Stylus) return toleranceSet.stylus;`,
    to: `if (deviceType === DeviceType.Stylus) return toleranceSet.mouse;`,
  },
  {
    label: 'detectDeviceType 的 pen 被当成 touch',
    expect: 'detect pointerType pen',
    file: 'tolerance.js',
    from: `if (event.pointerType === 'pen') return DeviceType.Stylus;`,
    to: `if (event.pointerType === 'touch') return DeviceType.Stylus;`,
  },
  {
    label: 'isRealMouse 的 mouse 判据被反转',
    expect: 'isRealMouse pointerType mouse',
    file: 'tolerance.js',
    from: `return event.pointerType === 'mouse';`,
    to: `return event.pointerType === 'touch';`,
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
      const caught = !!hit || (code !== 0 && failLines.length === 0); // 崩溃也算被抓
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
