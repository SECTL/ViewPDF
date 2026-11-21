// 断言 reader-momentum.mjs 的惯性期性能守卫都能被对应变异触发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/reader-momentum.mjs';
const SRC = 'src/modules/pdf/document_reader.js';
const ORIG = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const dst = path.join(tmpDir, SRC);
fs.mkdirSync(path.dirname(dst), { recursive: true });

const M = [
  {
    label: '惯性每帧重算边界（DOM 读不再为 0）',
    expect: '整段惯性滑行期间不重算边界',
    from: '        this._dr_update_canvas_position();\n\n        // 边界碰撞处理',
    to: '        this._dr_update_canvas_position();\n        this._dr_update_move_bound();\n\n        // 边界碰撞处理',
  },
  {
    label: '惯性开始不再停预渲染泵',
    expect: '惯性开始即停止预渲染泵',
    from: '        this._dr_stop_prerender_pump();\n        this._dr_momentum_last_ts = null;',
    to: '        this._dr_momentum_last_ts = null;',
  },
  {
    label: '可见性刷新去掉限频（每帧扫描）',
    expect: '可见性刷新被限频',
    from: '            if (now - this._dr_momentum_vis_t >= 33) {',
    to: '            if (true) {',
  },
  {
    label: '惯性期不再刷新可见性（滑入页空白）',
    expect: '惯性期会刷新可见性',
    from: '                this._dr_momentum_vis_t = now;\n                this._check_page_visibility();',
    to: '                this._dr_momentum_vis_t = now;',
  },
];

let pass = 0, fail = 0;
for (const m of M) {
  const hits = ORIG.split(m.from).length - 1;
  if (hits !== 1) { fail++; console.log('FAIL  [' + m.label + '] 锚点出现 ' + hits + ' 次'); continue; }
  const mutated = ORIG.replace(m.from, m.to);
  if (mutated === ORIG) { fail++; console.log('FAIL  [' + m.label + '] 空操作'); continue; }
  fs.writeFileSync(dst, mutated, 'utf8');
  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const caught = out.split('\n').some(l => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) { pass++; console.log('PASS  ' + m.label); }
  else { fail++; console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）'); }
  fs.writeFileSync(dst, ORIG, 'utf8');
}
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
