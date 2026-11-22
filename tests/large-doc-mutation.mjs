// 变异测试：逐个破坏 large-doc 系列的守卫，确认每条真的会变红。
//
// 与 perf-tier-mutation.mjs 的关键区别：**绝不碰仓库源码**。
// 把整个 src/ 复制到 os.tmpdir() 的隔离副本，通过 VP_APP_SRC 让 harness 读副本，
// 只改写副本里的文件；每项测完在 finally 里还原副本，进程退出前删掉整个临时目录。
// 这样即使中途 Ctrl-C / 崩溃，仓库里的 src/ 也一根手指都不会被碰到。
//
// run() 同时认两种「被抓」形态：打印 FAIL 行、以及直接崩溃（无 FAIL 行的非零退出）。
// 全程用 execFileSync + timeout，不 new Promise —— 没有「永不 settle 导致 Node 静默退出 0」的风险。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const HARNESS = [
    'tests/large-doc-harness.mjs',
    'tests/large-doc-tile-upgrade.mjs',
];
const FILES = [
    'main.js',
    'modules/pdf/document_reader.js',
    'modules/pdf/render-worker.js',
    'modules/pdf/render-worker-host.js',
    'modules/canvas/tile-renderer.js',
];

// 仓库源码快照：结束时核对，确保「源码无改动」不是一句口头承诺。
const repoSnapshot = Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')]));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-doc-mut-'));
const tmpSrc = path.join(tmpDir, 'src');

function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, entry.name);
        const b = path.join(to, entry.name);
        if (entry.isDirectory()) copyDir(a, b);
        else fs.copyFileSync(a, b);
    }
}
copyDir(path.join(ROOT, 'src'), tmpSrc);

const tmpPath = (f) => path.join(tmpSrc, f);

/** 同时跑两个 harness；认 FAIL 行与崩溃两种形态 */
function run() {
    let out = '';
    const failed = [];
    const crashed = [];
    for (const script of HARNESS) {
        let code = 0;
        let buf = '';
        try {
            buf = execFileSync(process.execPath, [script], {
                cwd: ROOT,
                env: { ...process.env, VP_APP_SRC: tmpSrc },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                maxBuffer: 1 << 26,
                timeout: 120000,
            });
        } catch (e) {
            buf = String(e.stdout || '') + String(e.stderr || '');
            code = typeof e.status === 'number' ? e.status : 1;
        }
        out += buf + '\n';
        const clean = buf.replace(/\x1b\[[0-9;]*m/g, '');
        const lines = clean.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).map((l) => l.trim());
        failed.push(...lines);
        // 退出码非零但一行 FAIL 都没有 → 脚本自己炸了；这同样是守卫被触发的证据。
        if (code !== 0 && lines.length === 0) crashed.push(path.basename(script));
    }
    return { failed, crashed, out: out.replace(/\x1b\[[0-9;]*m/g, '') };
}

/*
 * 每项变异：
 *   label  说明
 *   file   相对 src/ 的路径
 *   anchor 唯一锚点（出现次数必须 == 1，否则 SKIP —— 防止源码已变/模式失效还假装守着）
 *   edits  若干 { from, to, count? }，count 默认 1；全局改名会显式声明真实次数
 *   expect 期望出现的 FAIL 行标签（正则）
 */
const MUTATIONS = [
    // ────────── 1. MD5 / 阈值 / 会话备忘 / Word 体积守卫 ──────────
    {
        label: 'MD5 流式阈值从 MB 常量改成十进制形式',
        file: 'main.js',
        anchor: 'const _MD5_STREAM_THRESHOLD = 4 * 1024 * 1024;',
        edits: [{ from: 'const _MD5_STREAM_THRESHOLD = 4 * 1024 * 1024;', to: 'const _MD5_STREAM_THRESHOLD = 4 * 1000 * 1000;' }],
        expect: /流式 MD5 有明确的体积阈值/,
    },
    {
        label: 'MD5 会话备忘被移除（重复打开重算整份字节）',
        file: 'main.js',
        anchor: 'const _fileHashMemo = new Map();   // filePath -> { size, md5 }',
        edits: [
            { from: '_fileHashMemo', to: '_memo', count: 6 },
            { from: '_FILE_HASH_MEMO_MAX', to: '_MEMO_MAX', count: 2 },
        ],
        expect: /流式 MD5 会话内备忘存在/,
    },
    {
        label: 'MD5 scratch 从 128B 改成 O(M) 全量补齐副本',
        file: 'main.js',
        anchor: 'const _md5_pad = new Uint8Array(128);   // 前 64B：单块补齐；后 64B：used>=56 时的第二块',
        edits: [{
            from: 'const _md5_pad = new Uint8Array(128);   // 前 64B：单块补齐；后 64B：used>=56 时的第二块',
            to: 'const padded_len = 32 * 1024 * 1024;\nconst _md5_pad = new Uint8Array(padded_len);',
        }],
        expect: /流式 MD5 不分配与输入等量的副本（只用常数级 scratch）/,
    },
    {
        label: '流式 MD5 每次调用都复制整份输入（O(M) 内存回归）',
        file: 'main.js',
        anchor: 'async function main_calculate_md5_streaming(bytes) {\n    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);',
        edits: [{
            from: 'async function main_calculate_md5_streaming(bytes) {\n    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);',
            // Uint8Array backing store 与长字符串都算 external memory，不动 heapUsed；
            // 只有稠密 JS 数组（new Array(n).fill(0)）真实落在 V8 堆上。挂在 sandbox 的
            // window 上保证到测量时不被回收，才能真正触发 harness 的 heap 增量断言。
            to: 'async function main_calculate_md5_streaming(bytes) {\n    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);\n    window.__md5Leak = new Array(bytes.length).fill(0);',
        }],
        expect: /流式 MD5 不分配与输入等量的副本（原实现是 padded 全量副本）/,
    },
    {
        label: '错误路径改用不感知体积的同步哈希入口',
        file: 'main.js',
        anchor: '        const fileMd5 = await main_file_md5(uint8Array, filePath);\n        // 与 PDF 路径一致：加载中去重，避免同一 Word 文件并发打开产生重复标签',
        edits: [{
            from: '        const fileMd5 = await main_file_md5(uint8Array, filePath);\n        // 与 PDF 路径一致：加载中去重，避免同一 Word 文件并发打开产生重复标签',
            to: '        const fileMd5 = main_calculate_md5(uint8Array);\n        // 与 PDF 路径一致：加载中去重，避免同一 Word 文件并发打开产生重复标签',
        }],
        expect: /两处导入路径都走 main_file_md5/,
    },
    {
        label: 'Word Array.from 前体积上限守卫被去掉',
        file: 'main.js',
        anchor: 'if (uint8Array.length > _WORD_MAX_BYTES) {',
        edits: [{ from: 'if (uint8Array.length > _WORD_MAX_BYTES) {', to: 'if (false) {' }],
        expect: /Word 转换的 Array.from 之前有体积上限守卫/,
    },
    {
        label: 'Word 超限不再给可读提示（静默失败）',
        file: 'main.js',
        anchor: "            main_show_error_dialog(\n                window.i18n?.format_translate('errors.convertFailed') || '转换失败',\n                window.i18n?.format_translate('errors.docxTooLargeDesc') || 'Word 文件超过 50MB，无法转换，请拆分后重试'\n            );",
        edits: [{
            from: "            main_show_error_dialog(\n                window.i18n?.format_translate('errors.convertFailed') || '转换失败',\n                window.i18n?.format_translate('errors.docxTooLargeDesc') || 'Word 文件超过 50MB，无法转换，请拆分后重试'\n            );",
            to: '            /* 超限静默失败 */ ;',
        }],
        expect: /超限时给出可读的错误提示/,
    },
    {
        label: '_WORD_MAX_BYTES 上限常量形式被破坏',
        file: 'main.js',
        anchor: 'const _WORD_MAX_BYTES = 50 * 1024 * 1024;',
        edits: [{ from: 'const _WORD_MAX_BYTES = 50 * 1024 * 1024;', to: 'const _WORD_MAX_BYTES = 50 * 1000 * 1000;' }],
        expect: /Word 转换体积上限有具体数值/,
    },

    // ────────── 2. 开页看门狗 ──────────
    {
        label: '开页看门狗循环边界改成全表 0..len',
        file: 'modules/pdf/document_reader.js',
        anchor: 'for (let i = lo; i <= hi; i++) {\n                const pd = pages[i];\n                if (!pd?.page_element || pd.stroke_history.length === 0) continue;',
        edits: [{
            from: 'for (let i = lo; i <= hi; i++) {\n                const pd = pages[i];\n                if (!pd?.page_element || pd.stroke_history.length === 0) continue;',
            to: 'for (let i = 0; i < pages.length; i++) {\n                const pd = pages[i];\n                if (!pd?.page_element || pd.stroke_history.length === 0) continue;',
        }],
        expect: /开页看门狗的循环边界来自窗口/,
    },
    {
        label: '开页看门狗半径改成随页数增长（pages.length）',
        file: 'modules/pdf/document_reader.js',
        anchor: 'const radius = this._tile_keep_distance + 8;',
        edits: [{ from: 'const radius = this._tile_keep_distance + 8;', to: 'const radius = pages.length;' }],
        expect: /开页看门狗的窗口半径是常数/,
    },
    {
        label: '开页看门狗 lo/hi 钳制被去掉',
        file: 'modules/pdf/document_reader.js',
        anchor: 'const lo = Math.max(0, center - radius);\n            const hi = Math.min(pages.length - 1, center + radius);',
        edits: [{
            from: 'const lo = Math.max(0, center - radius);\n            const hi = Math.min(pages.length - 1, center + radius);',
            to: 'const lo = center - radius;\n            const hi = center + radius;',
        }],
        expect: /开页看门狗的循环边界来自窗口/,
    },

    // ────────── 3. 画布面积预算 ──────────
    {
        label: '面积预算候选收集从 keep 窗口改成全表',
        file: 'modules/pdf/document_reader.js',
        anchor: 'const lo = Math.max(0, center - this._wrapper_keep_distance);\n        const hi = Math.min(pages.length - 1, center + this._wrapper_keep_distance);\n        const max_bytes = this._canvas_budget_bytes || 192 * 1024 * 1024;\n        let total = 0;\n        const candidates = [];\n        for (let i = lo; i <= hi; i++) {',
        edits: [{
            from: 'const lo = Math.max(0, center - this._wrapper_keep_distance);\n        const hi = Math.min(pages.length - 1, center + this._wrapper_keep_distance);\n        const max_bytes = this._canvas_budget_bytes || 192 * 1024 * 1024;\n        let total = 0;\n        const candidates = [];\n        for (let i = lo; i <= hi; i++) {',
            to: 'const lo = 0;\n        const hi = pages.length - 1;\n        const max_bytes = this._canvas_budget_bytes || 192 * 1024 * 1024;\n        let total = 0;\n        const candidates = [];\n        for (let i = lo; i <= hi; i++) {',
        }],
        expect: /面积预算的候选收集限定在 keep 窗口内/,
    },

    // ────────── 4. 诊断哨兵 ──────────
    {
        label: '诊断哨兵改回全表 for 遍历',
        file: 'modules/pdf/document_reader.js',
        anchor: 'const indices = this._pages_with_strokes\n            ? this._pages_with_strokes\n            : pages.map((_, i) => i);\n        for (const i of indices) {',
        edits: [{
            from: 'const indices = this._pages_with_strokes\n            ? this._pages_with_strokes\n            : pages.map((_, i) => i);\n        for (const i of indices) {',
            to: 'const indices = pages.map((_, i) => i);\n        for (let i = 0; i < pages.length; i++) {',
        }],
        expect: /诊断哨兵不再遍历全表/,
    },
    {
        label: '「有批注的页」集合被整体移除',
        file: 'modules/pdf/document_reader.js',
        anchor: 'const indices = this._pages_with_strokes\n            ? this._pages_with_strokes\n            : pages.map((_, i) => i);',
        edits: [{ from: '_pages_with_strokes', to: '_annotated_pages', count: 6 }],
        expect: /诊断哨兵维护「有批注的页」集合/,
    },

    // ────────── 5. 批注缓存 v6 稀疏化 ──────────
    {
        label: '批注缓存版本从 v6 退回 v5',
        file: 'modules/pdf/document_reader.js',
        anchor: '            version: 6,',
        edits: [{ from: '            version: 6,', to: '            version: 5,' }],
        expect: /批注缓存格式版本已升到 6/,
    },
    {
        label: 'v5→v6 的 src.i 兼容分支被去掉',
        file: 'modules/pdf/document_reader.js',
        anchor: "                const page_index = typeof src?.i === 'number' ? src.i : i;",
        edits: [{ from: "                const page_index = typeof src?.i === 'number' ? src.i : i;", to: '                const page_index = i;' }],
        expect: /恢复端兼容 v5 稠密数组与 v6 稀疏结构/,
    },
    {
        label: '稀疏写条件改成无条件写（全表 N 份空对象）',
        file: 'modules/pdf/document_reader.js',
        anchor: "const has_strokes = include_strokes && p.stroke_history && p.stroke_history.length > 0;\n            const has_coord = typeof p.coord_width === 'number' && p.coord_width > 0;\n            if (!has_strokes && !has_coord) continue;",
        edits: [
            {
                from: "const has_strokes = include_strokes && p.stroke_history && p.stroke_history.length > 0;\n            const has_coord = typeof p.coord_width === 'number' && p.coord_width > 0;\n            if (!has_strokes && !has_coord) continue;",
                to: 'const has_strokes = true;\n            const has_coord = true;\n            if (false) continue;',
            },
            { from: 'sparse_pages', to: 'pages_out', count: 4 },
            { from: "'sparse:'", to: "'x:'", count: 2 },
        ],
        expect: /批注缓存只写「有批注或有过坐标基准」的页/,
    },
    {
        label: '保存批注时恢复全表 lens 字符串（O(N) 下拉）',
        file: 'modules/pdf/document_reader.js',
        anchor: "            lens: 'sparse:' + sparse_pages.length",
        edits: [{ from: "            lens: 'sparse:' + sparse_pages.length", to: "            lens: pages.map(p => p.stroke_history.length).join(',')" }],
        expect: /保存批注时的全表 lens 字符串不再无条件下拉/,
    },
    {
        label: '恢复批注时恢复全表 lens 字符串（O(N) 下拉）',
        file: 'modules/pdf/document_reader.js',
        anchor: "                lens: 'sparse:' + this._pages_with_strokes.size",
        edits: [{ from: "                lens: 'sparse:' + this._pages_with_strokes.size", to: "                lens: pages.slice(0, len).map(p => p.stroke_history.length).join(',')" }],
        expect: /恢复批注时的全表 lens 字符串不再无条件下拉/,
    },

    // ────────── 6. measure 指令 / 低优先级队列 ──────────
    {
        label: '渲染线程的 case measure 分支被删掉',
        file: 'modules/pdf/render-worker.js',
        anchor: "            case 'measure': {",
        edits: [{ from: "            case 'measure': {", to: "            case 'measure_disabled': {" }],
        expect: /渲染线程支持 measure/,
    },
    {
        label: '宿主 measure 改成直接派发（去掉低优先级队列）',
        file: 'modules/pdf/render-worker-host.js',
        anchor: 'if (this._inflight.size === 0 && this._queue.length === 0) {',
        edits: [
            { from: 'if (this._inflight.size === 0 && this._queue.length === 0) {', to: 'if (true) {' },
            { from: '_measure_queue', to: '_mq', count: 5 },
            { from: '_measure_pending', to: '_mp', count: 11 },
        ],
        expect: /渲染宿主暴露 measure 并走低优先级队列/,
    },
    {
        label: '尺寸回填主路径退回主线程 get_pdf_page_info',
        file: 'modules/pdf/document_reader.js',
        anchor: 'if (worker_ok) {\n                try {\n                    results = await Promise.all(\n                        Array.from({ length: end - s }, (_, k) => worker_host.measure(s + k + 1))\n                    );',
        edits: [{
            from: 'if (worker_ok) {\n                try {\n                    results = await Promise.all(\n                        Array.from({ length: end - s }, (_, k) => worker_host.measure(s + k + 1))\n                    );',
            to: 'if (false) {\n                try {\n                    results = await Promise.all(\n                        Array.from({ length: end - s }, (_, k) => worker_host.measure(s + k + 1))\n                    );',
        }],
        expect: /页尺寸回填的主线程 getPage 只作为回退分支存在/,
    },

    // ────────── 7. 文档高度钳制 ──────────
    {
        label: 'CSS 盒高钳制被去掉（超长文档撑爆布局盒）',
        file: 'modules/pdf/document_reader.js',
        anchor: 'const DOM_H = Math.min(total, MAX_DOC_LAYOUT_PX); // DOM 盒高：写 CSS 前钳制',
        edits: [{ from: 'const DOM_H = Math.min(total, MAX_DOC_LAYOUT_PX); // DOM 盒高：写 CSS 前钳制', to: 'const DOM_H = total; // DOM 盒高：钳制被移除' }],
        expect: /全文档总高在写进 CSS 前被钳制/,
    },
    {
        label: '布局高度上限常量形式被破坏（魔数化）',
        file: 'modules/pdf/document_reader.js',
        anchor: 'const MAX_DOC_LAYOUT_PX = 30 * 1000 * 1000;',
        edits: [{ from: 'const MAX_DOC_LAYOUT_PX = 30 * 1000 * 1000;', to: 'const MAX_DOC_LAYOUT_PX = 3 * 1000000;' }],
        expect: /布局高度上限是具体常量/,
    },
    {
        label: '逻辑总高被写成钳制值（两条坐标系混淆）',
        file: 'modules/pdf/document_reader.js',
        anchor: 'this._page_positions = { tops, heights, total, stale: false };',
        edits: [{ from: 'this._page_positions = { tops, heights, total, stale: false };', to: 'this._page_positions = { tops, heights, total: DOM_H, stale: false };' }],
        expect: /逻辑总高保持真实值/,
    },

    // ────────── 8. 禁用自动预取 ──────────
    {
        label: '主线程三处 getDocument 中删掉一处 disableAutoFetch',
        file: 'main.js',
        anchor: 'disableAutoFetch: true,\n                useSystemFonts: false,',
        edits: [{ from: 'disableAutoFetch: true,\n                useSystemFonts: false,', to: 'useSystemFonts: false,' }],
        expect: /主线程三处 getDocument 全部禁用自动全量预取/,
    },
    {
        label: '渲染线程 getDocument 的 disableAutoFetch 被去掉',
        file: 'modules/pdf/render-worker.js',
        anchor: 'disableAutoFetch: true,',
        edits: [{ from: 'disableAutoFetch: true,', to: 'disableAutoFetch: false,' }],
        expect: /渲染线程 getDocument 同样禁用自动预取/,
    },

    // ────────── 9. 批注瓦片 ──────────
    {
        label: 'allocDpr 从 1 改成目标档（全网格高 DPR）',
        file: 'modules/canvas/tile-renderer.js',
        anchor: 'const allocDpr = 1;',
        edits: [{ from: 'const allocDpr = 1;', to: 'const allocDpr = this._calc_target_dpr(this._lastScale || 1);' }],
        expect: /批注瓦片只按可见集升级/,
    },
    {
        label: '仅可见集升级改成全网格升级（去掉 visibleKeys 门）',
        file: 'modules/canvas/tile-renderer.js',
        anchor: 'if (targetDpr > allocDpr && visibleKeys.has(key)) {',
        edits: [{ from: 'if (targetDpr > allocDpr && visibleKeys.has(key)) {', to: 'if (targetDpr > allocDpr) {' }],
        expect: /只有 1 块瓦片升到目标档/,
    },

    // ────────── 10. 瓦片字节估算 ──────────
    {
        label: 'estimate_bytes() 被删掉（宿主无法做面积预算）',
        file: 'modules/canvas/tile-renderer.js',
        anchor: 'estimate_bytes() {',
        edits: [{ from: 'estimate_bytes() {', to: 'estimate_bytes_disabled() {' }],
        expect: /TileRenderer 暴露 estimate_bytes/,
    },
    {
        label: 'estimate_bytes() 返回常数 0（面积预算永远不触发）',
        file: 'modules/canvas/tile-renderer.js',
        anchor: 'for (const c of this._offscreen_pool) bytes += c.width * c.height * 4;\n        return bytes;',
        edits: [{
            from: 'for (const c of this._offscreen_pool) bytes += c.width * c.height * 4;\n        return bytes;',
            to: 'for (const c of this._offscreen_pool) bytes += c.width * c.height * 4;\n        return 0;',
        }],
        expect: /单页瓦片常驻与页数无关/,
    },
];

let bad = 0;
const uncaught = [];
let caughtCount = 0;
let skipped = 0;

try {
    const baseline = run();
    if (baseline.failed.length || baseline.crashed.length) {
        console.error('基线不是全绿，变异测试结果无意义：');
        console.error('  FAIL: ' + JSON.stringify(baseline.failed.slice(0, 5)));
        console.error('  CRASH: ' + JSON.stringify(baseline.crashed));
        process.exit(2);
    }
    console.log('基线全绿（' + HARNESS.length + ' 个 harness，0 FAIL / 0 CRASH）\n');

    for (const m of MUTATIONS) {
        const file = tmpPath(m.file);
        const orig = fs.readFileSync(file, 'utf8');
        const hits = orig.split(m.anchor).length - 1;
        if (hits !== 1) {
            skipped++;
            bad++;
            uncaught.push('[SKIP] ' + m.label + '（anchor×' + hits + '）');
            console.log('SKIP  ' + m.label + '  —— 锚点出现 ' + hits + ' 次');
            continue;
        }
        let mutated = orig;
        let anchorBad = false;
        for (const e of m.edits) {
            const n = mutated.split(e.from).length - 1;
            const want = e.count ?? 1;
            if (n !== want) {
                anchorBad = true;
                uncaught.push('[SKIP] ' + m.label + '（edit×' + n + '，期望 ' + want + '）');
                console.log('SKIP  ' + m.label + '  —— 补丁锚点出现 ' + n + ' 次，期望 ' + want);
                break;
            }
            mutated = mutated.split(e.from).join(e.to);
        }
        if (anchorBad) { skipped++; bad++; continue; }
        if (mutated === orig) {
            skipped++;
            bad++;
            uncaught.push('[SKIP] ' + m.label + '（空操作）');
            console.log('SKIP  ' + m.label + '  —— 空操作');
            continue;
        }

        let after;
        try {
            fs.writeFileSync(file, mutated, 'utf8');
            after = run();
        } finally {
            fs.writeFileSync(file, orig, 'utf8');
        }

        const newFails = after.failed.filter((f) => !baseline.failed.includes(f));
        const newCrashes = after.crashed.filter((s) => !baseline.crashed.includes(s));
        const caught = (newFails.length > 0 || newCrashes.length > 0) && m.expect.test(after.out);
        if (caught) {
            caughtCount++;
            const why = [
                newFails.length ? newFails.slice(0, 2).map((f) => f.split('   ')[0]).join(' | ') : '',
                newCrashes.length ? '崩溃: ' + newCrashes.join(',') : '',
            ].filter(Boolean).join(' / ');
            console.log('CAUGHT  ' + m.label + '\n        -> ' + why);
        } else {
            bad++;
            uncaught.push('[MISSED] ' + m.label);
            console.log('MISSED  ' + m.label
                + '\n        -> 期望 ' + m.expect
                + '；实际 FAIL=' + JSON.stringify(after.failed.slice(0, 3))
                + ' CRASH=' + JSON.stringify(after.crashed));
        }
    }
} finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 最后再核一次仓库源码：变异只发生在临时副本里，仓库必须一字未改。
let repoDirty = false;
for (const f of FILES) {
    if (fs.readFileSync(path.join(ROOT, 'src', f), 'utf8') !== repoSnapshot[f]) {
        console.log('### 仓库源码被改动: src/' + f);
        repoDirty = true;
    }
}

console.log('');
console.log('==== ' + caughtCount + ' caught, ' + (MUTATIONS.length - caughtCount - skipped) + ' missed, '
    + skipped + ' skip ====');
if (!bad && !repoDirty) {
    console.log('全部 ' + MUTATIONS.length + ' 个变异均被守卫捕获');
} else {
    console.log(bad + ' 个变异未被守卫捕获或未生效');
}
// UNCAUGHT 清单单独走 stdout 且用 ASCII 前缀：控制台按 UTF-8 解码中文标签会乱码。
if (uncaught.length) {
    console.log('');
    console.log('### UNCAUGHT ' + uncaught.length);
    uncaught.forEach((l, i) => console.log('### ' + (i + 1) + '. ' + l));
}
process.exit(bad || repoDirty ? 1 : 0);
