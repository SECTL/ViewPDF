// 断言 scroll-perf.mjs 的守卫都能被对应变异触发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/scroll-perf.mjs';
const SRC = 'src/modules/pdf/document_reader.js';
const ORIG = fs.readFileSync(SRC, 'utf8');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, path.dirname(SRC)), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
const dst = path.join(tmpDir, SRC);

const MUTATIONS = [
  {
    label: 'diag sentinel 去掉节流（每帧全量扫描回归）',
    expect: '1 秒内 30 次扫描只真正执行 1 次',
    from: '        if (now - (this._diag_sentinel_t || 0) < 1000) return;\n        this._diag_sentinel_t = now;',
    to: '        this._diag_sentinel_t = now;',
  },
  {
    label: '容器 rect 回退到每帧两次 gBCR',
    expect: '平移帧不再读容器 rect',
    from: `        if (this._cached_container_rect) {
            // 容器自身在面板里静止：top/bottom/left/right 只在几何变化时
            // （_on_reader_geometry_changed / resize 把缓存置 null）重读。
            // transform 平移只改变 wrapper 的屏幕位置，用「首次读取时的屏幕位置
            // + 相对该时刻的 translateY 差值」推导。不假设首次读取时 transform
            // 已同步（打开流程里 cache 会在 _dr_sync_transform 之前被清空），
            // 否则基准会错一整个 dr_canvas_y，页面被判到视口外 → 白屏。
            const base = this._cached_container_rect;
            base.wrapperTop = base.base_wrapper_top
                + ((this.dr_canvas_y || 0) - base.base_canvas_y);
            this._dr_transform_changed = false;
            return;
        }`,
    to: '',
  },
  {
    label: '滑行落点改回非冲量（二次续期渲染暂停回归）',
    expect: '惯性落点标志在收尾清除',
    from: '                this._dr_apply_scale(true);\n                this._dr_schedule_disable_smooth_transform();',
    to: '                this._dr_apply_scale();\n                this._dr_schedule_disable_smooth_transform();',
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
    fail++; console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）\n' + out.slice(-500));
  }
}
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
