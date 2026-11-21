/**
 * flip-prerender-layout.mjs —— 翻页邻页预渲染调度 + 幂等布局写入的执行型守卫
 *
 * 对应 2026-11-21 的两项改动：
 *   1. _prerender_for_navigation 的 ±1 邻页改走 rAF（原 requestIdleCallback 在
 *      连点翻页的 rAF 洪流里被饿死，1000ms 超时才跑 = 全程无效）；
 *      并显式跳过只为滚动设计的「连续移动不挂视口外」门控。
 *   2. _set_page_box_size 幂等写入不再置脏全局页坐标 / DOM 几何缓存——
 *      否则每次 _on_page_visible 的「什么都没改」都会触发 O(N) 重布局。
 *
 * 用法：node tests/flip-prerender-layout.mjs
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

function loadClass(window, raf, idle) {
    const start = SRC.indexOf('const PDF_DPR_LADDER');
    const end = SRC.indexOf('\nconst documentReaderManager = new DocumentReaderManager();');
    if (start < 0 || end < 0) throw new Error('找不到 document_reader.js 类边界');
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
        stubs + SRC.slice(start, end) + '\nreturn DocumentReaderManager;'
    )(window,
      { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {}, getContext() { return {}; } }),
        addEventListener() {}, body: { appendChild() {} }, activeElement: null },
      { now: () => 1000 }, raf, () => {}, idle, () => 0, () => {},
      class ImageBitmap {}, async () => ({}), { getItem: () => null }, () => ({}),
      function RO() {}, function IO() {}, console, function W() {});
}

const idleCounters = [];
const window = { state: { fileList: [] }, DRAW_CONFIG: {}, innerWidth: 1600, innerHeight: 900,
    ResolutionController: { mark_interaction() {}, calc_tile_dpr: () => 2 },
    // 变异体可能把 rAF 换回 window.requestIdleCallback：必须仍走同一个计数器，
    // 否则变异会崩在 TypeError 上、没有 FAIL 行，看起来像「守卫没抓到」。
    requestIdleCallback: (fn) => { idleCounters.push(fn); return idleCounters.length; } };

/* ══════════ 1. 翻页邻页预渲染走 rAF，且跳过移动门控 ══════════ */
console.log('=== 1. _prerender_for_navigation：rAF + skip_mount_gate ===');
{
    const rafs = [], idles = [];
    const raf = (fn) => { rafs.push(fn); return rafs.length; };
    const idle = (fn) => { idles.push(fn); return idles.length; };
    const R = loadClass(window, raf, idle);
    const r = new R();
    r.is_open = true;
    r._prerender_enabled = true;
    r._dom_virtualize = () => false;   // 不需要 DOM 预挂载分支
    r._zoom_wrapper = { appendChild() {} };
    r._wrapper_keep_distance = 50;
    r.active_page_index = 5;
    const pages = Array.from({ length: 10 }, (_, i) => ({
        page_num: i + 1, is_visible: false, pdf_render_promise: null, page_element: {},
    }));
    r.page_manager = { pages_list: pages, current_index: 5 };
    const prerendered = [];
    r._prerender_page = (idx, skip) => { prerendered.push([idx, skip]); };

    r._prerender_for_navigation(5);
    eq('只调度一次 rAF', rafs.length, 1);
    eq('不再走 requestIdleCallback', idles.length + idleCounters.length, 0);
    eq('rAF 回调执行前不派发（下一合成帧才做）', prerendered.length, 0);
    // 变异体可能把 rAF 换掉：守卫已 FAIL，别再让 rafs[0] 抛错掩盖诊断
    if (typeof rafs[0] === 'function') rafs[0]();
    eq('邻页 ±1 都被预渲染', JSON.stringify(prerendered.map(x => x[0])), '[4,6]');
    ok('翻页邻页跳过滚动用的移动门控（skip=true）', prerendered.every(x => x[1] === true));

    // 其他调用点的默认语义不变：_prerender_page 的默认参数必须是 false
    const srcSig = /async _prerender_page\(page_index, skip_mount_gate = (\w+)\)/.exec(SRC);
    eq('_prerender_page 的默认 skip_mount_gate 为 false', srcSig?.[1], 'false');

    // 关闭后 rAF 回调必须自愈（渲染器关闭途中的悬空回调不得给新文档派发渲染）
    r.is_open = false;
    rafs.length = 0;
    prerendered.length = 0;
    r._prerender_for_navigation(5);
    if (typeof rafs[0] === 'function') rafs[0]();
    eq('阅读器已关闭时 rAF 回调不派发', prerendered.length, 0);
}

/* ══════════ 2. 幂等页盒写入不再置脏 ══════════ */
console.log('\n=== 2. _set_page_box_size：只在尺寸真变时置脏 ===');
{
    const R = loadClass(window, () => 0, () => 0);
    const r = new R();
    const aspect = 595 / 842;
    r._get_page_aspect = () => aspect;
    let invalidations = 0;
    r._invalidate_page_positions = () => { invalidations++; };

    const el = { style: { width: '1568px', height: String(Math.round(1568 / aspect)) + 'px' } };
    const img = { style: {} }, canvas = { style: {} }, tiles = { style: {} };
    const pd = { page_element: el, _img_el: img, pdf_canvas: canvas, _tiles_container: tiles };

    r._set_page_box_size(pd, 1568);
    eq('同尺寸写入不置脏', invalidations, 0);
    eq('同尺寸写入仍刷新 img 内联样式', img.style.width, '100%');
    eq('同尺寸写入仍刷新 canvas 内联样式', canvas.style.height, '100%');
    eq('同尺寸写入仍刷新 tiles 尺寸', tiles.style.width, '1568px');

    r._set_page_box_size(pd, 1600);
    eq('尺寸真变时置脏一次', invalidations, 1);
    r._set_page_box_size(pd, 1600);
    eq('再次同尺寸写入不重复置脏', invalidations, 1);

    // 高变化但宽不变（旋转/宽高比回填）也要置脏
    pd.page_element.style.height = '100px';
    r._set_page_box_size(pd, 1600);
    eq('仅高度变化也置脏', invalidations, 2);
}

console.log('');
console.log('==================== 汇总 ====================');
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (failures.length) console.log('  失败: ' + failures.join('; '));
if (fail) process.exitCode = 1;
