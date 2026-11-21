// 断言 flip-perf.mjs 的翻页性能守卫都能被对应变异触发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/flip-perf.mjs';
const SRC = 'src/modules/pdf/document_reader.js';
const ORIG = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const dst = path.join(tmpDir, SRC);
fs.mkdirSync(path.dirname(dst), { recursive: true });

const M = [
    {
        label: '翻页目标不再豁免运动期降密度（退回双重栅格化）',
        expect: '翻页目标 target_dpr 不降密度',
        from: '            if (page_index === this._dr_flip_target) return d;\n            if (page_data.pdf_render_css_width > 0 || is_prerender) return d;',
        to: '            if (page_data.pdf_render_css_width > 0 || is_prerender) return d;',
    },
    {
        label: '_scroll_to_page 的 finally 被去掉（标记残留）',
        expect: 'apply_scale 返回后标记已复位',
        from: '        this._dr_flip_target = page_index;\n        try {\n            this._dr_apply_scale(true);\n        } finally {\n            this._dr_flip_target = -1;\n        }',
        to: '        this._dr_flip_target = page_index;\n        this._dr_apply_scale(true);',
    },
    {
        label: '活动页提交直通被去掉（退回 48ms 挂起）',
        expect: '可见活动页的真实提交在 48ms 门内直通',
        from: '            if (!is_active_real && now_ms - (this._dr_last_full_commit_at || 0) < 48) {',
        to: '            if (now_ms - (this._dr_last_full_commit_at || 0) < 48) {',
    },
    {
        label: '活动页判据漏掉 page_index（可见页一律直通）',
        expect: '非活动可见页的真实提交仍被节流',
        from: '        const is_active_real = !is_prerender && !is_placeholder &&\n            page_data.is_visible && page_index === this.active_page_index;',
        to: '        const is_active_real = !is_prerender && !is_placeholder &&\n            page_data.is_visible;',
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
