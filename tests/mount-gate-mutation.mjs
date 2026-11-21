// 逐个改坏挂载门控的不变式，断言 mount-gate.mjs 变红。
// 重点是上一版真实存在的两个漏洞：
//   ① 泵自己的预挂载循环不接门控 → 滑动路径上门控完全落空（静默失效）
//   ② 续期散落在 5 个输入源 / 由冲量路径续期 → 判据语义错位
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/mount-gate.mjs';
const SRC = 'src/modules/pdf/document_reader.js';
const ORIG = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgate-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, 'tests', 'mount-gate.mjs'));
fs.mkdirSync(path.join(tmpDir, 'src', 'modules', 'pdf'), { recursive: true });
const dst = path.join(tmpDir, SRC);

const M = [
  {
    label: '删掉泵预挂载循环的门控（上一版的真实漏洞：滑动期完全落空）',
    expect: '泵的 DOM 预挂载接入门控',
    from: 'if (!this._mount_allowed_offscreen(i)) break;\n                this._ensure_page_element(i);',
    to: 'this._ensure_page_element(i);',
  },
  {
    label: '门控放在挂载之后（先挂再判，等于没判）',
    expect: '门控出现在挂载之前',
    from: 'if (!this._mount_allowed_offscreen(i)) break;\n                this._ensure_page_element(i);',
    to: 'this._ensure_page_element(i);\n                if (!this._mount_allowed_offscreen(i)) break;',
  },
  {
    label: '门控改成 continue（第一个候选被挡就退而挂更远的页）',
    expect: '门控用的是 break',
    from: 'if (!this._mount_allowed_offscreen(i)) break;',
    to: 'if (!this._mount_allowed_offscreen(i)) continue;',
  },
  {
    label: '删掉 _prerender_page 的门控',
    expect: '_prerender_page 接入门控',
    from: 'if (!this._mount_allowed_offscreen(page_index)) return;',
    to: '',
  },
  {
    label: '删掉 _dr_mark_render_gesture 里的续期（窗口永不推进=永久挡）',
    expect: '_dr_mark_render_gesture 内续期挂载窗口',
    from: 'this._dr_mount_block_until = performance.now() + MOUNT_IDLE_AFTER_MS;',
    to: '',
  },
  {
    label: '静默期从 100ms 变成 2000ms（用户要的 100ms 失效）',
    expect: 'mark 后窗口 = now + 100',
    from: 'const MOUNT_IDLE_AFTER_MS = 100;',
    to: 'const MOUNT_IDLE_AFTER_MS = 2000;',
  },
  {
    label: '到期判据改成严格大于（边界那一毫秒被挡住）',
    expect: '恰好到期即放行',
    from: 'if (performance.now() >= (this._dr_mount_block_until || 0)) return true;',
    to: 'if (performance.now() > (this._dr_mount_block_until || 0)) return true;',
  },
  {
    label: '去掉末尾豁免（滑到最后必然白屏）',
    expect: '移动期：末页豁免',
    from: 'return (total - 1 - page_index) <= MOUNT_TAIL_EXEMPT_PAGES;',
    to: 'return false;',
  },
  {
    label: '把翻页路径也接上门控（挡掉翻页语义专有的直调挂载）',
    expect: '翻页路径不得接挂载门控',
    from: 'if (this._dom_virtualize() && !pd.page_element && this._zoom_wrapper &&\n                        Math.abs(idx - target_index) <= this._wrapper_keep_distance) {',
    to: 'if (!this._mount_allowed_offscreen(idx)) continue;\n                    if (this._dom_virtualize() && !pd.page_element && this._zoom_wrapper &&\n                        Math.abs(idx - target_index) <= this._wrapper_keep_distance) {',
  },
  {
    // 只复活方法定义、不改调用链。连带引入未定义方法调用的话，harness 会崩、
    // 零 FAIL 行直接退出 —— 判成「没抓到」是误判：崩了不等于守卫生效。
    label: '旧的 _mark_motion 定义没清干净（分散打戳的机制还在）',
    expect: '全项目不再有 _mark_motion',
    from: '    _mount_allowed_offscreen(page_index) {',
    to: '    _mark_motion() { this._dr_last_motion_t = performance.now(); }\n\n    _mount_allowed_offscreen(page_index) {',
    label: '虚拟化阈值从 100 改成 0（所有文档都虚拟化）',
    expect: '虚拟化阈值 100 页',
    from: 'const DOM_VIRTUALIZE_MIN_PAGES = 100;',
    to: 'const DOM_VIRTUALIZE_MIN_PAGES = 0;',
  },
  {
    label: '包裹窗口从 50 退回 8',
    expect: '包裹窗口 50',
    from: 'this._wrapper_keep_distance = 50;',
    to: 'this._wrapper_keep_distance = 8;',
  },
  {
    label: '三档 wrapper_keep_distance 恢复分档（3/6/8）',
    expect: '三档 wrapper_keep_distance 统一 50',
    from: 'wrapper_keep_distance: 50,    // 同 low：包裹常驻不分档\n        image_keep_distance: 5,',
    to: 'wrapper_keep_distance: 8,    // 同 low：包裹常驻不分档\n        image_keep_distance: 5,',
  },
];

let pass = 0, fail = 0;

for (const m of M) {
  const hits = ORIG.split(m.from).length - 1;
  if (hits !== 1) {
    fail++;
    console.log('FAIL  [' + m.label + '] 锚点出现 ' + hits + ' 次（必须恰好 1 次）');
    continue;
  }
  const mutated = ORIG.replace(m.from, m.to);
  if (mutated === ORIG) { fail++; console.log('FAIL  [' + m.label + '] 空操作变异'); continue; }
  fs.writeFileSync(dst, mutated, 'utf8');

  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000, env: { ...process.env, READER_SRC: SRC } }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }

  const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) { pass++; console.log('PASS  ' + m.label + '   → ' + m.expect); }
  else {
    fail++;
    console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）');
    console.log(out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 3).map((l) => '        ' + l).join('\n'));
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;