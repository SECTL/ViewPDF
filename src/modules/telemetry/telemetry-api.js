/**
 * HTTP 请求封装：reportOnline()
 */

import {
    API_BASE,
    PLATFORM_ID,
    API_ENDPOINT_ONLINE
} from './telemetry-config.js';
import { getInstallUUID, getDeviceType } from './telemetry-identity.js';
import { getGeo } from './telemetry-geo.js';

/**
 * 用户是否允许遥测。上报前统一走这里判断：
 * 开关必须收敛在唯一出口（此前只有 telemetryInit 判一次，而 reportOnline
 * 可被任何模块直调 —— 关了开关照样上报 UUID/IP/地理，形同虚设）。
 */
export async function telemetry_is_enabled() {
    try {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) return false;
        const result = await invoke('settings_fetch_all');
        return result?.settings?.telemetryEnabled !== false;
    } catch (e) {
        console.warn('[telemetry] failed to fetch settings, treat as disabled:', e);
        return false;
    }
}

/**
 * 上报设备在线状态（通过 Tauri IPC 绕过 CORS）
 */
export async function reportOnline() {
    try {
        if (!(await telemetry_is_enabled())) {
            console.log('[telemetry] disabled by user settings');
            return;
        }
        const installId = await getInstallUUID();
        const deviceType = getDeviceType();
        const geo = await getGeo();

        const body = {
            platform_id: PLATFORM_ID,
            device_uuid: installId,
            device_type: deviceType,
            ip_address: geo?.ip || '',
            country: geo?.country_name || '未知',
            province: geo?.region || '未知',
            city: geo?.city || '未知',
            district: geo?.district || geo?.city || '未知'
        };

        console.log('[telemetry] request body:', JSON.stringify(body, null, 2));

        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) {
            console.warn('[telemetry] Tauri IPC unavailable');
            return;
        }

        const result = await invoke('telemetry_http_post', {
            url: `${API_BASE}${API_ENDPOINT_ONLINE}`,
            body: JSON.stringify(body)
        });

        const parsed = JSON.parse(result);
        console.log(`[telemetry] online reported, count: ${parsed.online_count}`);
    } catch (e) {
        console.warn('[telemetry] online report error:', e);
    }
}
