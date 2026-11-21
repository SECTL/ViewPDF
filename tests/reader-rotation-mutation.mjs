// 断言 reader-rotation.mjs 的旋转守卫都能被对应变异触发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/reader-rotation.mjs';
const SRC = 'src/modules/pdf/document_reader.js';
// harness 还会读 worker 与 host，三个都得复制到临时目录
const EXTRA = ['src/modules/pdf/render-worker.js', 'src/modules/pdf/render-worker-host.js'];
const LOCALES = 'src/locales';
const ORIG = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const dst = path.join(tmpDir, SRC);
fs.mkdirSync(path.dirname(dst), { recursive: true });
for (const f of EXTRA) {
  const p = path.join(tmpDir, f);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.copyFileSync(f, p);
}
// harness 还校验 9 个语言包里的旋转提示文案
const locDst = path.join(tmpDir, LOCALES);
fs.mkdirSync(locDst, { recursive: true });
for (const f of fs.readdirSync(LOCALES)) fs.copyFileSync(path.join(LOCALES, f), path.join(locDst, f));

const M = [
  {
    label: '视图快照不再带 page_rotation（旋转不持久）',
    expect: 'tab view 捕获旋转',
    from: '            pageRotation: this._page_rotation,',
    to: '            pageRotation: 0,',
  },
  {
    label: '旋转不再清空每页 stroke_history',
    expect: '旋转清空每页 stroke_history',
    from: '            pd.stroke_history = [];\n',
    to: '',
  },
  {
    label: '旋转不再清位图缓存（旧朝向位图回贴）',
    expect: '旋转时清位图缓存',
    from: '        this._bitmap_cache_clear();\n        // 撤销/重做栈里持有的是已清空的 stroke 引用',
    to: '        // 撤销/重做栈里持有的是已清空的 stroke 引用',
  },
  {
    label: '旋转不再作废页位置缓存（页盒互相重叠）',
    expect: '旋转时作废页位置缓存',
    from: '        this._invalidate_page_positions();\n        this._cached_container_rect = null;',
    to: '        this._cached_container_rect = null;',
  },
  {
    label: '角度归一化丢掉非法值兜底',
    expect: '角度归一化',
    from: '        const n = ((Number(deg) | 0) % 360 + 360) % 360;',
    to: '        const n = Number(deg) | 0;',
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
