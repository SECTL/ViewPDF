// 逐个改坏 reader-offpage-pan.mjs 所依赖的不变式，断言套件会变红。
//
// 判定标准是「报告里出现预期标签的 FAIL 行」，不是「退出码非 0」——
// 变异一旦让模块 import 崩掉，harness 会零 FAIL 行直接退出，那不叫守卫生效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SRC_PATH = 'src/modules/pdf/document_reader.js';
const HARNESS = 'tests/reader-offpage-pan.mjs';
const ORIGINAL = fs.readFileSync(SRC_PATH, 'utf8');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offpage-mut-'));
const tmpSrc = path.join(tmpDir, 'document_reader.js');

// label 必须是在 harness 输出里能逐字看到的断言名，否则「抓到了」是自欺欺人
const MUTATIONS = [
  {
    label: '删掉页面外的平移分支（退回旧行为）',
    expect: '[comment] 页面外起手进入拖拽',
    from: `            if (!target) {
                this._dr_begin_pan(ev);
                return;
            }`,
    to: '',
  },
  {
    label: '把 !target 反成 target',
    expect: '默认模式下页面外起手进入拖拽',
    from: 'if (!target) {\n                this._dr_begin_pan(ev);',
    to: 'if (target) {\n                this._dr_begin_pan(ev);',
  },
  {
    // 贴近「只修一半」的真实写法：只在 move 模式下让页面外能拖
    label: '只在 move 模式下让页面外能拖（默认的 comment 模式依旧滑不动）',
    expect: '默认模式下页面外起手进入拖拽',
    from: 'if (!target) {\n                this._dr_begin_pan(ev);',
    to: "if (!target && this.draw_mode === 'move') {\n                this._dr_begin_pan(ev);",
  },
  {
    label: '页面外误起笔',
    expect: '[comment] 页面外起手不起笔',
    from: 'if (!target) {\n                this._dr_begin_pan(ev);',
    to: 'if (!target) {\n                this.is_drawing = true;\n                this._dr_begin_pan(ev);',
  },
  {
    label: '退回到用 target 本身（页面外不再算未命中）',
    expect: '[comment] 页面外起手进入拖拽',
    from: "const target = ev.originEvent?.target?.closest?.('.doc-reader-page');",
    to: "const target = ev.originEvent?.target?.closest?.('.doc-reader-page') || ev.originEvent?.target;",
  },
  {
    label: '锚点写成按下点本身（起手会跳）',
    expect: '锚点 X = 按下点 − 当前位移',
    scope: 'pan',
    from: 'this.dr_start_drag_x = ev.position.x - this.dr_canvas_x;',
    to: 'this.dr_start_drag_x = ev.position.x;',
  },
  {
    label: '锚点 Y 写成按下点本身',
    expect: '锚点 Y = 按下点 − 当前位移',
    scope: 'pan',
    from: 'this.dr_start_drag_y = ev.position.y - this.dr_canvas_y;',
    to: 'this.dr_start_drag_y = ev.position.y;',
  },
  {
    label: '不起手（漏了 dr_is_dragging）',
    expect: '[comment] 页面外起手进入拖拽',
    scope: 'pan',
    from: 'this.dr_is_dragging = true;\n        this._dr_multi_touch_active = false;',
    to: 'this._dr_multi_touch_active = false;',
  },
  {
    label: '速度没归零（松手会带着上一次的速度飞出去）',
    expect: '起手把 vx 归零',
    scope: 'pan',
    from: 'this._dr_gesture_vx = 0;',
    to: '',
  },
  {
    label: 'vy 没归零',
    expect: '起手把 vy 归零',
    scope: 'pan',
    from: 'this._dr_gesture_vy = 0;',
    to: '',
  },
  {
    label: '没清上一帧位移',
    expect: '起手清空上一帧位移',
    scope: 'pan',
    from: 'this._dr_last_canvas_y = this.dr_canvas_y;',
    to: '',
  },
  {
    label: '没记起始时刻（速度估计从 0 起算）',
    expect: '起手记下当前时刻',
    scope: 'pan',
    from: 'this._dr_last_move_time = performance.now();',
    to: '',
  },
  {
    label: '没记手指 id',
    expect: '起手记住手指 id',
    scope: 'pan',
    from: 'this._dragFingerId = ev.id;',
    to: 'this._dragFingerId = null;',
  },
  {
    label: '惯性被锁住（松手不滑行）',
    expect: '起手放行单指惯性',
    scope: 'pan',
    from: 'this._dr_multi_touch_active = false;',
    to: 'this._dr_multi_touch_active = true;',
  },
  {
    label: '缩放守卫移除',
    expect: '缩放中：页面外不起拖',
    scope: 'down',
    from: 'if (this.dr_is_scaling) return;',
    to: '',
  },
  {
    label: '多指守卫移除',
    expect: '多指：页面外不起拖',
    scope: 'down',
    from: 'if (input.activeCount > 1) return;',
    to: '',
  },
  {
    label: '批注分支取错页（用 pages_list[0]）',
    expect: '批注分支重新取的 page_data 用 active_page_index',
    from: 'const page_data = this.page_manager.pages_list[this.active_page_index];\n                // tile 就绪后再绑定',
    to: 'const page_data = this.page_manager.pages_list[0];\n                // tile 就绪后再绑定',
  },
  {
    label: 'page_data 的可选链被摘掉（页面数据缺失时抛）',
    expect: '页面数据缺失时不抛',
    from: 'page_data?.tile_renderer || null;',
    to: 'page_data.tile_renderer || null;',
  },
  {
    label: '滚轮从滚动容器挪到缩放包装器（页面外不再响应滚轮）',
    expect: '滚轮监听绑在滚动容器（页面外同样命中）',
    from: "this._scroll_container.addEventListener('wheel', this._bound_dr_handle_wheel, { passive: false });",
    to: "this._zoom_wrapper.addEventListener('wheel', this._bound_dr_handle_wheel, { passive: false });",
  },
  {
    label: '滚轮处理器开始判断事件源是否在页面内',
    expect: '滚轮处理器不判断事件源是否在页面内',
    from: '    _dr_handle_wheel(e) {\n        if (!this.is_open) return;',
    to: "    _dr_handle_wheel(e) {\n        if (!this.is_open) return;\n        if (!e.target?.closest?.('.doc-reader-page')) return;",
  },
];

// 这些赋值在文件里**多处**出现（pinch 结束后的恢复拖拽、滚轮路径都有同样的
// `dr_start_drag_x = ...` / `_dr_gesture_vy = 0`）。不限定作用域的话 `replace`
// 只换掉第一处，测的根本不是 _dr_begin_pan —— 而断言照样可能变绿。
// AGENTS.md 里的原话：变异测的不是你以为的地方，比没有守卫更危险。
function scopeRange(src, scope) {
  if (scope === 'pan') {
    const a = src.indexOf('_dr_begin_pan(ev) {');
    return a < 0 ? null : [a, src.indexOf('\n    }', a)];
  }
  if (scope === 'down') {
    const a = src.indexOf("input.on('inputDown',");
    return a < 0 ? null : [a, src.indexOf('\n        });', a)];
  }
  return [0, src.length];
}

let pass = 0, fail = 0;
fs.writeFileSync(tmpSrc, ORIGINAL, 'utf8');

for (const [i, m] of MUTATIONS.entries()) {
  const range = scopeRange(ORIGINAL, m.scope);
  if (!range || range[1] < 0) {
    fail++;
    console.log('FAIL  [' + m.label + '] 找不到作用域 ' + m.scope);
    continue;
  }
  const region = ORIGINAL.slice(range[0], range[1]);
  const hits = region.split(m.from).length - 1;
  if (hits !== 1) {
    fail++;
    console.log('FAIL  [' + m.label + '] 变异锚点在' + (m.scope || '整个文件') + '里出现 ' + hits + ' 次（必须恰好 1 次，否则测的是别的东西）');
    continue;
  }
  const mutated = ORIGINAL.slice(0, range[0]) + region.replace(m.from, m.to) + ORIGINAL.slice(range[1]);
  if (mutated === ORIGINAL) {
    fail++;
    console.log('FAIL  [' + m.label + '] 变异是空操作 —— 等于没改，却报「抓到了」');
    continue;
  }
  fs.writeFileSync(tmpSrc, mutated, 'utf8');

  let out = '', crashed = false;
  try {
    out = execFileSync(process.execPath, [HARNESS], {
      encoding: 'utf8', env: { ...process.env, READER_SRC: tmpSrc }, timeout: 60000,
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    crashed = /SyntaxError|ReferenceError: .* is not defined|Cannot read/.test(out) && !/^FAIL/m.test(out);
  }

  const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) {
    pass++;
    console.log('PASS  ' + m.label + '   → ' + m.expect);
  } else if (crashed) {
    fail++;
    console.log('FAIL  [' + m.label + '] harness 崩了（模块加载失败），没走到断言 —— 这不算守卫生效：\n' +
      out.split('\n').filter((l) => /Error/.test(l)).slice(0, 3).join('\n'));
  } else {
    fail++;
    console.log('FAIL  [' + m.label + '] 没抓到（预期标签：' + m.expect + '）\n' +
      out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 6).join('\n'));
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;