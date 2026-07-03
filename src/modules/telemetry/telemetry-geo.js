/**
 * 地理位置获取与缓存（localStorage 缓存，30 天过期）
 */

import {
    STORAGE_KEY_GEO_CACHE,
    GEO_CACHE_TTL
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
 * 调用 ipapi.co 获取地理信息（通过 Tauri IPC 绕过 CORS）
 */
export async function fetchGeo() {
    try {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) {
            console.warn('[telemetry] Tauri IPC unavailable for geo fetch');
            return null;
        }

        const result = await invoke('telemetry_http_get', {
            url: 'https://ipapi.co/json/'
        });

        const data = JSON.parse(result);
        // 翻译地区名称为中文
        return translateGeo({
            ip: data.ip || null,
            country_name: data.country_name || null,
            region: data.region || null,
            city: data.city || null,
            district: data.district || null
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