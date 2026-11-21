// 逐个改坏小黑板笔迹移位的修复，断言 blackboard-stroke-shift.mjs 变红。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/blackboard-stroke-shift.mjs';
const FILES = [
  'src/modules/blackboard/blackboard.js',
  'src/modules/blackboard/drawing-engine.js',
  'src/modules/canvas/overlay-manager.js',
];
const ORIG = Object.fromEntries(FILES.map(f => [f, fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')]));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bss-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, HARNESS));
for (const f of FILES) {
  const dst = path.join(tmpDir, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(f, dst);
}

const M = [
  {
    label: 'snap 不再取消排队的 transform rAF',
    expect: 'snap 调用了 cancelAnimationFrame',
    from: '        if (this._bb_transform_raf_id !== null) {\n            cancelAnimationFrame(this._bb_transform_raf_id);\n            this._bb_transform_raf_id = null;\n        }\n        this._pending_bb_transform = null;\n        w.classList.remove(\'smooth-transform\');',
    to: '        w.classList.remove(\'smooth-transform\');',
  },
  {
    label: 'snap 清空 pending 的语句被删',
    expect: 'snap 清空 _pending_bb_transform',
    from: '        this._pending_bb_transform = null;\n        w.classList.remove(\'smooth-transform\');',
    to: '        w.classList.remove(\'smooth-transform\');',
  },
  {
    label: 'snap 不再把 DOM 落到 bb_state 终态',
    expect: 'snap 把 DOM 变换落到 bb_state 终态',
    from: "        w.style.transform = 'translate3d(' + s.canvas_x + 'px, ' + s.canvas_y + 'px, 0) scale(' + s.scale + ')';\n        s.last_transform = { x: s.canvas_x, y: s.canvas_y, scale: s.scale };",
    to: '        /* mutated: no fast-forward */',
  },
  {
    label: '死变量 _bb_last_transform 回归',
    expect: '_bb_last_transform 已彻底移除',
    from: '        this._bb_transform_raf_id = null;\n        // 拖拽脏检查统一用',
    to: '        this._bb_transform_raf_id = null;\n        this._bb_last_transform = { x: 0, y: 0, scale: 1 };\n        // 拖拽脏检查统一用',
  },
  {
    label: '拖拽脏检查改回死变量',
    expect: '拖拽脏检查改用 s.last_transform',
    from: '                if (s.last_transform.x !== s.canvas_x ||',
    to: '                if (this._bb_last_transform.x !== s.canvas_x ||',
  },
  {
    label: 'overlay 的自身 rect 缓存不再失效',
    expect: 'invalidate_transform 清掉 _selfRect',
    file: 'src/modules/canvas/overlay-manager.js',
    from: '        this._selfRect = null;\n    }',
    to: '    }',
  },
  {
    label: '橡皮提示缓存改回屏幕单位（缩放态提示圈变 scale 倍）',
    expect: '缓存写的是内容单位',
    file: 'src/modules/blackboard/drawing-engine.js',
    from: '        this.cached_draw_line_width = size / this._fetch_safe_scale();',
    to: '        this.cached_draw_line_width = size;',
  },
  {
    label: '页数收缩又调不存在的 remove_page',
    expect: '源码不再调用 remove_page',
    from: 'this.page_manager.delete_page(this.page_manager.get_page_count() - 1)',
    to: 'this.page_manager.remove_page(this.page_manager.get_page_count() - 1)',
  },
  {
    label: '文档快照不再带 undo 栈',
    expect: '快照包含 undos',
    from: '            undos: this.page_manager.pages_list.map(p => p.undo_list || []),\n',
    to: '',
  },
  {
    label: '快照门控改回 is_open（关闭路径同步失效）',
    expect: '快照门控用 __HISTORY_ISOLATED',
    from: 'if (window.__HISTORY_ISOLATED) {',
    to: 'if (this.is_open) {',
  },
  {
    label: '快照前不再同步当前页历史',
    expect: '快照前同步了当前页 undo',
    from: '        if (window.__HISTORY_ISOLATED) {\n            const cur = this.page_manager.get_current_page();\n            if (cur) {\n                cur.undo_list = [...history_state.undo_list];\n                cur.redo_list = [...history_state.redo_list];\n            }\n        }\n',
    to: '',
  },
  {
    label: '恢复时不再写回 undo 栈',
    expect: 'undo 恢复自快照',
    from: '                pd.undo_list = snap.undos?.[i] ? [...snap.undos[i]] : [];\n',
    to: '',
  },
  {
    label: '清空板时不再清 undo 栈',
    expect: '清空 undo',
    from: '            p.undo_list = [];\n',
    to: '',
  },
  {
    label: 'onPinchStarted 改回非 async',
    expect: 'onPinchStarted 是 async',
    from: '        pinch.onPinchStarted = async (ev) => {',
    to: '        pinch.onPinchStarted = (ev) => {',
  },
  {
    label: '捏合起手提交不再 await',
    expect: 'await 提交语句存在',
    from: '                        await this.drawing_engine._submit_stroke();',
    to: '                        this.drawing_engine._submit_stroke();',
  },
  {
    label: '清空 batch_draw 又回到 await 之前',
    expect: '清空 batch_draw 在 await 之后',
    from: '                        await this.drawing_engine._submit_stroke();\n                    } catch (err) {\n                        console.error(\'[blackboard] 捏合起手提交笔画失败:\', err);\n                    }\n                }\n                if (this.drawing_engine.batch_draw) {\n                    this.drawing_engine.batch_draw.batch_draw_delete_all();\n                }',
    to: '                    if (this.drawing_engine.batch_draw) {\n                        this.drawing_engine.batch_draw.batch_draw_delete_all();\n                    }\n                    await this.drawing_engine._submit_stroke();',
  },
];

let pass = 0, fail = 0;
for (const m of M) {
  const f = m.file || FILES[0];
  const orig = ORIG[f];
  const hits = orig.split(m.from).length - 1;
  if (hits !== 1) {
    fail++;
    console.log('FAIL  [' + m.label + '] 锚点在 ' + f + ' 出现 ' + hits + ' 次（必须恰好 1 次）');
    continue;
  }
  const mutated = orig.replace(m.from, m.to);
  if (mutated === orig) { fail++; console.log('FAIL  [' + m.label + '] 空操作变异'); continue; }
  const dst = path.join(tmpDir, f);
  fs.writeFileSync(dst, mutated, 'utf8');

  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }

  const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) { pass++; console.log('PASS  ' + m.label); }
  else {
    fail++;
    console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）');
    console.log(out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 3).map((l) => '        ' + l).join('\n'));
  }
  fs.writeFileSync(dst, orig, 'utf8');   // 还原
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
