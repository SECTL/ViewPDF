/**
 * HTTP 请求封装：reportOnline() / reportVersion()
 *
 * 两个上报接口都是公开端点（无需认证），都经 Rust 的 `telemetry_http_post` 发出，
 * 以绕开 WebView 的 CORS。域名白名单在 Rust 侧（appwrite.sectl.cn / freeipapi.com）。
 */

import {
    API_ENDPOINT_ONLINE,
    API_ENDPOINT_VERSION,
    VERSION_MAX_LENGTH
} from './telemetry-config.js';
import { SECTL_API_BASE, SECTL_CLIENT_ID } from '../sectl-client.js';
import { getInstallUUID, getDeviceType } from './telemetry-identity.js';
import { getGeo } from './telemetry-geo.js';

/**
 * 用户是否允许遥测。上报前统一走这里判断：
 * 开关必须收敛在唯一出口（此前只有 telemetryInit 判一次，而 reportOnline
 * 可被任何模块直调 —— 关了开关照样上报 UUID/IP/地理，形同虚形）。
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
 * 取 Tauri invoke 句柄。取不到就是没跑在应用壳里（直接开 index.html 调试），
 * 此时任何上报都发不出去，直接放弃而不是抛错刷屏。
 */
function telemetry_invoke() {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) {
        console.warn('[telemetry] Tauri IPC unavailable');
        return null;
    }
    return invoke;
}

/**
 * 公共 POST 出口。开关在这里再兜一道：
 * 上面的调用方（心跳调度）已经判过，但 `reportOnline` / `reportVersion` 都能被
 * 任何模块直接 import 调用，判据必须贴着真正的发包动作，否则等于没判。
 */
async function telemetry_post(endpoint, body) {
    if (!(await telemetry_is_enabled())) {
        console.log('[telemetry] disabled by user settings');
        return null;
    }
    const invoke = telemetry_invoke();
    if (!invoke) return null;

    const result = await invoke('telemetry_http_post', {
        url: `${SECTL_API_BASE}${endpoint}`,
        body: JSON.stringify(body)
    });
    return JSON.parse(result);
}

/**
 * 上报设备在线状态（心跳）。
 *
 * 服务端只按来源 IP 解析地区，客户端自报的四个地区字段仅在解析失败时兜底，
 * 且会被归一化 —— 所以这里允许缺省成「未知」，不要自己造地名。
 * `ip_address` 同理：私网地址服务端会忽略并改用请求头里的公网地址，
 * 传空串比传 `127.0.0.1` 诚实。
 */
export async function reportOnline() {
    try {
        const body = await buildOnlineBody();
        if (!body) return null;

        const parsed = await telemetry_post(API_ENDPOINT_ONLINE, body);
        if (parsed) {
            console.log(`[telemetry] online reported, count: ${parsed.online_count}`);
        }
        return parsed;
    } catch (e) {
        console.warn('[telemetry] online report error:', e);
        return null;
    }
}

async function buildOnlineBody() {
    const [installId, geo] = await Promise.all([getInstallUUID(), getGeo()]);
    if (!installId) return null;

    return {
        platform_id: SECTL_CLIENT_ID,
        device_uuid: installId,
        device_type: getDeviceType(),
        ip_address: geo?.ip || '',
        country: geo?.country_name || '未知',
        province: geo?.region || '未知',
        city: geo?.city || '未知',
        district: geo?.district || geo?.city || '未知'
    };
}

/**
 * 上报版本使用情况。
 *
 * 服务端按**软件安装**（device_uuid）去重：一个安装只计入它当前所处的版本，
 * 因此各版本软件数之和 = 平台去重后的安装总数。这与在线统计是两套口径 ——
 * 同一台机器关掉软件后仍计入版本统计，但不再计入在线。
 *
 * 每次启动报一次即可：接口是 upsert，重复上报只会累加 report_count，
 * 而版本分布这张表真正要看的是 version_devices。
 */
export async function reportVersion() {
    try {
        const invoke = telemetry_invoke();
        if (!invoke) return null;

        const [installId, rawVersion] = await Promise.all([
            getInstallUUID(),
            invoke('app_fetch_version')
        ]);
        if (!installId) return null;

        // 服务端限 1–64 字符；顺手剥掉可能存在的 v 前缀，让同一版本只有一个键
        const version = String(rawVersion || '').trim().replace(/^v/i, '').slice(0, VERSION_MAX_LENGTH);
        if (!version) {
            console.warn('[telemetry] empty version, skip version report');
            return null;
        }

        const parsed = await telemetry_post(API_ENDPOINT_VERSION, {
            platform_id: SECTL_CLIENT_ID,
            version,
            device_uuid: installId
        });
        if (parsed) {
            console.log(`[telemetry] version ${version} reported, devices on this version: ${parsed.version_devices}`);
        }
        return parsed;
    } catch (e) {
        console.warn('[telemetry] version report error:', e);
        return null;
    }
}
