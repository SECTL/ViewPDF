/**
 * LoAF（Long Animation Frame）监视器 —— 长帧自动归因。
 *
 * 背景：真机出现 5s 级长帧（上色 ~2.9s），合成探针无法复现，
 * 需要 DevTools 之外的现场归因。LoAF API 自带逐脚本归因
 * （invoker / duration / 各阶段耗时），比 longtask 信息量大得多。
 *
 * ⚠️ 字段名铁律（勿改回）：
 *   LoAF 条目真实存在的只有 scriptDuration / blockingDuration /
 *   forcedStyleAndLayoutDuration / renderStart / styleAndLayoutStart。
 *   不存在 renderDuration / styleDuration / paintDuration / systemDuration
 *   ——读 undefined 全得 0，归因输出全是假象（2026-09-25 教训）。
 *   style/layout 与 paint 阶段须由时间戳推导：
 *     script  ≈ startTime → renderStart
 *     styleLayout = renderStart → styleAndLayoutStart
 *     paint   = styleAndLayoutStart → endTime
 *
 * ⚠️ WebView2 实测（2026-09-25 真机二轮）：可能出现 duration 很长但
 *   五相全 0、scripts 空、blocking=0 的条目——要么时间戳缺失（推导失效），
 *   要么时间在 LoAF 不覆盖的合成器/GPU 光栅。故本监视器会：
 *   1) 在 __loaf_reports 里保留原始时间戳（rs/sls/feet，相对 startTime）；
 *   2) 对第一条长帧 dump 完整原始条目（getter 不可枚举，须手工拷贝）；
 *   3) 时间戳缺失时在 warn 里显式标注「时间戳缺失」而非误导性的全 0。
 *
 * 行为：> LoAF_REPORT_MS 的长帧走 console.warn 输出归因（DevTools 可见），
 * 同时保留最近 8 条在 window.__loaf_reports 供排查脚本读取。
 * 频控：同窗口最多每 2s 报一条，避免连续长帧刷屏。
 *
 * 失败语义：纯观测，任何异常静默（不支持 LoAF 的环境直接 no-op）。
 */
(function () {
    'use strict';
    if (typeof PerformanceObserver === 'undefined') return;

    var REPORT_MS = 300;   // 超过此值的长帧才报告
    var MIN_INTERVAL = 2000;
    var MAX_KEEP = 8;
    var last_report_t = -Infinity;
    var raw_dumped = false;
    var reports = (window.__loaf_reports = []);

    function _ms(v) { return v ? Math.round(v) : 0; }

    // 性能条目属性是原型 getter，不可枚举，JSON.stringify 抓不到，须手工拷贝
    function _raw_json(e) {
        var keys = ['name', 'entryType', 'startTime', 'endTime', 'duration',
            'blockingDuration', 'scriptDuration', 'forcedStyleAndLayoutDuration',
            'renderStart', 'styleAndLayoutStart', 'firstUIEventTimestamp'];
        var o = {};
        for (var k = 0; k < keys.length; k++) {
            try { o[keys[k]] = e[keys[k]]; } catch (_) { o[keys[k]] = '<err>'; }
        }
        try { o.scripts = (e.scripts || []).map(function (s) {
            var sk = ['invoker', 'invokerType', 'sourceURL', 'sourceFunctionName',
                'sourceCharPosition', 'duration', 'startTime', 'forcedStyleAndLayoutDuration'];
            var so = {};
            for (var j = 0; j < sk.length; j++) { try { so[sk[j]] = s[sk[j]]; } catch (_) {} }
            return so;
        }); } catch (_) {}
        return JSON.stringify(o);
    }

    try {
        var obs = new PerformanceObserver(function (list) {
            var entries = list.getEntries();
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (!e || e.duration < REPORT_MS) continue;

                // 首条长帧 dump 原始条目 + GPU renderer：
                // 「五相全 0 ∧ blocking=0」时时间在合成器/GPU 侧，软件光栅
                // （SwiftShader/llvmpipe）是头号嫌疑，一次探明终身受益。
                if (!raw_dumped) {
                    raw_dumped = true;
                    try { console.log('[LoAF] 原始条目样本: ' + _raw_json(e)); } catch (_) {}
                    _probe_gpu();
                }

                var scripts = (e.scripts || []).map(function (s) {
                    return {
                        invoker: (s.invokerType || '?') + ':' + (s.invoker || '?'),
                        fn: s.sourceFunctionName || '',
                        url: (s.sourceURL || '').replace(/^.*[\\/]/, ''),
                        dur: _ms(s.duration),
                        start: _ms(s.startTime - e.startTime),
                    };
                }).sort(function (a, b) { return b.dur - a.dur; }).slice(0, 6);

                // 阶段由时间戳推导（API 无现成 style/paint duration 字段）
                var has_render_t = e.renderStart != null && e.renderStart > 0;
                var has_sls_t = e.styleAndLayoutStart != null && e.styleAndLayoutStart > 0;
                var script = _ms(e.scriptDuration);
                var style_layout = (has_render_t && has_sls_t)
                    ? _ms(e.styleAndLayoutStart - e.renderStart) : 0;
                var paint = (has_sls_t && e.endTime)
                    ? _ms(e.endTime - e.styleAndLayoutStart) : 0;
                var ts_missing = !has_render_t || !has_sls_t;

                var rec = {
                    at: _ms(e.startTime),
                    dur: _ms(e.duration),
                    blocking: _ms(e.blockingDuration),
                    script: script,
                    forced: _ms(e.forcedStyleAndLayoutDuration),
                    styleLayout: style_layout,
                    paint: paint,
                    rs: has_render_t ? _ms(e.renderStart - e.startTime) : null,
                    sls: has_sls_t ? _ms(e.styleAndLayoutStart - e.startTime) : null,
                    scripts: scripts,
                };
                reports.push(rec);
                if (reports.length > MAX_KEEP) reports.shift();

                var now = performance.now();
                if (now - last_report_t < MIN_INTERVAL) continue;
                last_report_t = now;

                var top = scripts.map(function (s) {
                    return s.dur + 'ms@' + s.invoker +
                        (s.fn ? '(' + s.fn + ')' : '') +
                        (s.url ? '@' + s.url : '');
                }).join(' | ');
                if (!top) top = '(无脚本归因 → 时间在合成器/GPU 或 GC)';
                var heap = _heap_now();
                // rAF 空洞与帧窗口重叠判定：重叠 = 帧饿真实；无重叠 = LoAF
                // duration 在 WebView2 上疑似测量伪影
                var raf_info = '';
                try {
                    raf_info = ' rAF空洞=' + (window.__raf_gap_count || 0);
                    for (var g = 0; g < gaps.length; g++) {
                        var g0 = gaps[g];
                        if (g0.at + g0.gap > e.startTime && g0.at < e.endTime) {
                            raf_info += ' ⚠重叠' + g0.gap + 'ms';
                            break;
                        }
                    }
                } catch (_) {}
                console.warn(
                    '[LoAF] 长帧 ' + rec.dur + 'ms' +
                    ' (script=' + rec.script +
                    ' styleLayout=' + rec.styleLayout +
                    ' paint=' + rec.paint +
                    ' blocking=' + rec.blocking +
                    (ts_missing ? ' ⚠时间戳缺失 rs=' + rec.rs + ' sls=' + rec.sls : '') + ')' +
                    (heap ? ' 堆' + heap : '') +
                    raf_info +
                    ' top: ' + top
                );
            }
        });
        obs.observe({ entryTypes: ['long-animation-frame'], buffered: true });

        // 判别器：longtask 并行观察。若 LoAF 报长帧期间 longtask 一条不发，
        // 说明主线程没有长任务在跑 → 瓶颈铁证在合成器/GPU（非 JS）。
        // 结果存 window.__longtasks（最近 8 条：at/dur）。
        try {
            var lt = (window.__longtasks = []);
            var obs2 = new PerformanceObserver(function (list) {
                var es = list.getEntries();
                for (var k = 0; k < es.length; k++) {
                    lt.push({ at: _ms(es[k].startTime), dur: _ms(es[k].duration) });
                }
                if (lt.length > MAX_KEEP) lt.splice(0, lt.length - MAX_KEEP);
            });
            obs2.observe({ entryTypes: ['longtask'], buffered: true });
        } catch (_) { /* longtask 不可用：静默 */ }

        // 终极判别器：rAF 实际帧间隔。若 LoAF 报「500ms 长帧」期间 rAF 仍以
        // 16ms 正常跑 → WebView2 的 LoAF duration 不可信（测量伪影，白追）；
        // 若 rAF 同步出现 >200ms 空洞 → 帧饿是真实现象（合成器/GPU 侧）。
        // 结果存 window.__frame_gaps（最近 8 条 {at, gap}），__raf_gap_count 累计。
        try {
            var gaps = (window.__frame_gaps = []);
            window.__raf_gap_count = 0;
            var last_raf = performance.now();
            function _raf_tick(t) {
                var now = performance.now();
                var gap = now - last_raf;
                last_raf = now;
                if (gap > 200) {
                    window.__raf_gap_count++;
                    gaps.push({ at: _ms(now), gap: Math.round(gap) });
                    if (gaps.length > MAX_KEEP) gaps.shift();
                    // 立即上控制台：帧饿自报（无需手动取 JSON）
                    try {
                        console.warn('[LoAF] 帧饿 ' + Math.round(gap) + 'ms (T' + _ms(now - gap) + ')');
                    } catch (_) {}
                }
                requestAnimationFrame(_raf_tick);
            }
            requestAnimationFrame(_raf_tick);
        } catch (_) { /* 静默 */ }
    } catch (_) { /* LoAF 不可用（旧 WebView）：静默降级为无观测 */ }

    /** GPU renderer 一次性探测（懒触发：首条长帧时才建 WebGL 上下文） */
    function _probe_gpu() {
        try {
            if (window.__gpu_info) return;
            var cv = document.createElement('canvas');
            var gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
            if (!gl) { window.__gpu_info = '(WebGL 不可用)'; return; }
            var dbg = gl.getExtension('WEBGL_debug_renderer_info');
            window.__gpu_info = String(dbg
                ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
                : gl.getParameter(gl.RENDERER));
            console.log('[LoAF] GPU renderer: ' + window.__gpu_info +
                (/(swiftshader|llvmpipe|software|basic)/i.test(window.__gpu_info)
                    ? '  ⚠ 疑似软件光栅！' : ''));
        } catch (_) { window.__gpu_info = '(探测失败)'; }
    }

    /**
     * JS 堆采样（Chromium 非 console.globals 的 performance.memory）。
     * 「无脚本 ∧ 无 mark ∧ blocking=0」长帧的最后嫌疑是 GC 停顿（原生时间，
     * LoAF 不归因）——堆接近 limit 或采样点间骤降（major GC 后回落）可判别。
     * 采样 1s 一次，窗口 __heap_log 留 60 条（{at, used, limit}，MB）。
     */
    function _heap_now() {
        try {
            var mem = performance.memory;
            if (!mem) return '';
            return Math.round(mem.usedJSHeapSize / 1048576) + '/' +
                Math.round(mem.jsHeapSizeLimit / 1048576) + 'MB';
        } catch (_) { return ''; }
    }
    try {
        if (performance.memory) {
            window.__heap_log = [];
            setInterval(function () {
                var mem = performance.memory;
                if (!mem) return;
                window.__heap_log.push({
                    at: _ms(performance.now()),
                    used: Math.round(mem.usedJSHeapSize / 1048576),
                    limit: Math.round(mem.jsHeapSizeLimit / 1048576),
                });
                if (window.__heap_log.length > 60) window.__heap_log.shift();
            }, 1000);
        }
    } catch (_) { /* 静默 */ }
})();
