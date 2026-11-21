// 断言 display-canvas-pool.mjs 的守卫都能被对应变异触发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/display-canvas-pool.mjs';
const SRC = 'src/modules/pdf/document_reader.js';
const ORIG = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcp-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const dst = path.join(tmpDir, SRC);
fs.mkdirSync(path.dirname(dst), { recursive: true });

const M = [
    {
        label: '空画布也入池（零字节占满数量上限）',
        expect: '默认/空画布不入池',
        from: '        if (!(c.width > 0) || !(c.height > 0)) return;\n',
        to: '',
    },
    {
        label: '同尺寸取用不再复用',
        expect: '同尺寸取用复用同一块画布',
        from: '            if (c.width === w && c.height === h) {',
        to: '            if (false) {',
    },
    {
        label: '页面隐藏时不再归还画布',
        expect: '归还调用一次',
        from: '            this._release_display_canvas(canvas);\n            page_data.pdf_canvas = null;',
        to: '            page_data.pdf_canvas = null;',
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
