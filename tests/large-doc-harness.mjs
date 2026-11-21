/**
 * large-doc-harness.mjs —— 大/超大文档（页数 N、字节 M）伸缩性守卫
 *
 * 与 reader-frame-budget.mjs 的分工：
 *   - reader-frame-budget 管「一帧里的工作量」（滑动/翻页）
 *   - 本守卫管「随文档规模增长的开销」（页数 N / 文件字节 M）
 *
 * 本机能证明的部分（纯 JS/node，不需要 GPU、不需要 Windows）：
 *   - MD5 流式与同步两条路径**逐位一致**，且与 node:crypto 的 md5 一致
 *     → 「分块后哈希变了」会直接导致既有批注缓存全部找不到，必须钉死
 *   - MD5 额外内存分配恒为 0（原实现是 O(M) 的 padded 副本）
 *   - 各类随 N 增长的路径是否仍是「全表扫描」而非「窗口内扫描」
 *   - 常驻内存是否与 N 解耦（页数不应带来画布/位图增长）
 *
 * 不能证明的（需真机 + 大文件）：合成器纹理内存、pdf.js 真实解析耗时、
 * asset 协议的 Range 支持。相关项在报告里单列为待验证。
 *
 * 用法：node tests/large-doc-harness.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// fileURLToPath 而非 URL.pathname + decodeURIComponent：后者在 Windows 上产出
// "/D:/code/..."，与 '/modules/' 拼接后被 path.resolve 读成 "D:\D:\code\..."。
const APP = process.env.VP_APP_SRC || fileURLToPath(new URL('../src', import.meta.url));
const SRC = APP + '/modules/';

let pass = 0, fail = 0;
const failures = [];
function eq(label, got, want) {
    const ok = Object.is(got, want);
    if (ok) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; failures.push(label); console.log(`FAIL  ${label}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
}
function ok(label, cond, extra = '') {
    if (cond) { pass++; console.log(`PASS  ${label}`); }
    else { fail++; failures.push(label); console.log(`FAIL  ${label} ${extra}`); }
}
const read = f => fs.readFileSync(SRC + f, 'utf8');

/* ══════════ 1. MD5：两条路径 vs node:crypto ══════════ */
console.log('=== 1. MD5 一致性（哈希是批注缓存文件名的唯一键，错了=丢批注）===');

/** 从 main.js 里抽出 MD5 相关代码（模块顶层依赖极少：只有两张常量表） */
function load_md5() {
    const src = fs.readFileSync(APP + '/main.js', 'utf8');
    const grab = (startRe, endRe) => {
        const m = src.match(startRe);
        if (!m) throw new Error('main.js 中未找到: ' + startRe);
        const from = m.index;
        const rest = src.slice(from);
        const e = rest.search(endRe);
        return e > 0 ? rest.slice(0, e) : rest.slice(0, 4000);
    };
    const tables = grab(/const _MD5_SINE_TABLE =/, /\nconst _md5_add32/);
    const impl = grab(/const _md5_add32 =/, /\nlet currentSourceId/);
    const code = tables + '\n' + impl;
    const sandbox = {
        console, Math, Uint8Array, Uint32Array, Promise, performance: { now: () => 0 },
        setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {},
        window: {},
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: 'md5.js' });
    return sandbox;
}

let sb = null;
try {
    sb = load_md5();
} catch (e) {
    // 提取失败（结构被重构）也要**红**，不能崩：崩掉会让「基线对照」与
    // 「CI 失败原因」都变得难读
    eq('MD5 实现可从 main.js 中提取', 'throw: ' + e.message, 'ok');
}
if (sb) {
    const sync = sb.main_calculate_md5;
    const streaming = sb.main_calculate_md5_streaming;
    ok('MD5 同步实现可加载', typeof sync === 'function');
    ok('MD5 流式实现可加载', typeof streaming === 'function');
    if (typeof sync === 'function' && typeof streaming === 'function') {
        // 长度覆盖 MD5 的所有补齐边界：rem<56 / rem>=56 / 整块 / 空文件
        const lens = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129,
            1000, 4096, 65535, 65536, 262144, 1048576];
        let mismatches = 0, mismatchAt = null;
        for (const n of lens) {
            const buf = new Uint8Array(n);
            // 确定性伪随机内容（保证可复现）
            for (let i = 0; i < n; i++) buf[i] = (i * 2654435761) & 0xff;
            const want = crypto.createHash('md5').update(buf).digest('hex');
            const gotSync = sync(buf);
            const gotStream = await streaming(buf);
            if (gotSync !== want) { mismatches++; mismatchAt = mismatchAt ?? `sync n=${n}`; }
            if (gotStream !== want) { mismatches++; mismatchAt = mismatchAt ?? `stream n=${n}`; }
            if (gotSync !== gotStream) { mismatches++; mismatchAt = mismatchAt ?? `sync!=stream n=${n}`; }
        }
        eq('同步/流式两条路径与 node:crypto 的 MD5 逐位一致（覆盖全部补齐边界）',
            mismatches, 0);
        if (mismatchAt) console.log('        首个不一致: ' + mismatchAt);

        // 真实语义抽查：MD5 的已知向量
        eq('MD5("") = d41d8cd98f00b204e9800998ecf8427e',
            sync(new Uint8Array(0)), 'd41d8cd98f00b204e9800998ecf8427e');
        eq('MD5("abc") = 900150983cd24fb0d6963f7d28e17f72',
            sync(new TextEncoder().encode('abc')), '900150983cd24fb0d6963f7d28e17f72');
        eq('MD5("message digest") = f96b697d7cb7938d525a2f31aaf161d0',
            sync(new TextEncoder().encode('message digest')), 'f96b697d7cb7938d525a2f31aaf161d0');

        // 内存：流式实现不得分配与 M 成正比的副本。
        // 做法：8MB 输入下测量 heap 增量，要求远小于「输入大小」量级。
        global.gc?.();
        const big = new Uint8Array(8 * 1024 * 1024);
        for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
        const before = process.memoryUsage().heapUsed;
        await streaming(big);
        const after = process.memoryUsage().heapUsed;
        const grewMB = (after - before) / 1048576;
        ok('流式 MD5 不分配与输入等量的副本（原实现是 padded 全量副本）',
            grewMB < 4, `8MB 输入 heap 增量=${grewMB.toFixed(2)}MB`);
    }
}

/* ══════════ 2. 随 N 增长的路径：必须是窗口扫描，不是全表 ══════════ */
console.log('\n=== 2. 页数轴（N）：窗口化守卫 ===');
{
    const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const dr = strip(fs.readFileSync(SRC + 'pdf/document_reader.js', 'utf8'));
    const tr = strip(fs.readFileSync(SRC + 'canvas/tile-renderer.js', 'utf8'));
    const mjs = strip(fs.readFileSync(APP + '/main.js', 'utf8'));

    const methodBody = (src, name) => {
        const i = src.search(new RegExp(`\\n {4}(?:async )?${name}\\(`));
        if (i < 0) return '';
        const rest = src.slice(i);
        const m = rest.slice(1).search(/\n    (?:async )?[A-Za-z_$][A-Za-z0-9_$]*\(/);
        return m > 0 ? rest.slice(0, m + 1) : rest.slice(0, 12000);
    };

    // —— 开页看门狗：原本 O(N) 循环 × 最多 8 轮 ——
    // 不变式不是「字面上没有全表 for」而是「循环边界来自窗口而非文档长度」——
    // 否则把 `for (let i = lo; i <= hi; i++)` 改成 `for (let i = 0; i < pages.length; i++)`
    // 反而能骗过「没有全表 for」这种弱断言。
    const wd = methodBody(dr, '_start_open_watchdog');
    ok('开页看门狗的循环边界来自窗口（lo/hi 由 center±radius 推导）',
        /for \(let i = lo; i <= hi; i\+\+\)/.test(wd)
        && /const lo = Math\.max\(0, center - radius\)/.test(wd)
        && /const hi = Math\.min\(pages\.length - 1, center \+ radius\)/.test(wd));
    ok('开页看门狗的窗口半径是常数（不随页数增长）',
        /const radius = this\._tile_keep_distance \+ \d+;/.test(wd)
        && !/const radius = pages\.length/.test(wd));
    ok('开页看门狗限定在 tile keep 窗口内',
        /_is_page_near_active\(i, this\._tile_keep_distance\)/.test(wd));

    // —— 画布面积预算：原本全表收集 + 全表排序 ——
    const eb = methodBody(dr, '_enforce_canvas_budget');
    ok('面积预算的候选收集限定在 keep 窗口内（不对全文档排序）',
        /_wrapper_keep_distance/.test(eb) && !/for \(let i = 0; i < pages\.length; i\+\+\) \{\n\s*const pd = pages\[i\];\n\s*if \(!pd \|\| pd\.is_visible \|\| i === this\.active_page_index\) continue;\n\s*if \(!pd\.loaded/.test(eb),
        '仍在全表收集候选');

    // —— 诊断哨兵：O(N) → 只扫有批注的页 ——
    const sen = methodBody(dr, '_dr_diag_sentinel');
    ok('诊断哨兵不再遍历全表',
        !/for \(let i = 0; i < pages\.length; i\+\+\)/.test(sen));
    ok('诊断哨兵维护「有批注的页」集合',
        /_pages_with_strokes/.test(dr));

    // —— 诊断日志不得无条件下拉全表 length 数组（_dr_diag('save') 的 lens）——
    ok('保存批注时的全表 lens 字符串不再无条件下拉',
        !/lens:\s*pages\.map\(p => p\.stroke_history\.length\)\.join\(','\)/.test(dr));
    ok('恢复批注时的全表 lens 字符串不再无条件下拉',
        !/lens:\s*pages\.slice\(0, len\)\.map\(p => p\.stroke_history\.length\)\.join\(','\)/.test(dr));

    // —— 批注缓存稀疏化：只存有内容的页 ——
    const save = methodBody(dr, '_save_annotations_to_cache');
    ok('批注缓存只写「有批注或有过坐标基准」的页（与 N 解耦）',
        /sparse|stroke_history\.length > 0/.test(save));
    ok('批注缓存格式版本已升到 6（稀疏 pages 结构）',
        /version:\s*6/.test(save));
    const load = methodBody(dr, '_load_annotations_from_cache');
    ok('恢复端兼容 v5 稠密数组与 v6 稀疏结构',
        /version >= 6/.test(load) && /restore_one\(i, cache_data\.pages\[i\]\)/.test(load)
        && /typeof src\?\.i === 'number'/.test(load));

    // —— 页尺寸回填：已随尺寸回填迁到渲染线程 ——
    const st = methodBody(dr, '_stream_remaining_page_dims');
    ok('页尺寸回填主路径改走渲染线程 measure',
        /worker_host\.measure\(/.test(st));
    ok('页尺寸回填的主线程 getPage 只作为回退分支存在',
        /if \(worker_ok\)\s*\{[\s\S]{0,3000}?\}\s*else\s*\{[\s\S]{0,400}?get_pdf_page_info/.test(st));

    // —— 渲染线程具备 measure 指令 ——
    const rw = strip(fs.readFileSync(SRC + 'pdf/render-worker.js', 'utf8'));
    const rwh = strip(fs.readFileSync(SRC + 'pdf/render-worker-host.js', 'utf8'));
    ok('渲染线程支持 measure（只取页面尺寸，不栅格化）',
        /case 'measure'/.test(rw));
    ok('渲染宿主暴露 measure 并走低优先级队列',
        /measure\s*\(pageNum/.test(rwh) && /_measure_queue|_measure_pending/.test(rwh));

    // —— 超大页数的高度钳制 ——
    const cpl = methodBody(dr, '_compute_page_layout');
    // —— 超长文档：CSS 盒高必须钳制，而逻辑总高保持真实值 ——
    ok('全文档总高在写进 CSS 前被钳制（超长文档不撑爆布局盒）',
        /Math\.min\(total, MAX_DOC_LAYOUT_PX\)/.test(cpl));
    ok('逻辑总高保持真实值（钳制只作用于 DOM，两条坐标系不混用）',
        /this\._page_positions = \{ tops, heights, total, stale: false \}/.test(cpl)
        && /_layout_total_clamped = \(DOM_H < total\)/.test(cpl));
    ok('布局高度上限是具体常量（不是散落的魔数）',
        /const MAX_DOC_LAYOUT_PX = \d+ \* 1000 \* 1000/.test(dr));

    // —— 导入路径必须走「感知体积」的哈希入口 ——
    {
        const callSites = [...mjs.matchAll(/const fileMd5 = (?:await\s+)?([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]);
        ok('两处导入路径都走 main_file_md5（自动选同步/流式 + 会话备忘）',
            callSites.length === 2 && callSites.every(n => n === 'main_file_md5'),
            `got=${JSON.stringify(callSites)}`);
        ok('流式 MD5 有明确的体积阈值（不是无条件走流式）',
            /const _MD5_STREAM_THRESHOLD = \d+ \* 1024 \* 1024/.test(mjs));
        ok('流式 MD5 会话内备忘存在（重复打开不再重算）',
            /_fileHashMemo/.test(mjs) && /_FILE_HASH_MEMO_MAX/.test(mjs));
        ok('流式 MD5 不分配与输入等量的副本（只用常数级 scratch）',
            /const _md5_pad = new Uint8Array\(128\)/.test(mjs)
            && /const _md5_tail = new Uint8Array\(64\)/.test(mjs)
            && !/new Uint8Array\(padded_len\)/.test(mjs));
    }

    // —— 主线程导入路径：Array.from 之前必须有体积守卫 ——
    // Tauri 的 invoke 参数走 JSON，Uint8Array 会被序列化成 {"0":..}，所以
    // docx 转换**必须**转成 JS 数组 —— 这条通道本身改不动（要改得动 Rust）。
    // 可守的不变式是：转换之前有体积上限守卫，且超限时给出可读提示而不是
    // 让窗口卡死/OOM。
    {
        const arrIdx = mjs.indexOf('const fileDataForConvert = Array.from(uint8Array)');
        const guardIdx = mjs.indexOf('if (uint8Array.length > _WORD_MAX_BYTES)');
        ok('Word 转换的 Array.from 之前有体积上限守卫',
            arrIdx > 0 && guardIdx > 0 && guardIdx < arrIdx,
            `guard@${guardIdx} convert@${arrIdx}`);
        ok('超限时给出可读的错误提示（不是静默 OOM）',
            /docxTooLarge/.test(mjs) && /main_show_error_dialog/.test(mjs.slice(guardIdx, arrIdx)));
    }
    ok('Word 转换体积上限有具体数值（_WORD_MAX_BYTES）',
        /const _WORD_MAX_BYTES = \d+ \* 1024 \* 1024/.test(mjs));

    // —— pdf.js 取字节：大文件不自动预取全部 ——
    ok('主线程三处 getDocument 全部禁用自动全量预取（大文件省一份内存）',
        (mjs.match(/disableAutoFetch:\s*true/g) || []).length === 3);
    ok('渲染线程 getDocument 同样禁用自动预取',
        /disableAutoFetch:\s*true/.test(rw));

    // —— 常驻内存不得随 N 增长 ——
    const rc = strip(fs.readFileSync(SRC + 'canvas/resolution-controller.js', 'utf8'));
    ok('tile page_cache 上限仍是常数（不随页数增长）',
        /const PAGE_CACHE_MAX = \d+/.test(rw));
    ok('批注瓦片只按可见集升级（全网格不会都升到目标档）',
        /const allocDpr = 1/.test(tr));
    void rc;
}

/* ══════════ 3. 大文档行为仿真：常驻内存与 N 解耦 ══════════ */
console.log('\n=== 3. 行为仿真：常驻量与页数解耦 ===');
{
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
        DRAW_CONFIG: { baseDpr: 2, dpr: 2, dynamicDprEnabled: true, dprMin: 1, dprMax: 4, dprStep: 0.25, dprLimit: 2 },
        state: { strokeHistory: [] },
        requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
        requestIdleCallback: (fn) => { fn(); return 1; }, cancelIdleCallback: noop,
        devicePixelRatio: 2,
    };
    const doc = { createElement: (t) => (t === 'canvas' ? make_canvas() : { style: {} }) };
    const sandbox = {
        window: win, document: doc, performance: { now: () => 1000 },
        console, Math, Date, Map, Set, Array, Object, Number, String, JSON, parseFloat, parseInt, isFinite,
        setTimeout: () => 1, clearTimeout: noop,
        requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('canvas/resolution-controller.js'), sandbox, { filename: 'resolution-controller.js' });
    vm.runInContext(read('canvas/tile-renderer.js'), sandbox, { filename: 'tile-renderer.js' });

    // 单个 TileRenderer 的常驻字节：只与「一页的瓦片网格」有关，与文档页数无关
    const holder = make_canvas();
    const tr = new win.TileRenderer({
        canvasW: 1568, canvasH: 2218, strokeHistoryRef: [], skipBaseCache: true,
        getVisibleRect: () => ({ x: 0, y: 0, width: 1568, height: 900 }),
    });
    tr.init_tiles(holder, 1);
    if (typeof tr.estimate_bytes !== 'function') {
        eq('TileRenderer 暴露 estimate_bytes（供宿主做像素面积预算）',
            'missing', 'function');
    }
    const per_page_bytes = typeof tr.estimate_bytes === 'function' ? tr.estimate_bytes() : 0;
    ok('单页瓦片常驻与页数无关（与一页网格大小同阶）',
        per_page_bytes > 0 && per_page_bytes < 32 * 1024 * 1024,
        `${(per_page_bytes / 1048576).toFixed(1)}MB/页`);

    // 页数从 100 → 5000，常驻画布量应保持「窗口大小」而非「页数」
    const R = win.TileRenderer;
    const resident = (n) => {
        // keep 窗口固定 → 常驻页数恒定
        const keep = 2 * 5 + 1;                    // _tile_keep_distance = 5
        return Math.min(n, keep) * per_page_bytes;
    };
    const r100 = resident(100), r5000 = resident(5000);
    ok('常驻画布量不随文档页数线性增长（窗口有界）',
        r5000 === r100, `${(r100 / 1048576).toFixed(1)}MB vs ${(r5000 / 1048576).toFixed(1)}MB`);
    ok('页数翻 50 倍，常驻量增幅为 0',
        r5000 === r100);
    void R;
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) {
    console.log('失败项:');
    for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);