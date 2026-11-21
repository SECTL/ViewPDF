/**
 * flip-perf.mjs —— 翻页卡顿修复的执行型守卫（对应 2026-11-21 的两项改动）
 *
 * 静态正则看不出「期望参数在哪个分支算出」「节流门先于仍谁占槽」这类控制流问题。
 * 本文件把真实的 document_reader.js 装进 vm，直接执行：
 *   1. _pdf_desired_render_params：翻页目标页（_dr_flip_target）豁免运动期降密度，
 *      非目标页仍降到运动期上限；目标页参数在首个 await 前同步算出。
 *   2. _scroll_to_page：_dr_flip_target 只在 apply_scale 调用期有效，异常路径也复位。
 *   3. _pdf_commit_render_result：可见活动页的真实提交直通 48ms 全局节流；
 *      预渲染提交仍被节流；手势期挂起优先级不变。
 *
 * 用法：node tests/flip-perf.mjs
 */
import fs from 'node:fs';

const SRC = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, extra = '') {
    if (cond) { pass++; console.log('PASS  ' + label); }
    else { fail++; failures.push(label); console.log('FAIL  ' + label + (extra ? '  ' + extra : '')); }
}
function eq(label, got, want) { ok(label + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want), Object.is(got, want)); }

/* ─────────── 装载真实类 ─────────── */
function loadClass(window, perf, raf, setTimeoutFn) {
    const start = SRC.indexOf('const PDF_DPR_LADDER');
    const end = SRC.indexOf('\nconst documentReaderManager = new DocumentReaderManager();');
    if (start < 0 || end < 0) throw new Error('找不到 document_reader.js 类边界');
    const body = SRC.slice(start, end);
    const stubs = `
const InputSource = class {}, PinchZoomSourceV2 = class {}, ZoomWallDamper = class {};
const DocumentReaderPageManager = class {};
const history_execute_command = () => Promise.resolve(), history_init_manager = () => {};
const history_validate_undo = () => false, history_validate_redo = () => false;
const history_handle_undo = () => {}, history_handle_redo = () => {};
const history_handle_state_change = () => {}, history_trim_undo_front = () => {};
const history_peek_undo = () => null, history_peek_redo = () => null;
const DrawCommand = class {}, ClearCommand = class {};
const history_state = { undo_list: [], redo_list: [], on_state_change: null };
`;
    return new Function('window', 'document', 'performance', 'requestAnimationFrame',
        'cancelAnimationFrame', 'requestIdleCallback', 'setTimeout', 'clearTimeout',
        'ImageBitmap', 'createImageBitmap', 'localStorage', 'getComputedStyle',
        'ResizeObserver', 'IntersectionObserver', 'console', 'Worker',
        stubs + body + '\nreturn DocumentReaderManager;'
    )(window,
      { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, getContext() { return {}; } }),
        addEventListener() {}, body: { appendChild() {} }, activeElement: null },
      perf, raf, () => {}, (fn) => raf(fn), setTimeoutFn, () => {},
      class ImageBitmap { constructor(w, h) { this.width = w; this.height = h; } close() {} },
      async () => ({}), { getItem: () => null }, () => ({}),
      function RO() {}, function IO() {}, console, function W() {});
}

const perf = { now: () => 1000 };
let rafSeq = 0;
const rafQueue = new Map();
const raf = (fn) => { const id = ++rafSeq; rafQueue.set(id, fn); return id; };
const timers = new Map();
let timerSeq = 0;
const setTimeoutFn = (fn, ms) => { const id = ++timerSeq; timers.set(id, fn); return id; };
const window = {
    state: { fileList: [] }, DRAW_CONFIG: {}, innerWidth: 1600, innerHeight: 900,
    ResolutionController: {
        mark_interaction() {},
        // scale=1 → 2x，经阶梯量化 + 2048 位图宽上限 → 1.25
        calc_tile_dpr: () => 2,
    },
};
const Reader = loadClass(window, perf, raf, setTimeoutFn);

/* ══════════ 1. 翻页目标豁免运动期降密度 ══════════ */
console.log('=== 1. _pdf_desired_render_params：翻页目标豁免 ===');
{
    const r = new Reader();
    r.dr_scale = 1;
    r._dr_is_zooming = false;
    r._render_pause_until = 0;
    r._dr_flip_recent_until = 2000;   // 连点窗口生效 → 运动期降密度激活
    r._DR_MOTION_DPR_MAX = 0.75;
    r.active_page_index = 0;
    const pd = {
        page_element: { style: { width: '1568px' } },
        page_width: 595, page_height: 842,
        pdf_render_css_width: 0, is_visible: true,
    };
    r.page_manager = { pages_list: [pd] };

    ok('前置：连点窗口确实激活了运动期降密度', r._pdf_motion_dpr_active() === true);
    r._dr_flip_target = 0;
    const asTarget = r._pdf_desired_render_params(0, pd, false);
    r._dr_flip_target = -1;
    const asPlain = r._pdf_desired_render_params(0, pd, false);
    eq('翻页目标 target_dpr 不降密度', asTarget.target_dpr, 1.25);
    eq('非目标页仍降到 0.75 上限', asPlain.target_dpr, 0.75);
    r._dr_flip_target = 0;
    r.active_page_index = 5;   // 距离 >1 的预渲染页仍按 1x
    eq('豁免只作用于真实渲染，预渲染仍按距离分级（dist>1 → 1x）',
        r._pdf_desired_render_params(0, pd, true).target_dpr, 1);
    r._dr_flip_target = -1;
    r.active_page_index = 0;

    // 已有内容的页本来就不降密度：豁免不得改变它（避免误升档引起重渲染）
    pd.pdf_render_css_width = 1568; pd.pdf_render_dpr = 1.25;
    const withContent = r._pdf_desired_render_params(0, pd, false);
    eq('已有内容页不受影响', withContent.target_dpr, 1.25);
}

/* ══════════ 2. _scroll_to_page 的瞬时标记 ══════════ */
console.log('\n=== 2. _scroll_to_page：_dr_flip_target 只在 apply_scale 期有效 ===');
{
    const r = new Reader();
    r.is_open = true;
    r.dr_scale = 1;
    const pd = { page_element: {}, _cached_top: 100, _cached_h: 1000, tile_renderer: null };
    r.page_manager = { pages_list: [pd], current_index: 0, get_page_count: () => 1 };
    r._dom_virtualize = () => false;
    r._scroll_container = { clientHeight: 900, clientWidth: 1600 };
    r._zoom_wrapper = { style: {} };
    const seen = [];
    r._dr_apply_scale = () => { seen.push(r._dr_flip_target); };
    r._dr_note_flip = () => {};
    r._prerender_for_navigation = () => {};
    await r._scroll_to_page(0);
    eq('apply_scale 期间标记为目标页', seen.join(','), '0');
    eq('apply_scale 返回后标记已复位', r._dr_flip_target, -1);

    // 异常路径同样复位（残留会让后续滚动中的远页永久走全量 DPR）
    r._dr_apply_scale = () => { throw new Error('boom'); };
    let caught = false;
    try { await r._scroll_to_page(0); } catch (_) { caught = true; }
    ok('apply_scale 抛错时异常向外传播（不被吞掉）', caught);
    eq('异常路径也复位 _dr_flip_target', r._dr_flip_target, -1);
}

/* ══════════ 3. 提交节流：活动页直通、预渲染仍被节流 ══════════ */
console.log('\n=== 3. _pdf_commit_render_result：活动页提交直通 ===');
// ImageBitmap instanceof 判定用的是 vm 工厂注入的类，故用同一个 ProbeBitmap 重新装载
{
    class ProbeBitmap { constructor() { this.width = 1960; this.height = 2774; } close() {} }
    // 重新装载，把 ImageBitmap 换成 ProbeBitmap
    const start = SRC.indexOf('const PDF_DPR_LADDER');
    const end = SRC.indexOf('\nconst documentReaderManager = new DocumentReaderManager();');
    const stubs = `
const InputSource = class {}, PinchZoomSourceV2 = class {}, ZoomWallDamper = class {};
const DocumentReaderPageManager = class {};
const history_execute_command = () => Promise.resolve(), history_init_manager = () => {};
const history_validate_undo = () => false, history_validate_redo = () => false;
const history_handle_undo = () => {}, history_handle_redo = () => {};
const history_handle_state_change = () => {}, history_trim_undo_front = () => {};
const history_peek_undo = () => null, history_peek_redo = () => null;
const DrawCommand = class {}, ClearCommand = class {};
const history_state = { undo_list: [], redo_list: [], on_state_change: null };
`;
    const PReader = new Function('window', 'document', 'performance', 'requestAnimationFrame',
        'cancelAnimationFrame', 'requestIdleCallback', 'setTimeout', 'clearTimeout',
        'ImageBitmap', 'createImageBitmap', 'localStorage', 'getComputedStyle',
        'ResizeObserver', 'IntersectionObserver', 'console', 'Worker',
        stubs + SRC.slice(start, end) + '\nreturn DocumentReaderManager;'
    )(window,
      { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, getContext() { return {}; } }),
        addEventListener() {}, body: { appendChild() {} }, activeElement: null },
      perf, raf, () => {}, (fn) => raf(fn), setTimeoutFn, () => {},
      ProbeBitmap, async () => ({}), { getItem: () => null }, () => ({}),
      function RO() {}, function IO() {}, console, function W() {});

    const r = new PReader();
    r.is_open = false;
    r._render_pause_until = 0;
    r._dr_is_zooming = false;
    r.active_page_index = 0;
    r._dr_flushing_commits = false;
    r._dr_last_full_commit_at = 1000;
    r._note_render_success = () => {};
    r._bitmap_cache_put = () => {};
    r._get_page_aspect = () => 595 / 842;
    r._get_page_base_width = () => 1568;
    r._invalidate_page_positions = () => {};
    let deferred = 0;
    r._dr_defer_commit = () => { deferred++; };
    r._dr_schedule_deferred_flush = () => {};
    const mkPd = () => ({
        pdf_render_seq: 7, is_visible: true,
        page_element: { style: { width: '1568px' } },
        pdf_canvas: { width: 0, height: 0, style: {}, getContext() { return { setTransform() {}, drawImage() {} }; } },
    });
    const mkSrc = () => new ProbeBitmap();

    // ① 活动页真实渲染：48ms 门关闭时仍直通
    const pdActive = mkPd();
    const activeCommitted = r._pdf_commit_render_result(0, pdActive, mkSrc(), 1960, 2774, 1568, 1.25, 7, false, true, false);
    ok('可见活动页的真实提交在 48ms 门内直通', activeCommitted === true && deferred === 0);
    eq('直通仍占用全局提交节奏（_dr_last_full_commit_at 已更新）', r._dr_last_full_commit_at, 1000);

    // ② 预渲染（非活动页）：同样条件下被节流挂起
    const pdPre = mkPd();
    r._dr_last_full_commit_at = 1000;
    const preCommitted = r._pdf_commit_render_result(1, pdPre, mkSrc(), 1960, 2774, 1568, 1, 7, true, true, false);
    ok('预渲染提交在 48ms 门内被挂起', preCommitted === true && deferred === 1);
    ok('被挂起页打上 _dr_commit_pending', pdPre._dr_commit_pending === true);

    // ③ 手势期挂起优先级不变：活动页也不能在 _dr_renders_paused 时直通
    r._dr_renders_paused = () => true;
    r._dr_last_full_commit_at = 0;
    const pdGesture = mkPd();
    r._pdf_commit_render_result(0, pdGesture, mkSrc(), 1960, 2774, 1568, 1.25, 7, false, true, false);
    eq('手势期挂起优先级高于活动页直通', deferred, 2);

    // ④ 非活动页的真实提交不直通：「可见」不是通行证，必须是用户正盯着的活动页
    r._dr_renders_paused = () => false;
    r._dr_last_full_commit_at = 1000;
    const pdNeighbor = mkPd();
    r._pdf_commit_render_result(2, pdNeighbor, mkSrc(), 1960, 2774, 1568, 1.25, 7, false, true, false);
    eq('非活动可见页的真实提交仍被节流', deferred, 3);
}

console.log('');
console.log('==================== 汇总 ====================');
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (failures.length) console.log('  失败: ' + failures.join('; '));
if (fail) process.exitCode = 1;
