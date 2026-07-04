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
 * 上报设备在线状态（通过 Tauri IPC 绕过 CORS）
 */
export async function reportOnline() {
    try {
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
