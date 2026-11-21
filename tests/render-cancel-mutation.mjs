// 断言 render-cancel.mjs 的守卫真能失败：删掉 noop catch 后必须变红。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/render-cancel.mjs';
const SRC = 'src/modules/pdf/render-worker-host.js';
const ORIG = fs.readFileSync(SRC, 'utf8');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, path.dirname(SRC)), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const dst = path.join(tmpDir, SRC);

const MUTATIONS = [
  {
    label: '删掉 promise 的 noop catch（取消未捕获）',
    expect: '没有未处理的 rejection',
    from: '        promise.catch(() => {});\n        return promise;',
    to: '        return promise;',
  },
];

let pass = 0, fail = 0;
for (const m of MUTATIONS) {
  const hits = ORIG.split(m.from).length - 1;
  if (hits !== 1) { fail++; console.log('FAIL  [' + m.label + '] 锚点出现 ' + hits + ' 次'); continue; }
  fs.writeFileSync(dst, ORIG.replace(m.from, m.to), 'utf8');
  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  if (out.split('\n').some(l => l.startsWith('FAIL') && l.includes(m.expect))) {
    pass++; console.log('PASS  ' + m.label);
  } else {
    fail++; console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）\n' + out.slice(-600));
  }
  fs.writeFileSync(dst, ORIG, 'utf8');
}
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
