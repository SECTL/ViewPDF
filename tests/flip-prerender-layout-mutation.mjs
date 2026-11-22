// 断言 flip-prerender-layout.mjs 的守卫都能被对应变异触发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/flip-prerender-layout.mjs';
const SRC = 'src/modules/pdf/document_reader.js';
const ORIG = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const dst = path.join(tmpDir, SRC);
fs.mkdirSync(path.dirname(dst), { recursive: true });

const M = [
    {
        label: '翻页邻页预渲染退回 requestIdleCallback',
        expect: '只调度一次 rAF',
        from: '            requestAnimationFrame(dispatch);',
        to: '            window.requestIdleCallback(dispatch, { timeout: 1000 });',
    },
    {
        label: '翻页邻页不再跳过滚动用的移动门控',
        expect: '翻页邻页跳过滚动用的移动门控',
        from: 'Promise.resolve(this._prerender_page(idx, true)).catch(() => {});',
        to: 'Promise.resolve(this._prerender_page(idx)).catch(() => {});',
    },
    {
        label: '幂等页盒写入又无条件置脏',
        expect: '同尺寸写入不置脏',
        from: `        if (size_changed) {
            el.style.width = safe_w + 'px';
            el.style.height = safe_h + 'px';
            // 页面尺寸变更影响所有后续页面的 offsetTop，标记缓存脏
            this._invalidate_page_positions();
        }`,
        to: `        el.style.width = safe_w + 'px';
        el.style.height = safe_h + 'px';
        this._invalidate_page_positions();`,
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
