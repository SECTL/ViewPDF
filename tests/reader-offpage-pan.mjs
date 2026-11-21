// 「纸张以外的留白也能拖动平移」的行为测试。
//
// 为什么必须真跑而不能用正则：这整件事只存在于 inputDown 的控制流里 ——
// 旧代码那行 `if (!target) return;` 任何正则都"看不出"错，它就是一句话。
// 症状却只在运行时出现：页面外按下 → 既不切页也不拖 → 滑起来毫无反应。
// （本项目有先例：`const overlay` 被重新赋值、每次开对话框都抛 TypeError，
//  当时通过了全部正则守卫。）
//
// 做法：从真实源码里把 inputDown / inputMove 的 handler 与 _dr_begin_pan 的方法体
// 抠出来真执行。测的是真代码，不是复刻品。
//
// READER_SRC 可指向别处 —— 变异测试靠它把改坏的源码喂进来。
import fs from 'node:fs';

const SRC = fs.readFileSync(process.env.READER_SRC || 'src/modules/pdf/document_reader.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

// AGENTS.md：绝不能 await 一个可能永不 settle 的 promise —— 空事件循环下 Node
// 退出码 0，断言被静默跳过，测试"通过"。必须超时兜底。
const settle = (p, ms = 2000) => Promise.race([
  Promise.resolve(p),
  new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('promise 未 settle（' + ms + 'ms）')), ms); t.unref?.(); }),
]);

// ---- 可变注入 ----
// `new Function` 的形参是**创建时按值捕获**的。若直接传 mock 对象，第二轮换掉的
// mock 就打不进去了 —— 而症状是「所有断言一起失败」而非任何报错。
// 传一个转发到当前 mock 的 getter 代理。
let CURRENT_INPUT = { activeCount: 1 };
const inputProxy = { get activeCount() { return CURRENT_INPUT.activeCount; } };
const windowMock = { main_hide_pen_control_panel: () => {} };
const perfMock = { now: () => 1000 };

// ---- 从真实源码抠 handler ----
// handler 的闭合是缩进 8 的 `        });`；函数体内部的闭合缩进都 >= 12。
// 不用括号配对：注释里出现过反引号（`` `page_data` ``），配对会被带偏。
function extractHandler(name) {
  const anchor = SRC.indexOf(`input.on('${name}',`);
  if (anchor < 0) return null;
  const open = SRC.indexOf('async (ev) => {', anchor);
  if (open < 0) return null;
  // 从 `{` 开始取（不是从 `{` 之后）—— 漏掉它会让 `async (ev) => <换行> if (...)`
  // 被判成表达式体，`if` 立刻成非法 token，编译失败且看不出是抠取出了问题
  const bodyStart = open + 'async (ev) =>'.length;
  const close = SRC.indexOf('\n        }', bodyStart);
  if (close < 0) return null;
  const bodySrc = SRC.slice(bodyStart, close + '\n        }'.length);
  try {
    // 必须是**普通**函数表达式，不能用箭头函数：handler 原文写的是
    // `async (ev) => {...}`，而箭头函数的 this 来自定义处，`.call(mock)` 改不动 ——
    // 于是 `this.is_open` 是 undefined，第一行 `if (!this.is_open) return` 直接
    // 吞掉整个 handler，症状是「所有断言一起失败且不报任何错」。
    return new Function('input', 'window', 'performance',
      'return async function (ev) ' + bodySrc)(inputProxy, windowMock, perfMock);
  } catch (e) {
    console.log('FAIL  抠出 ' + name + ' 时编译失败: ' + e.message);
    return null;
  }
}

// ---- 从真实源码抠方法体（保留 this 语义） ----
// params 必传：抠出来的方法体若引用形参（如 _dr_begin_pan 用到 ev），
// new Function 不声明它就直接 ReferenceError —— 而那会让 handler 抛错，
// 症状看起来像「功能没实现」，与真实原因毫无关系。
// performance 一并注入：方法体里的 `performance.now()` 若走 node 全局，拿到的是
// 真时钟，断言就只能写成「是个大于 0 的数」这种测不出东西的形式。
function extractMethod(name, params = '') {
  const m = new RegExp('(?:^|\\n)\\s*' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(SRC);
  return m ? new Function(...(params ? [params, 'performance'] : ['performance']), m[1]) : null;
}

const inputDown = extractHandler('inputDown');
const inputMove = extractHandler('inputMove');
const drBeginPan = extractMethod('_dr_begin_pan', 'ev');
// .call 时把 mock 时钟传进去（与 handler 里注入的是同一个 perfMock）
const callBeginPan = (self, ev) => drBeginPan.call(self, ev, perfMock);

eq('抠出 inputDown handler', !!inputDown, true);
eq('抠出 inputMove handler', !!inputMove, true);
eq('抠出 _dr_begin_pan 方法体', !!drBeginPan, true);
if (!inputDown || !inputMove || !drBeginPan) process.exit(1);

// ---- mock ----
// pages_list 的形状照抄真实 PageData 的最小集：is_tiles_initialized + tile_renderer
const mkPages = () => [
  { page_element: {}, is_tiles_initialized: true, tile_renderer: { id: 'r0' } },
  { page_element: {}, is_tiles_initialized: true, tile_renderer: { id: 'r1' } },
];

function build({ draw_mode = 'comment', active_page_index = 0 } = {}) {
  const s = {
    is_open: true,
    is_drawing: false,
    dr_is_dragging: false,
    dr_is_scaling: false,
    draw_mode,
    active_page_index,
    dr_scale: 1,
    dr_cached_inv_scale: 1,
    dr_canvas_x: 40,
    dr_canvas_y: -1200,
    dr_start_drag_x: null,
    dr_start_drag_y: null,
    _dr_gesture_vx: 0, _dr_gesture_vy: 0,
    _dr_last_move_time: null,
    _dr_last_canvas_x: null, _dr_last_canvas_y: null,
    _dragFingerId: null,
    _dr_multi_touch_active: true,
    last_x: 0, last_y: 0,
    draw_canvas_rect: null,
    cached_draw_type: 'draw',
    _scroll_container: { style: {} },
    _dr_tile_init_queue: new Set(),
    batch_draw: { _tileRenderer: 'stale' },
    page_manager: { pages_list: mkPages(), switched: [], switch_page(i) { this.switched.push(i); } },
    counts: { cancel_momentum: 0, snap_deferred: 0, on_page_visible: 0, indicator: 0, sync_buttons: 0, start_stroke: 0, ensure_tiles: 0, eraser_hint: 0 },
    _dr_cancel_momentum() { this.counts.cancel_momentum++; },
    _dr_snap_deferred_motion() { this.counts.snap_deferred++; },
    // 连续移动窗口由 _dr_mark_render_gesture 续期，拖拽分支会间接触发它；
    // 这里只需给出字段本身，门控判据就读它
    _dr_mount_block_until: 0,
    _on_page_visible() { this.counts.on_page_visible++; },
    _resize_page_layout() {}, _get_page_base_width: () => 800,
    _init_page_tiles() {}, _update_overlay_size() {},
    _update_page_indicator() { this.counts.indicator++; },
    _sync_page_buttons() { this.counts.sync_buttons++; },
    _ensure_page_tiles() { this.counts.ensure_tiles++; },
    _start_stroke() { this.counts.start_stroke++; },
    _show_eraser_hint() { this.counts.eraser_hint++; },
    _update_eraser_hint_position() {},
    _dr_enable_smooth_transform() {},
    _dr_update_canvas_position() {},
    _dr_update_gesture_velocity() {},
    _dr_last_transform: { x: 0, y: 0, scale: 1 },
    _dr_sync_transform_schedule() {},
  };
  s._dr_begin_pan = (ev) => callBeginPan(s, ev);
  return s;
}

// 真元素会命中 closest；灰色留白的 target 找不到页面 → closest 返回 null
const mkOnPage = (idx) => ({
  dataset: { page: String(idx) },
  closest: (sel) => (sel === '.doc-reader-page' ? mkOnPage(idx) : null),
  getBoundingClientRect: () => ({ left: 100, top: 200, right: 900, bottom: 1300 }),
});
const offPage = () => ({ closest: () => null });

// AGENTS.md 的另一条教训：mock 缺字段时 handler 抛 TypeError，异常若被吞掉，
// 后面每条断言都变成「静默失败」，报告里看不出根因。这里逐次打印。
const run1 = async (label, p) => {
  try { await settle(p); } catch (e) {
    fail++;
    console.log('FAIL  [' + label + '] handler 抛异常: ' + (e && e.stack || e));
  }
};

const down = (self, target, pos = { x: 300, y: 400 }, id = 1, activeCount = 1) => {
  CURRENT_INPUT = { activeCount };
  return inputDown.call(self, { id, position: pos, originEvent: { target, pressure: 0.5 } });
};
const moveEv = (self, pos, id = 1) =>
  inputMove.call(self, { id, position: pos, originEvent: { target: offPage(), pressure: 0.5 } });

const run = async () => {
  // ===== 1. 修复本体：页面外起手要能拖 =====
  for (const mode of ['move', 'comment', 'eraser']) {
    const s = build({ draw_mode: mode });
    await run1(mode, down(s, offPage()));
    eq(`[${mode}] 页面外起手进入拖拽`, s.dr_is_dragging, true);
    eq(`[${mode}] 页面外起手不起笔`, s.is_drawing, false);
  }

  // 起笔前必须快进延后运动：否则延后的 _dr_apply_scale 落在笔画进行中
  const sn = build();
  await run1('snap', down(sn, offPage()));
  eq('起手前快进所有延后运动', sn.counts.snap_deferred, 1);

  // 默认模式就是 comment —— 单独点出来：只在 move 下生效等于没修
  const def = build();
  eq('默认模式是 comment', def.draw_mode, 'comment');
  await run1('default', down(def, offPage()));
  eq('默认模式下页面外起手进入拖拽', def.dr_is_dragging, true);

  // ===== 2. 页面外不该切页 =====
  const p = build({ draw_mode: 'comment', active_page_index: 0 });
  await run1('nocut', down(p, offPage()));
  eq('页面外不切页：active_page_index 不变', p.active_page_index, 0);
  eq('页面外不切页：switch_page 零次', p.page_manager.switched.length, 0);
  eq('页面外不切页：不刷页码/按钮', p.counts.indicator + p.counts.sync_buttons, 0);

  // ===== 3. 页面内行为不变（回归） =====
  for (const mode of ['move', 'comment', 'eraser']) {
    const s = build({ draw_mode: mode, active_page_index: 0 });
    await run1(mode + '-on', down(s, mkOnPage(1), { x: 300, y: 400 }, 1));
    eq(`[${mode}] 页面内起手切到第 1 页`, s.active_page_index, 1);
    eq(`[${mode}] 页面内起手调 switch_page`, s.page_manager.switched.join(), '1');
  }
  {
    const s = build({ draw_mode: 'comment' });
    await run1('comment-on', down(s, mkOnPage(1)));
    eq('[comment] 页面内起手仍是批注（不被平移抢走）', s.is_drawing, true);
    eq('[comment] 页面内起手不进拖拽', s.dr_is_dragging, false);
    eq('[comment] 绑定的是本页 tile_renderer', s.batch_draw._tileRenderer === s.page_manager.pages_list[1].tile_renderer, true);
  }
  {
    const s = build({ draw_mode: 'eraser' });
    await run1('eraser-on', down(s, mkOnPage(1)));
    eq('[eraser] 页面内起手仍是擦除', s.counts.start_stroke, 1);
    eq('[eraser] 显示橡皮提示', s.counts.eraser_hint, 1);
  }

  // page_data 在命中块里是块内 const —— 批注分支重新取的那次必须拿到同一页
  {
    const s = build({ draw_mode: 'comment', active_page_index: 0 });
    await run1('scoped', down(s, mkOnPage(1)));
    eq('批注分支重新取的 page_data 用 active_page_index', s.batch_draw._tileRenderer === s.page_manager.pages_list[1].tile_renderer, true);
  }
  // 页面数据缺失时不能抛（`page_data?.` 兜底）
  {
    const s = build({ draw_mode: 'comment' });
    s.page_manager.pages_list = [];
    let threw = null;
    try { await settle(down(s, mkOnPage(1))); } catch (e) { threw = e; }
    eq('页面数据缺失时不抛', threw === null, true);
  }

  // ===== 4. 端到端：页面外起手 → 拖动跟手 =====
  {
    const s = build({ draw_mode: 'comment' });
    await run1('e2e', down(s, offPage(), { x: 300, y: 400 }, 1));
    await run1('e2e', moveEv(s, { x: 300, y: 340 }, 1));   // 上移 60px
    eq('页面外拖动：位移跟随手指', s.dr_canvas_y, -1200 - 60);
    await run1('e2e', moveEv(s, { x: 360, y: 340 }, 1));   // 右移 60px
    // 内容与手指同向：canvas_x 从 40 跟到 100（锚点 260，手指 360）
    eq('页面外拖动：X 也跟随', s.dr_canvas_x, 100);
    eq('页面外拖动：不进入批注分支', s.is_drawing, false);
  }

  // ===== 5. 起手锚点：按下的那一刻内容不动 =====
  {
    const s = build({ draw_mode: 'comment' });
    await run1('anchor', down(s, offPage(), { x: 300, y: 400 }, 1));
    eq('锚点 X = 按下点 − 当前位移', s.dr_start_drag_x, 300 - 40);
    eq('锚点 Y = 按下点 − 当前位移', s.dr_start_drag_y, 400 - (-1200));
    await run1('anchor', moveEv(s, { x: 300, y: 400 }, 1));   // 手指没动
    eq('手指不动则位移不变（起手不跳）', s.dr_canvas_x + ',' + s.dr_canvas_y, '40,-1200');
  }

  // ===== 6. 惯性起点归零（否则松手会带着上一次的速度飞出去） =====
  {
    const s = build({ draw_mode: 'comment' });
    s._dr_gesture_vx = 900; s._dr_gesture_vy = -900;
    s._dr_last_canvas_x = 77; s._dr_last_canvas_y = 88;
    await run1('vel', down(s, offPage(), { x: 300, y: 400 }, 7));
    eq('起手把 vx 归零', s._dr_gesture_vx, 0);
    eq('起手把 vy 归零', s._dr_gesture_vy, 0);
    eq('起手清空上一帧位移', s._dr_last_canvas_x + ',' + s._dr_last_canvas_y, '40,-1200');
    eq('起手记下当前时刻', s._dr_last_move_time, 1000);
    eq('起手记住手指 id', s._dragFingerId, 7);
    eq('起手放行单指惯性', s._dr_multi_touch_active, false);
  }

  // ===== 7. 守卫顺序：缩放中 / 多指下页面外也不该起拖 =====
  {
    const s = build({ draw_mode: 'comment' });
    s.dr_is_scaling = true;
    await run1('scaling', down(s, offPage()));
    eq('缩放中：页面外不起拖', s.dr_is_dragging, false);
  }
  {
    const s = build({ draw_mode: 'comment' });
    await run1('multi', down(s, offPage(), { x: 300, y: 400 }, 1, 2));
    eq('多指：页面外不起拖', s.dr_is_dragging, false);
  }
  {
    const s = build({ draw_mode: 'comment' });
    s.is_open = false;
    await run1('closed', down(s, offPage()));
    eq('阅读器未打开：不起拖', s.dr_is_dragging, false);
  }

  // ===== 8. 滚轮与页面内外无关（滚轮本就绑在滚动容器上，这里钉住不回归） =====
  ok('滚轮监听绑在滚动容器（页面外同样命中）',
    SRC.includes("this._scroll_container.addEventListener('wheel', this._bound_dr_handle_wheel, { passive: false })"));
  // `closest?.(` 里的 `?.` 必须一并匹配 —— 只写 `closest\(` 的话，
  // 写成 `e.target?.closest?.('.doc-reader-page')` 这种守卫反而能溜过去。
  // 起点必须是**定义处** `_dr_handle_wheel(e) {`：从调用处 `this._dr_handle_wheel(e)`
  // 出发，定义在它前面 1.5 万字符之外，400 字符窗口永远够不到 —— 而这条断言
  // 照样报 PASS，一个从未生效的守卫比没有守卫更危险。
  ok('滚轮处理器不判断事件源是否在页面内',
    !/_dr_handle_wheel\s*\(\s*e\s*\)\s*\{[\s\S]{0,400}?closest\??\.\(\s*'\.doc-reader-page'\s*\)/.test(SRC));

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) process.exitCode = 1;
};

run().catch((e) => {
  console.log('FAIL  未捕获异常: ' + (e && e.stack || e));
  console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exitCode = 1;
});