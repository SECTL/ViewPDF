// 断言 oobe-skip-check.mjs 的 9 语言包守卫都能被对应变异触发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/oobe-skip-check.mjs';
const LOCALES = 'src/locales';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osc-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const dstDir = path.join(tmpDir, LOCALES);
fs.mkdirSync(dstDir, { recursive: true });
for (const f of fs.readdirSync(LOCALES)) fs.copyFileSync(path.join(LOCALES, f), path.join(dstDir, f));

const M = [
  {
    label: '某个语言包缺 updateSkipCheck（界面显示裸 key）',
    expect: '带 oobe.updateSkipCheck',
    file: 'en-US.json',
    from: '    "updateSkipCheck": "Skip Check",\n',
    to: '',
  },
  {
    label: 'updateSkipCheck 被误写成 updateLater 的文案（语义合并）',
    expect: '跳过检查 ≠ 稍后再说',
    file: 'en-US.json',
    from: '"updateSkipCheck": "Skip Check"',
    to: '"updateSkipCheck": "Later"',
  },
  {
    label: '另一语言包的 key 被删（多语言覆盖不全）',
    expect: '带 oobe.updateSkipCheck',
    file: 'zh-CN.json',
    from: '    "updateSkipCheck": "跳过检查",\n',
    to: '',
  },
];

let pass = 0, fail = 0;
for (const m of M) {
  const orig = fs.readFileSync(path.join(LOCALES, m.file), 'utf8').replace(/\r\n/g, '\n');
  const dst = path.join(dstDir, m.file);
  const hits = orig.split(m.from).length - 1;
  if (hits !== 1) { fail++; console.log('FAIL  [' + m.label + '] 锚点出现 ' + hits + ' 次'); continue; }
  fs.writeFileSync(dst, orig.replace(m.from, m.to), 'utf8');
  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const caught = out.split('\n').some(l => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) { pass++; console.log('PASS  ' + m.label); }
  else { fail++; console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）'); }
  fs.writeFileSync(dst, orig, 'utf8');
}
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
