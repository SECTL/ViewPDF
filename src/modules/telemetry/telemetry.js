/**
 * 遥测模块入口
 */

import { reportOnline } from './telemetry-api.js';

/**
 * 初始化遥测模块，延迟 3 秒触发在线上报
 */
export async function telemetryInit() {
    // 检查遥测设置
    try {
        const { invoke } = window.__TAURI__.core;
        const result = await invoke('settings_fetch_all');
        const telemetryEnabled = result?.settings?.telemetryEnabled !== false;
        if (!telemetryEnabled) {
            console.log('[telemetry] disabled by user settings');
            return;
        }
    } catch (e) {
        console.warn('[telemetry] failed to fetch settings, proceed anyway:', e);
    }

    setTimeout(() => {
        reportOnline();
    }, 3000);
}

export { reportOnline };