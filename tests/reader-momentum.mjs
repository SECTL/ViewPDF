// 惯性（动量）滑行的行为测试。
//
// 重点不是「动量公式还对不对」（那没动过），而是惯性**每帧**到底做了什么：
// 这条路径是自驱 rAF，帧间隔 ~16.7ms，任何按「每帧最多一次」写的节流都会失效。
// 旧实现正是如此：移动边界几何用 16ms TTL 缓存，实测从不命中 → 每帧 3 次强制布局读。
//
// 方法体直接从真实源码抠出、用 .call(mock) 执行，mock 只提供依赖与计数器，
// 这样测的是真代码而不是复刻品。
import fs from 'node:fs';

const SRC = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
function ok(label, got) { eq(label, !!got, true); }

// 从真实源码抠出方法体，保留 this 语义
const methods = {};
for (const name of ['_dr_update_move_bound', '_dr_update_canvas_position',
  '_dr_start_momentum', '_dr_momentum_tick', '_dr_snap_deferred_motion']) {
  const m = new RegExp('(?:^|\\n)\\s*' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(SRC);
  if (!m) { console.error('FAIL  未找到方法 ' + name); process.exit(1); }
  methods[name] = new Function(m[1]);
}

// ---- 可控时钟 ----
let NOW = 1000;
const tick = (ms) => { NOW += ms; };
const perf = { now: () => NOW };

// ---- 带读取计数的假容器 ----
const mkContainer = () => ({
  reads: 0,
  clientWidth: 1920,          // 先赋值，下面换成 getter 计数
  clientHeight: 1080,
  scrollWidth: 1920, scrollHeight: 14000,
});

const build = (opts = {}) => {
  const container = mkContainer();
  let cw = 1920, ch = 1080;
  Object.defineProperty(container, 'clientWidth', { get() { container.reads++; return cw; }, set: (v) => { cw = v; } });
  Object.defineProperty(container, 'clientHeight', { get() { container.reads++; return ch; }, set: (v) => { ch = v; } });

  const ctl = { rafs: new Map(), seq: 0, idle: null };
  const self = {
    _zoom_wrapper: { scrollWidth: 1920, scrollHeight: 14000 },
    _scroll_container: container,
    dr_move_bound: { min_x: 0, max_x: 0, min_y: 0, max_y: 0 },
    dr_scale: 1,
    dr_canvas_x: 0, dr_canvas_y: -2000,
    _page_positions: { total: 14000, stale: false },
    _dr_mb_dom_cache: null, _dr_mb_dom_time: 0, _dr_mb_dom_dirty: true,
    _dr_last_transform: { x: 0, y: 0, scale: 1 },
    _dr_momentum_raf: null, _dr_momentum_last_ts: null, _dr_momentum_vis_t: 0,
    _dr_momentum_final_id: null,
    _dr_transform_raf_id: null, _dr_pending_transform: null,
    dr_cached_inv_scale: 1,
    overlay_inv: 0,
    batch_draw: { overlay: { invalidate_transform() { self.overlay_inv++; } } },
    _dr_gesture_vx: 0, _dr_gesture_vy: 0,
    _dr_multi_touch_active: false, _dr_last_move_time: null,
    _dr_is_zooming: false,
    vis_calls: 0, transforms: 0, scale_applies: 0, pump_stops: 0,
    _get_page_base_width: () => Math.max(200, container.clientWidth - 32),
    _dr_stop_prerender_pump() { self.pump_stops++; },
    _check_page_visibility() { self.vis_calls++; },
    _dr_sync_transform() { self.transforms++; },
    _dr_schedule_disable_smooth_transform() {},
    _dr_cancel_momentum() {
      if (self._dr_momentum_raf !== null) { ctl.rafs.delete(self._dr_momentum_raf); self._dr_momentum_raf = null; }
    },
    // 连续移动窗口由 _dr_mark_render_gesture 续期；惯性 tick 本身不碰它，
    // 但门控判据会读，缺席会让「非 0」的判据恒成立（等于门控永久放行）
    _dr_mount_block_until: 0,
  };
  // 方法体里的 this 必须指向 self 本身：不能用 bind({...self}) 绑到快照副本——
  // 那样 _dr_momentum_tick 对速度的递减会写到副本上，惯性两帧就「停」了。
  for (const n of Object.keys(methods)) self[n] = () => methods[n].call(self);
  // 真实 _dr_apply_scale 内部会刷可见性，这里用计数代理并记录 impulse 实参
  self._dr_apply_scale = (impulse = false) => {
    self.scale_applies++; self.vis_calls++; self.last_apply_impulse = impulse;
  };
  ctl.self = self;
  ctl.resizeContainer = (w, h) => { container.clientWidth = w; container.clientHeight = h; };
  return ctl;
};

// rAF / rIC 需要注入：方法体里调用的是全局 requestAnimationFrame
globalThis.performance = perf;
globalThis.requestAnimationFrame = null;   // 由 bindClock 按每个 build 覆写
globalThis.requestIdleCallback = null;
globalThis.cancelAnimationFrame = null;
globalThis.window = { DRAW_CONFIG: { momentumEnabled: true } };

// rAF / rIC 注入：源码用的是裸全局 requestAnimationFrame，但 doFinal 走的是
// window.requestIdleCallback —— 两者都要给，否则会走同步退路分支而测不到延后路径。
//
// id 必须稳定自增：早先写成 `++c.seq || (c.seq = 1)`，首次求值为 NaN（falsy）
// 于是回落到 1，把序列压成 1,2,3…；这个「碰巧能用」的写法一旦让两个 id 撞车，
// rAF 链就会静默断掉、惯性只跑 2 帧，后面所有按帧计数的断言都会失去意义。
const bindClock = (c) => {
  globalThis.requestAnimationFrame = (cb) => {
    const id = ++c.seq;
    c.rafs.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => c.rafs.delete(id);
  globalThis.requestIdleCallback = (cb) => { c.idle = cb; };
  globalThis.window.requestIdleCallback = (cb) => { c.idle = cb; };
  globalThis.window.cancelIdleCallback = (id) => { c.cancelIdle = id; };
};

// ========== 4. 惯性开始即停预渲染泵 ===========
// 必须照抄 inputUp（真实代码 document_reader.js 的 inputUp 分支）的顺序：
//   _dr_update_move_bound(); _dr_update_canvas_position(); _dr_start_momentum();
// 少了前两步，dr_move_bound 还是初始 0 → 第一帧就被钳到 0，
// 速度被判为「撞边」清零，惯性 2 帧就死掉（我第一版测试就踩了这个坑）。
const fling = (mutate) => {
  const c = build();
  bindClock(c);
  const self = c.self;
  self._dr_gesture_vy = -30;
  self._dr_last_move_time = perf.now() - 10;   // 刚动过 → 允许惯性
  mutate?.(self);
  self._dr_update_move_bound();
  self._dr_update_canvas_position();
  self._dr_start_momentum();
  return c;
};

// ========== 1. 几何读取策略 ==========
// 先说清调用图（这决定断言怎么写）：
//   惯性 tick        → _dr_update_canvas_position()，**不**重算边界
//   惯性 inputUp     → _dr_update_move_bound() 一次
//   _dr_apply_scale  → _dr_update_move_bound()（滚轮缩放 / 捏合 delta / 收尾）
// 所以惯性滑行逐帧本来就不读 DOM；高频读 DOM 的是捏合/滚轮那条路径。
{
  const c = build();
  bindClock(c);
  const self = c.self;

  self._dr_update_move_bound();
  const first = c.self._scroll_container.reads;
  ok('首次调用读 DOM 填缓存', first >= 2);

  // 高频路径：连续 300 次（模拟捏合 delta 60~120Hz）
  const FRAMES = 300;
  for (let i = 0; i < FRAMES; i++) { tick(16.7); self._dr_update_move_bound(); }
  const extra = c.self._scroll_container.reads - first;
  console.log('      （高频路径 ' + FRAMES + ' 次调用，DOM 读 ' + extra +
    ' 次 = ' + (extra / FRAMES).toFixed(3) + ' 次/次；旧的 16ms TTL 为 3.000）');
  ok('高频路径 DOM 读 ≤ 0.2 次/次（不随回调数线性增长）', extra <= FRAMES * 0.2);
  ok('且确实读远少于「每次都读」的旧行为', extra < FRAMES * 3 * 0.1);
}

// 惯性滑行本身不应重算边界：一旦有人「顺手」把它加进 tick，
// 就会把高频 DOM 读带回来。这条要锁住。
{
  const c = fling();
  const self = c.self;
  const base = c.self._scroll_container.reads;
  let frames = 0;
  while (c.rafs.size > 0 && frames < 600) {
    const cb = [...c.rafs.values()][0];
    c.rafs.clear();
    tick(16.7);
    cb();
    frames++;
  }
  eq('整段惯性滑行期间不重算边界（DOM 读 0 次）', c.self._scroll_container.reads - base, 0);
}

// ========== 2. 两条失效源都会触发重读 ==========
{
  const c = build();
  bindClock(c);
  const self = c.self;
  self._dr_update_move_bound();
  const base = c.self._scroll_container.reads;

  tick(16.7); self._dr_update_move_bound();
  eq('无失效时不重读', c.self._scroll_container.reads, base);

  self._dr_mb_dom_dirty = true;   // _invalidate_page_positions() 的副作用
  tick(16.7); self._dr_update_move_bound();
  ok('布局重算（_invalidate_page_positions）后重读几何', c.self._scroll_container.reads > base);
}
{
  const c = build();
  bindClock(c);
  const self = c.self;
  self._dr_update_move_bound();
  const base = c.self._scroll_container.reads;
  self._dr_mb_dom_dirty = true;   // reader resize 轻量通道的副作用
  tick(16.7); self._dr_update_move_bound();
  ok('容器尺寸变化（resize 轻量通道）后重读几何', c.self._scroll_container.reads > base);
}

// ========== 3. 未登记路径的兜底阈值 ==========
{
  const c = build();
  bindClock(c);
  const self = c.self;
  self._dr_update_move_bound();
  for (let i = 0; i < 29; i++) { tick(16.7); self._dr_update_move_bound(); }   // ≈485ms
  const before = c.self._scroll_container.reads;
  tick(16.7); self._dr_update_move_bound();                                      // 跨过 500ms
  ok('超过 500ms 兜底阈值会重读一次', c.self._scroll_container.reads > before);
}

{
  const c = fling();
  // fling 的 mutate/前置调用可能已触碰泵计数；这里只断言「本次 start 停了一次」
  eq('惯性开始即停止预渲染泵', c.self.pump_stops >= 1, true);
}
{
  const c = build();
  bindClock(c);
  const self = c.self;
  self._dr_gesture_vy = -30;
  self._dr_last_move_time = perf.now() - 500;   // 松手前已停顿
  self.pump_stops = 0;  // 隔离：只计本次 start 的副作用
  self._dr_start_momentum();
  eq('松手前已停顿时不起惯性', self._dr_momentum_raf, null);
  // 停顿分支应在任何停泵之前 return
  eq('  且不误停预渲染泵', self.pump_stops, 0);
}
{
  const c = fling((s) => { s._dr_multi_touch_active = true; });   // 双指
  eq('双指手势不触发惯性', c.self._dr_momentum_raf, null);
}

// ========== 5. 惯性期刷新可见性且被限频 ===========
{
  const c = fling();
  const self = c.self;
  // 关键：把 doFinal 的退路也改成延后到 idle。否则末帧会走 `else doFinal()`
  // 同步分支，而 _dr_apply_scale 内部会刷一次可见性 —— 那会让
  // 「惯性期有刷新可见性」这条断言被**收尾**动作满足，测不到中途是否刷新。
  globalThis.window.requestIdleCallback = (cb) => { c.idle = cb; };
  const v0 = self.vis_calls;
  let frames = 0;
  while (c.rafs.size > 0 && frames < 600) {
    const cb = [...c.rafs.values()][0];
    c.rafs.clear();
    tick(16.7);
    cb();
    frames++;
  }
  const midFling = self.vis_calls - v0;
  console.log('      （惯性共 ' + frames + ' 帧，滑行途中刷新可见性 ' + midFling +
    ' 次 = ' + (midFling / frames).toFixed(2) + ' 次/帧；33ms 限频应约 0.5）');
  // 先确认样本量够大，否则比值断言没有意义（帧数太少时任何实现都能落在宽松上界内）
  ok('惯性样本足够长（否则限频断言形同虚设）', frames >= 40);
  ok('惯性期会刷新可见性（滑入的页不留空白）', midFling > 0);
  ok('可见性刷新被限频（约每 2 帧一次，而非每帧）',
     midFling / frames <= 0.55);
  ok('惯性期持续推进 transform', self.transforms > 0);
}

// ========== 6. 收尾不重复全量扫描 ===========
{
  const c = fling();
  const self = c.self;
  while (c.rafs.size > 0) { const cb = [...c.rafs.values()][0]; c.rafs.clear(); tick(16.7); cb(); }
  eq('滑行停下后 rAF 链终止', self._dr_momentum_raf, null);
  const vEnd = self.vis_calls;
  ok('收尾任务已排入 idle 队列（未同步执行）', typeof c.idle === 'function');
  eq('排入瞬间尚未应用几何', self.scale_applies, 0);
  c.idle();
  eq('收尾只应用一次缩放/几何', self.scale_applies, 1);
  eq('非缩放态下收尾不额外再扫一轮可见性', self.vis_calls - vEnd, 1);
  // 滑行落点必须走冲量：否则 _dr_apply_scale → _dr_sync_transform 会续期
  // 渲染暂停并重新限流 worker，把刚启动的全速渲染再推后 ~170ms。
  eq('滑行落点走冲量（不二次续期渲染暂停）', self.last_apply_impulse, true);
}

// ========== 6b. 起笔前快进所有延后运动（否则笔迹错位 + 卡顿）============
{
  const c = fling();
  const self = c.self;
  while (c.rafs.size > 0) { const cb = [...c.rafs.values()][0]; c.rafs.clear(); tick(16.7); cb(); }
  // 收尾已排 idle，再挂一个 transform 排队帧——两者都可能晚于起笔落地
  self._dr_momentum_final_id = 77;
  self._dr_transform_raf_id = 99;
  self._dr_pending_transform = { x: 123, y: 456, scale: 1 };
  self.dr_scale = 2;
  const t0 = self.transforms;
  self._dr_snap_deferred_motion();

  eq('取消延后的 idle 收尾', self._dr_momentum_final_id, null);
  eq('  真的调用了 cancelIdleCallback', c.cancelIdle, 77);
  eq('丢弃排队的 transform rAF', self._dr_transform_raf_id, null);
  eq('  排队数据也清空', self._dr_pending_transform, null);
  ok('立即把当前状态写进 DOM', self.transforms > t0);
  eq('倒数缩放同步到当前比例', self.dr_cached_inv_scale, 0.5);
  ok('覆盖层变换缓存失效（下一帧重新对齐）', self.overlay_inv > 0);
  eq('收尾任务不再执行（起笔帧没有重活）', self.scale_applies, 0);
}

// ========== 6c. 起笔入口确实调用了快进 ===========
ok('inputDown 接线：调用了 _dr_snap_deferred_motion',
  /this\._dr_snap_deferred_motion\(\);/.test(SRC));

// ========== 7. 边界钳制语义未变（改了缓存不等于改了语义）============
{
  const c = build();
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => { };
  globalThis.requestIdleCallback = () => { };
  const self = c.self;
  self._dr_update_move_bound();
  eq('Y 边界 min（内容 14000 − 视口 1080）', self.dr_move_bound.min_y, -(14000 - 1080));
  eq('Y 边界 max', self.dr_move_bound.max_y, 0);
  // 内容宽 = clientWidth − 32 = 1888 < 视口 1920 → 不铺满 → 居中留白 16px。
  // （旧实现读到的值一样，此处只是确认换成缓存后没算错。）
  eq('X 边界 min（内容 1888 < 视口 1920 → 居中留白）', self.dr_move_bound.min_x, (1920 - 1888) / 2);
  eq('X 边界 max', self.dr_move_bound.max_x, (1920 - 1888) / 2);
  // 钳制按设计允许 ±eps（0.001）越界余量，避免贴边抖动，这里一并锁住
  self.dr_canvas_y = 999999;
  self._dr_update_canvas_position();
  eq('越界位置被钳回 max+eps', self.dr_canvas_y, 0.001);
  self.dr_canvas_y = -999999;
  self._dr_update_canvas_position();
  eq('越界位置被钳回 min−eps', self.dr_canvas_y, -(14000 - 1080) - 0.001);
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);