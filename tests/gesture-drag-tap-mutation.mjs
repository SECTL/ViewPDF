// 断言 gesture-drag-tap.mjs 的每条守卫都能被对应变异触发。
// 临时目录复制 harness + gesture 源码，逐项变异后运行 harness（不改变仓库源码）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/gesture-drag-tap.mjs';
const GESTURE = 'src/modules/gesture';
const FILES = ['types.js', 'tolerance.js', 'drag-tap-converter.js', 'input-source.js', 'drag-tap-source.js'];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-dragtap-mut-'));
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
    label: '拖拽阈值从 >= 改成 >（恰等于容差不再触发 drag）',
    expect: 'dist===tolerance → drag started',
    file: 'drag-tap-converter.js',
    from: `if (dist >= this._tolerance) {`,
    to: `if (dist > this._tolerance) {`,
  },
  {
    label: '欧氏距离被改成曼哈顿距离（对角线阈值错位）',
    expect: '对角线用欧氏距离',
    file: 'drag-tap-converter.js',
    from: `const dist = Math.sqrt(dxo * dxo + dyo * dyo);`,
    to: `const dist = Math.abs(dxo) + Math.abs(dyo);`,
  },
  {
    label: 'move 的 delta 相对上一个点被改成相对起点',
    expect: 'delta 偏移 dxo,dyo,ddx,ddy',
    file: 'drag-tap-converter.js',
    from: `const ddx = x - this._lx;\n        const ddy = y - this._ly;\n        this._lx = x;\n        this._ly = y;\n\n        if (!this._dragging) {\n            const dxo = x - this._ox;`,
    to: `const ddx = x - this._ox;\n        const ddy = y - this._oy;\n        this._lx = x;\n        this._ly = y;\n\n        if (!this._dragging) {\n            const dxo = x - this._ox;`,
  },
  {
    label: 'up 的 tap/drag 路由反转',
    expect: 'dist<tolerance → tap',
    file: 'drag-tap-converter.js',
    from: `if (!this._dragging) {\n            if (this.onTap) {\n                this.onTap(this._ox, this._oy, x, y);\n            }\n        } else {`,
    to: `if (this._dragging) {\n            if (this.onTap) {\n                this.onTap(this._ox, this._oy, x, y);\n            }\n        } else {`,
  },
  {
    label: 'DragTapSource 不再按设备类型选容差（touch 误用 mouse）',
    expect: 'touch 12px 移动仍是 tap',
    file: 'drag-tap-source.js',
    from: `const tolerance = getTolerance(this._toleranceSet, ev.type);`,
    to: `const tolerance = getTolerance(this._toleranceSet, DeviceType.Mouse);`,
  },
  {
    label: '指针右键 button=2 归一化为 Middle',
    expect: '_getPointerButton button=2 → Right',
    file: 'input-source.js',
    from: `if (event.button === 2) return DeviceButton.Right;`,
    to: `if (event.button === 1) return DeviceButton.Right;`,
  },
];

let pass = 0, fail = 0, skip = 0;
try {
  for (const m of M) {
    const orig = ORIG[m.file];
    const hits = orig.split(m.from).length - 1;
    if (hits !== 1) { skip++; console.log('SKIP  [' + m.label + '] 锚点出现 ' + hits + ' 次'); continue; }
    const mutated = orig.replace(m.from, m.to);
    if (mutated === ORIG[m.file]) { skip++; console.log('SKIP  [' + m.label + '] 空操作'); continue; }
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
