// 断言 gesture-damper.mjs 的每条守卫都能被对应变异触发。
// 临时目录复制 harness + 真实源码，逐项变异后运行 harness（不改变仓库源码）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/gesture-damper.mjs';
const GESTURE = 'src/modules/gesture';
const SRC = 'zoom-wall-damper.js';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-damp-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, GESTURE), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
fs.copyFileSync(path.join(GESTURE, SRC), path.join(tmpDir, GESTURE, SRC));
const ORIG = fs.readFileSync(path.join(GESTURE, SRC), 'utf8').replace(/\r\n/g, '\n');

const M = [
  {
    label: 'reset 不再把 value 钳到 [min,max]',
    expect: 'reset 高于 max 钳到 max',
    from: `this._value = Math.max(min, Math.min(max, value));`,
    to: `this._value = value;`,
  },
  {
    label: '去掉 _acc 的 overCap/underCap 钳制（深度过冲死区回归）',
    expect: '_acc 被 max*(1+escape) 钳制',
    from: `if (this._acc > overCap) {\n            this._acc = overCap;\n        } else if (this._acc < underCap) {\n            this._acc = underCap;\n        }`,
    to: `/* 累计窗口钳制被移除 */ ;`,
  },
  {
    label: '上墙钉死逻辑被去掉（边界呼吸回归）',
    // 噪声 1.01 会被最终 clamp 兜住；第一个真正脱离的是紧随的 0.99
    expect: 'max 墙 + 噪声 0.99 不脱离',
    from: `if (next >= max * (1 - this.escape)) next = max;`,
    to: `/* 上墙钉死被移除 */ ;`,
  },
  {
    // 注：自由区间 _acc=_value 那行经暴力验证是数学冗余（见报告），删掉不可观测，
    // 故这里放大上墙脱离阈值——会让「累计足够后脱离」的行程断言失败。
    label: '上墙脱离余量被放大（脱离死区变大）',
    expect: '持续反向累计足够后脱离上墙',
    from: `max * (1 - this.escape)`,
    to: `max * (1 - this.escape * 10)`,
  },
  {
    label: '非法 ratio 守卫被去掉（NaN 污染状态）',
    expect: '非法 ratio NaN 返回值不变',
    from: `if (!Number.isFinite(ratio) || ratio <= 0) return this._value;`,
    to: `/* 非法 ratio 守卫被移除 */ ;`,
  },
  {
    label: '最终显示值不再钳到 [min,max]（update 可能越界）',
    expect: '2000 帧随机增量后 _value 恒在',
    from: `this._value = Math.max(min, Math.min(max, next));`,
    to: `this._value = next;`,
  },
];

let pass = 0, fail = 0, skip = 0;
try {
  for (const m of M) {
    const hits = ORIG.split(m.from).length - 1;
    if (hits !== 1) { skip++; console.log('SKIP  [' + m.label + '] 锚点出现 ' + hits + ' 次'); continue; }
    const mutated = ORIG.replace(m.from, m.to);
    if (mutated === ORIG) { skip++; console.log('SKIP  [' + m.label + '] 空操作'); continue; }
    const dst = path.join(tmpDir, GESTURE, SRC);
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
      fs.writeFileSync(dst, ORIG, 'utf8');
    }
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.log('\n==== ' + pass + ' caught, ' + fail + ' missed, ' + skip + ' skip ====');
if (fail || skip) process.exitCode = 1;
