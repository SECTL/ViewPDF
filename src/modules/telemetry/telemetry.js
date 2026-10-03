/**
 * 遥测模块入口：心跳调度
 *
 * 为什么调度放在这里而不是各业务模块：在线数的判定窗口是「最近 5 分钟内有过心跳」
 * （online_count / peak_online / daily-metrics / region-distribution 共用这一个窗口）。
 * 只在启动时发一次的话，5 分钟后全部设备一律判为离线，控制台上的在线数、并发峰值、
 * 地区分布会一起塌成接近 0 —— 统计页面看着"没人用"，其实是没人发心跳。
 * 所以必须有周期心跳，且它属于「应用活着」这件事，只归这一个调度器管。
 */

import { reportOnline, reportVersion, telemetry_is_enabled } from './telemetry-api.js';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STARTUP_DELAY_MS } from './telemetry-config.js';

let _heartbeat_timer = null;   // 周期心跳
let _startup_timer = null;     // 启动后延迟的那一次
let _tick_inflight = false;    // 上一次心跳还没回来
let _starting = false;         // telemetryInit 正在 await 设置读取中

/**
 * 一次心跳。
 *
 * `_tick_inflight` 是必需的：请求超时上限 10 秒，比 5 分钟的间隔短，所以正常不会重叠；
 * 但限流 / DNS 抖动 / 用户在启动瞬间断网时一次 tick 可能拖很久，没有这道闸
 * setInterval 会把请求越堆越多，最终把「统计」变成「打爆自己的服务端」。
 */
async function telemetry_tick() {
    if (_tick_inflight) {
        console.log('[telemetry] previous heartbeat still in flight, skip this tick');
        return;
    }
    _tick_inflight = true;
    try {
        await reportOnline();
    } finally {
        // 必须在 finally 里清：reportOnline 内部已兜住异常，但调度器不能把
        // 「一次失败」变成「此后再也不会有心跳」——那正好复现我们要修的这个 bug。
        _tick_inflight = false;
    }
}

/**
 * 启动遥测：版本上报一次（每次启动）+ 心跳立即一次，随后每 5 分钟一次。
 *
 * 幂等：重复调用不会起第二个定时器。`_starting` 必须在第一个 await **之前**置位，
 * 否则两次并发调用都会看到 `_heartbeat_timer === null` 而双双通过判据。
 */
export async function telemetryInit() {
    if (_starting || _heartbeat_timer !== null) {
        console.log('[telemetry] already initialized');
        return;
    }
    _starting = true;
    try {
        if (!(await telemetry_is_enabled())) {
            console.log('[telemetry] disabled by user settings');
            return;
        }

        _startup_timer = setTimeout(() => {
            _startup_timer = null;
            // 版本只报这一次：它是「安装用了哪个版本」，不是「在线了多久」，
            // 放进心跳里会让 report_count 变成在线时长的代理指标，污染口径。
            reportVersion();
            telemetry_tick();
        }, HEARTBEAT_STARTUP_DELAY_MS);

        _heartbeat_timer = setInterval(telemetry_tick, HEARTBEAT_INTERVAL_MS);
        console.log(`[telemetry] started, heartbeat every ${HEARTBEAT_INTERVAL_MS / 1000}s`);
    } finally {
        _starting = false;
    }
}

/**
 * 停止遥测（用户关掉开关时调用）。清掉两个定时器：
 * 只清周期定时器的话，那次延迟中的启动上报仍会在开关关闭后发出去一条。
 */
export function telemetry_stop() {
    if (_heartbeat_timer !== null) {
        clearInterval(_heartbeat_timer);
        _heartbeat_timer = null;
    }
    if (_startup_timer !== null) {
        clearTimeout(_startup_timer);
        _startup_timer = null;
    }
    console.log('[telemetry] stopped');
}

/** 仅供验证脚本观察内部状态 */
export function telemetry_debug_state() {
    return {
        heartbeat_timer: _heartbeat_timer !== null,
        startup_timer: _startup_timer !== null,
        tick_inflight: _tick_inflight,
        starting: _starting
    };
}

export { reportOnline, reportVersion };
