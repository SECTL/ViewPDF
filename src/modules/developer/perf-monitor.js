/**
 * ViewStage 右上角性能监视器
 * 显示实时 FPS、批绘制引擎状态等指标
 * 仅在开发者模式下通过开关启用
 *
 * 使用 setInterval 而非 requestAnimationFrame 以避免强制浏览器
 * 每帧走合成管线导致 GPU 无法空闲。
 */

let perf_timer_id = null;
let perf_container = null;
let perf_enabled = false;

let perf_fps_line = null;
let perf_batch_line = null;
let perf_tiles_line = null;

// 缓存上一次文本，值未变时跳过 textContent 写操作避免无效 paint
let perf_prev_line1 = '';
let perf_prev_line2 = '';
let perf_prev_line3 = '';

const PERF_UPDATE_MS_DEFAULT = 200;
let perf_interval_ms = PERF_UPDATE_MS_DEFAULT;

/** 重启定时器（用于动态切换更新频率） */
function perf_monitor_restart_timer() {
    if (perf_timer_id != null) {
        clearInterval(perf_timer_id);
        perf_timer_id = null;
    }
    if (perf_enabled) {
        perf_timer_id = setInterval(perf_monitor_refresh_display, perf_interval_ms);
    }
}

/** 创建监视器 DOM 并启动定时器 */
function perf_monitor_init(intervalMs) {
    if (perf_container) return;
    if (intervalMs > 0) perf_interval_ms = intervalMs;

    perf_container = document.createElement('div');
    perf_container.id = 'perf-monitor';
    perf_container.style.cssText = `
        position: fixed;
        top: 8px;
        right: 8px;
        z-index: 2147483647;
        background: rgba(0,0,0,0.7);
        color: #0f0;
        font-family: 'Consolas','Courier New',monospace;
        font-size: 12px;
        line-height: 1.5;
        padding: 6px 10px;
        border-radius: 6px;
        pointer-events: none;
        user-select: none;
        white-space: pre;
        contain: paint layout style;
    `;

    perf_fps_line = document.createElement('div');
    perf_batch_line = document.createElement('div');
    perf_tiles_line = document.createElement('div');
    perf_container.appendChild(perf_fps_line);
    perf_container.appendChild(perf_batch_line);
    perf_container.appendChild(perf_tiles_line);

    // 显式设置 display block，避免因模块级 perf_enabled=false 导致 display:none 写死
    perf_container.style.display = 'block';
    document.body.appendChild(perf_container);

    perf_enabled = true;
    perf_timer_id = setInterval(perf_monitor_refresh_display, perf_interval_ms);
}

/**
 * 计算渲染压力综合指标（0-100）
 * 权重：绘制耗时占比 50% + 待绘命令积压 25% + 掉帧率 25%
 *
 * 绘制耗时占比以当前帧时间（1000/currentFps）为基准，
 * 反映实际绘制开销占帧预算的比例，而非标记脏 tile 这类待办标记。
 */
function calc_render_pressure(batchStats, tileRenderer) {
    let value = 0;

    // 绘制耗时占比（0-50）：当前帧时间中平均绘制消耗了多少
    const avgDrawTime = batchStats?.avgDrawTime || 0;
    const fps = batchStats?.currentFps || 60;
    const frameTime = 1000 / fps;
    if (avgDrawTime > 0 && frameTime > 0) {
        const ratio = Math.min(1, avgDrawTime / frameTime);
        value += Math.round(ratio * 50);
    }

    // 待绘命令积压（0-25）：尚未 flush 的手势命令数
    const pending = batchStats?.pendingCount || 0;
    if (pending > 0) {
        value += Math.min(25, pending * 3);
    }

    // FPS 掉帧率（0-25）：自适应帧率引擎的实际降频程度
    if (batchStats?.targetFps > 0 && batchStats.currentFps < batchStats.targetFps) {
        const drop = 1 - batchStats.currentFps / batchStats.targetFps;
        value += Math.min(25, Math.round(drop * 25));
    }

    value = Math.min(100, value);

    let label;
    if (value <= 25) label = '低';
    else if (value <= 50) label = '中';
    else if (value <= 75) label = '高';
    else label = '严重';

    return { value, label };
}

/** 采集各模块 stats 并更新显示 */
function perf_monitor_refresh_display() {
    if (!perf_container) return;

    const s = window.batchDrawManager?.batch_draw_fetch_stats?.();
    const tileR = window.tileRenderer;
    const mem = typeof performance.memory !== 'undefined' ? performance.memory : null;

    // FPS 取自 batch_draw 引擎自报的 currentFps，不再用 RAF 空转计数
    const fpsValue = s?.currentFps ?? '-';

    // 渲染压力
    const pressure = calc_render_pressure(s, tileR);

    // 行 1：FPS + 渲染压力 + 实际 tile DPR（随缩放动态变化）
    // 从可见 tile 中读取 DPR，避免读到视口外 tile 的陈旧值或被 shrink 降回 1 的值
    let tileDpr = window.DRAW_CONFIG?.dpr ?? 1;
    if (tileR?.tileInfos) {
        const visibleKeys = tileR.get_visible_keys();
        for (const info of tileR.tileInfos) {
            if (visibleKeys.has(info.key)) {
                tileDpr = info.dpr;
                break;
            }
        }
    }
    const dprStr = tileDpr.toFixed(1);
    const line1 = `FPS ${fpsValue}  压力 ${pressure.label}(${pressure.value}%)  DPR ${dprStr}`;
    if (line1 !== perf_prev_line1) {
        perf_fps_line.textContent = line1;
        perf_prev_line1 = line1;
    }

    // 行 2：batch_draw 引擎指标
    let line2;
    if (s) {
        line2 = `批绘 ${s.currentFps}/${s.targetFps}  积压 ${s.pendingCount}  耗时 ${s.avgDrawTime.toFixed(1)}ms  模式 ${s.frameRateMode}`;
    } else {
        line2 = '批绘  --';
    }
    if (line2 !== perf_prev_line2) {
        perf_batch_line.textContent = line2;
        perf_prev_line2 = line2;
    }

    // 行 3：脏 tile + 堆内存
    const dirtyCount = tileR?.dirty?.size ?? '-';
    const totalTiles = tileR?.tileInfos?.length ?? '-';
    const heapStr = mem
        ? `${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB`
        : '--';
    const line3 = `分块 ${dirtyCount}/${totalTiles}  内存 ${heapStr}`;
    if (line3 !== perf_prev_line3) {
        perf_tiles_line.textContent = line3;
        perf_prev_line3 = line3;
    }
}

/**
 * 开关监视器
 * @param {boolean} enabled - true 显示，false 隐藏
 * @param {number} [intervalMs] - 可选，同时切换更新频率
 */
function perf_monitor_set_enabled(enabled, intervalMs) {
    perf_enabled = enabled;
    if (intervalMs > 0) perf_interval_ms = intervalMs;

    if (enabled) {
        if (!perf_container) {
            perf_monitor_init(perf_interval_ms);
        } else {
            perf_container.style.display = 'block';
            perf_monitor_restart_timer();
        }
    } else {
        if (perf_timer_id != null) {
            clearInterval(perf_timer_id);
            perf_timer_id = null;
        }
        if (perf_container) {
            perf_container.style.display = 'none';
        }
    }
}

/**
 * 动态修改更新频率（监视器开启时即时生效）
 * @param {number} intervalMs
 */
function perf_monitor_set_interval(intervalMs) {
    if (intervalMs < 50) intervalMs = 50; // 下限保护
    perf_interval_ms = intervalMs;
    perf_monitor_restart_timer();
}

export { perf_monitor_init, perf_monitor_set_enabled, perf_monitor_set_interval };
