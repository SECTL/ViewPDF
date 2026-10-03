/**
 * 地理位置获取与缓存（localStorage 缓存，30 天过期）
 */

import {
    STORAGE_KEY_GEO_CACHE,
    GEO_CACHE_TTL,
    GEO_API_URL
} from './telemetry-config.js';
import { translateGeo } from './telemetry-geo-translate.js';

/**
 * 从 localStorage 读取地理缓存，判定是否过期
 */
export function getGeoCache() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_GEO_CACHE);
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (!cached || !cached.fetched_at) return null;
        const age = Date.now() - cached.fetched_at;
        if (age >= GEO_CACHE_TTL) return null;
        // 翻译缓存中的地区名称为中文
        return translateGeo(cached);
    } catch (e) {
        console.warn('[telemetry] geo cache read failed:', e);
        return null;
    }
}

/**
 * 写入地理缓存到 localStorage
 */
export function saveGeoCache(geo) {
    try {
        const toSave = geo ? { ...geo, fetched_at: Date.now() } : null;
        if (toSave) {
            localStorage.setItem(STORAGE_KEY_GEO_CACHE, JSON.stringify(toSave));
        } else {
            localStorage.removeItem(STORAGE_KEY_GEO_CACHE);
        }
    } catch (e) {
        console.warn('[telemetry] geo cache save failed:', e);
    }
}

/**
 * freeipapi 把区名塞在市名的括号里：`"Jinrongjie (Xicheng District)"`。
 * 直接原样上报会让 city 与 district 变成同一个字符串 —— 结构上就是错的。
 * 这里拆开：括号前当 city，括号内当 district。
 *
 * 纯函数，无 IO —— 拆不出就退回原值（`district` 为空时由 translateGeo 用 city 兜底，
 * 与旧行为一致）。形状不对的输入不能抛：这是遥测路径，抛了就等于心跳失败。
 */
export function splitCityDistrict(cityName) {
    const raw = String(cityName || '').trim();
    if (!raw) return { city: null, district: null };
    const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(raw);
    if (!m) return { city: raw, district: null };
    const city = m[1].trim();
    const district = m[2].trim();
    // 括号里是噪声（如 "Jinrongjie (foo)"）时不要污染 district
    if (!city || !district) return { city: raw, district: null };
    return { city, district };
}

/**
 * 调用 freeipapi 获取地理信息（通过 Tauri IPC 绕过 CORS）
 *
 * 为什么换掉 ipapi.co（2026-10-03）：它现在对**所有**客户端返回 Cloudflare 挑战页
 * （`403 <title>Just a moment...</title>`），浏览器 UA、默认 UA、自定义 UA 全都一样 ——
 * 非浏览器客户端已经拿不到 JSON，这个兼底等于永久失效。
 * 候选里 ip-api.com 数据最全（含独立 district）但**免费套餐只支持 HTTP**，
 * 为了一个兼底去放宽 Rust 侧的 https 白名单不划算；ipinfo.io 的 country 是两字母代码，
 * 服务端归一化不一定认。freeipapi 走 HTTPS、无需 key、返回国/省/市名称。
 *
 * ⚠️ 这仍会把用户 IP 交给第三方。但地区统计的**权威来源是服务端按来源 IP 解析**
 * （见接口文档），这里只是服务端解析失败时的兼底；且已缓存 30 天。
 */
export async function fetchGeo() {
    try {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) {
            console.warn('[telemetry] Tauri IPC unavailable for geo fetch');
            return null;
        }

        const result = await invoke('telemetry_http_get', {
            url: GEO_API_URL
        });

        const data = JSON.parse(result);
        if (!data || typeof data !== 'object') return null;

        const { city, district } = splitCityDistrict(data.cityName);
        // 翻译地区名称为中文
        return translateGeo({
            ip: data.ipAddress || null,
            country_name: data.countryName || null,
            region: data.regionName || null,
            city,
            district
        });
    } catch (e) {
        console.warn('[telemetry] geo fetch failed:', e);
        return null;
    }
}

/**
 * 统一入口：先读缓存，过期/未命中则拉取
 */
export async function getGeo() {
    const cached = getGeoCache();
    if (cached) return cached;

    const geo = await fetchGeo();
    saveGeoCache(geo);
    return geo;
}