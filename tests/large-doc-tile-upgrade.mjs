/**
 * large-doc-tile-upgrade.mjs —— 批注瓦片「全网格 1x 起步、仅可见集升级」的执行式守卫
 *
 * large-doc-harness.mjs 只用 `const allocDpr = 1` 这条静态正则证明了「起步档是 1x」，
 * 但没有断言「升级条件里必须有 visibleKeys.has(key)」—— 把可见集门删掉，
 * 全网格都在 resize_grid 时直接升到目标 DPR，静态守卫依然全绿，
 * 而 N 页 × 全网格 × 高 DPR 会直接把显存峰值乘以页数（正是本组优化的动机）。
 *
 * 本文件把真实的 tile-renderer.js 抠进 vm sandbox，用 mock canvas 执行
 * init_tiles → resize_grid → _recreate_tile，直接数每块瓦片的 dpr。
 *
 * 用法：node tests/large-doc-tile-upgrade.mjs
 *       VP_APP_SRC=<临时 src> node tests/large-doc-tile-upgrade.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const APP = process.env.VP_APP_SRC || fileURLToPath(new URL('../src', import.meta.url));
const read = (f) => fs.readFileSync(path.join(APP, f).replace(/\\/g, '/'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function eq(label, got, want) {
    if (Object.is(got, want)) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; failures.push(label); console.log(`FAIL  ${label}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}

const noop = () => {};
function make_canvas() {
    let _w = 300, _h = 150;
    const c = {
        className: '', style: {}, parentNode: null, dataset: {},
        getContext: () => ctx_stub, appendChild: noop, prepend: noop, removeChild: noop,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: _w, height: _h, right: _w, bottom: _h }),
        querySelector: () => null, querySelectorAll: () => [],
        setAttribute: noop, removeAttribute: noop, hasAttribute: () => false,
        remove: noop, closest: () => null, contains: () => false,
        addEventListener: noop, removeEventListener: noop,
    };
    Object.defineProperty(c, 'width', { get() { return _w; }, set(v) { _w = v | 0; } });
    Object.defineProperty(c, 'height', { get() { return _h; }, set(v) { _h = v | 0; } });
    return c;
}
const ctx_stub = {
    imageSmoothingEnabled: true, lineCap: '', lineJoin: '', globalCompositeOperation: '',
    strokeStyle: '', fillStyle: '', lineWidth: 1,
    save: noop, restore: noop, setTransform: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop, arc: noop,
    ellipse: noop, rect: noop, fill: noop, stroke: noop, clip: noop,
    drawImage: noop, clearRect: noop, fillRect: noop, translate: noop, rotate: noop, scale: noop,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
};

const win = {
    DRAW_CONFIG: { baseDpr: 2, dpr: 2, dynamicDprEnabled: true, dprMin: 1, dprMax: 4, dprStep: 0.25 },
    state: { strokeHistory: [] },
    // 目标档固定 2x，让「可见集升级」与「全网格升级」产生可观测差异
    ResolutionController: { calc_tile_dpr: () => 2 },
    requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    requestIdleCallback: (fn) => { fn(); return 1; }, cancelIdleCallback: noop,
    devicePixelRatio: 2,
};
const doc = { createElement: (t) => (t === 'canvas' ? make_canvas() : { style: {} }) };
const sandbox = {
    window: win, document: doc, performance: { now: () => 1000 },
    console, Math, Date, Map, Set, Array, Object, Number, String, JSON,
    parseFloat, parseInt, isFinite,
    setTimeout: () => 1, clearTimeout: noop,
    requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('modules/canvas/resolution-controller.js'), sandbox, { filename: 'resolution-controller.js' });
vm.runInContext(read('modules/canvas/tile-renderer.js'), sandbox, { filename: 'tile-renderer.js' });

// 2×2 网格（1024×1024 / TILE_SIZE 512），可见矩形只覆盖 '0_0' 一块。
const holder = make_canvas();
const tr = new win.TileRenderer({
    canvasW: 1024, canvasH: 1024, strokeHistoryRef: [], skipBaseCache: true,
    getVisibleRect: () => ({ x: 0, y: 0, width: 512, height: 512 }),
});
tr.init_tiles(holder, 1);

eq('网格为 2×2 共 4 块瓦片', tr.tileInfos.length, 4);
const upgraded = tr.tileInfos.filter((t) => t.dpr > 1);
eq('只有 1 块瓦片升到目标档（不是全网格）', upgraded.length, 1);
eq('升级的正是可见瓦片 0_0', upgraded[0] && upgraded[0].key, '0_0');
eq('其余 3 块保持 1x 起步', tr.tileInfos.filter((t) => t.dpr === 1).length, 3);

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) for (const f of failures) console.log('  - ' + f);
process.exit(fail ? 1 : 0);
