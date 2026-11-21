// 断言 reader-confirm.mjs 的四个核心守卫都能被对应变异触发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/reader-confirm.mjs';
const SRC = 'src/modules/pdf/document_reader.js';
const ORIG = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const dst = path.join(tmpDir, SRC);
fs.mkdirSync(path.dirname(dst), { recursive: true });

const M = [
  {
    label: '结算后不清空 settle 句柄（重开时会结算已结束的弹窗）',
    expect: '确定后结算句柄已清空',
    from: '                this._reader_confirm_settle = null;\n',
    to: '',
  },
  {
    label: '重新打开不再结算在飞 promise（调用方永久 await）',
    expect: '连开两次：第一个按取消结算',
    from: '            if (this._reader_confirm_settle) {\n                this._reader_confirm_settle(false);\n            }\n',
    to: '',
  },
  {
    label: '结算后不摘除弹窗 DOM',
    expect: '确定后弹窗已从 DOM 移除',
    from: '                overlay.remove();\n',
    to: '',
  },
  {
    label: '结算后不摘除 keydown 监听',
    expect: '结算后 document 上无残留 keydown 监听',
    from: "                document.removeEventListener('keydown', on_key);\n",
    to: '',
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
