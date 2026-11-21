/**
 * display-canvas-pool.mjs —— 显示画布池的执行型守卫
 *
 * 对应翻页卡顿修复：页面离开视口时归还已分配 backing store 的显示画布，
 * 新页/回翻页从池里按尺寸取用，避免 canvas.width/height 重分配
 * （真机单次重分配 ~200ms rAF 帧饿）。
 *
 * 用法：node tests/display-canvas-pool.mjs
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
const start = SRC.indexOf('const PDF_DPR_LADDER');
const end = SRC.indexOf('\nconst documentReaderManager = new DocumentReaderManager();');
if (start < 0 || end < 0) throw new Error('找不到类边界');
const window = { state: {}, DRAW_CONFIG: {}, innerWidth: 1600, innerHeight: 900 };
let reallocs = 0;
const document = {
    getElementById: () => null,
    createElement(tag) {
        if (tag !== 'canvas') return { style: {}, appendChild() {}, getContext() { return {}; } };
        let w = 0, h = 0;
        return {
            className: '', style: {}, parentNode: null, __pooled: false,
            get width() { return w; },
            set width(v) { if (v !== w) reallocs++; w = v; },
            get height() { return h; },
            set height(v) { if (v !== h) reallocs++; h = v; },
            getContext() { return { setTransform() {}, drawImage() {} }; },
            removeChild() {},
        };
    },
    addEventListener() {}, body: { appendChild() {} }, activeElement: null,
};
const R = new Function('window', 'document', 'performance', 'requestAnimationFrame',
    'cancelAnimationFrame', 'requestIdleCallback', 'setTimeout', 'clearTimeout',
    'ImageBitmap', 'createImageBitmap', 'localStorage', 'getComputedStyle',
    'ResizeObserver', 'IntersectionObserver', 'console', 'Worker',
    stubs + SRC.slice(start, end) + '\nreturn DocumentReaderManager;'
)(window, document, { now: () => 1000 }, () => 1, () => {}, () => 1, () => 1, () => {},
  class ImageBitmap {}, async () => ({}), { getItem: () => null }, () => ({}),
  function RO() {}, function IO() {}, console, function W() {});

/* ══════════ 1. 池的取用 / 归还 / 零尺寸过滤 ══════════ */
console.log('=== 1. _acquire / _release_display_canvas ===');
{
    reallocs = 0;
    const r = new R();
    const c1 = r._acquire_display_canvas(1960, 2774);
    eq('新建画布触发 2 次 backing-store 分配', reallocs, 2);
    eq('尺寸正确', [c1.width, c1.height].join('x'), '1960x2774');

    r._release_display_canvas(c1);
    eq('归还后池里有 1 块', r._display_canvas_pool.length, 1);
    eq('字节计数正确', r._display_canvas_pool_bytes, 1960 * 2774 * 4);

    const c2 = r._acquire_display_canvas(1960, 2774);
    ok('同尺寸取用复用同一块画布', c1 === c2);
    eq('复用不触发任何重分配', reallocs, 2);
    eq('取用后池已空', r._display_canvas_pool.length, 0);

    r._release_display_canvas(c2);
    const before = r._display_canvas_pool.length;
    r._release_display_canvas({ width: 0, height: 0, __pooled: false });
    eq('默认/空画布不入池（否则零字节占满数量上限）', r._display_canvas_pool.length, before);

    // 数量上限
    const r2 = new R();
    for (let i = 0; i < 8; i++) r2._release_display_canvas({ width: 100, height: 100, __pooled: false, parentNode: null });
    eq('数量上限生效', r2._display_canvas_pool.length, r2._display_canvas_pool_max_count);
}

/* ══════════ 2. 页面隐藏时归还画布 ══════════ */
console.log('\n=== 2. _on_page_hidden：离开视口即归还 ===');
{
    const r = new R();
    const canvas = { width: 1960, height: 2774, __pooled: false, parentNode: { removeChild() {} } };
    let removed = 0;
    canvas.parentNode.removeChild = () => { removed++; };
    const pd = { page_element: {}, pdf_canvas: canvas, _visible_cleanup_timeout_id: 21 };
    r.page_manager = { pages_list: [pd] };
    let cleared = 0;
    const realClear = r._release_display_canvas.bind(r);
    r._release_display_canvas = (c) => { cleared++; return realClear(c); };

    r._on_page_hidden(0);
    eq('归还调用一次', cleared, 1);
    eq('画布已从 DOM 摘除', removed, 1);
    ok('页面不再持有画布引用', pd.pdf_canvas === null);
    ok('渲染守卫清零（回翻走缓存快速路径）', pd.pdf_render_css_width === 0);
    ok('旧清理定时器被新定时器替换（不会双重清理）', typeof pd._visible_cleanup_timeout_id === 'number' && pd._visible_cleanup_timeout_id !== 21);
}

/* ══════════ 3. 源码位置守卫：取用在提交之前 ══════════ */
console.log('\n=== 3. 源码顺序守卫 ===');
{
    const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const src = strip(SRC);
    const renderIdx = src.indexOf('async _render_pdf_page_direct');
    const acquireIdx = src.indexOf('_acquire_display_canvas(expect_w, expect_h)', renderIdx);
    const commitIdx = src.indexOf('_bitmap_cache_get(page_index, css_w, target_dpr)', renderIdx);
    ok('_render_pdf_page_direct 在缓存路径之前取用预尺寸画布',
        acquireIdx > renderIdx && acquireIdx < commitIdx,
        `render=${renderIdx} acquire=${acquireIdx} cache=${commitIdx}`);
    ok('_on_page_hidden 有归还调用', /_on_page_hidden[\s\S]{0,1200}?_release_display_canvas/.test(src));
}

console.log('');
console.log('==================== 汇总 ====================');
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (failures.length) console.log('  失败: ' + failures.join('; '));
if (fail) process.exitCode = 1;
