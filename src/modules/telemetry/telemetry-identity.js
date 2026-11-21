/**
 * 设备身份管理：UUID 生成/读取、device_type 判定
 * UUID 由 Rust 后端持久化到 identity.json（%APPDATA%/SECTL/ViewPDF/identity.json），
 * 设备重置后保持不变。
 */

// 仅在内存里保留的会话级 id：不写 localStorage，避免和 Rust 持久化的
// identity.json 形成第二份长期标识。每个进程最多生成一次。
let inMemoryId = null;

/**
 * 读取或生成本机设备 UUID，由 Rust 后端持久化
 */
export async function getInstallUUID() {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) {
        // 不跑在应用壳里（直接开 index.html 调试）：没有权威持久化 ID，
        // 直接放弃上报 —— 与「没有后端就不上报」的既有语义一致。
        return null;
    }
    try {
        const uuid = await invoke('get_device_uuid');
        if (uuid) return uuid;
    } catch (e) {
        console.warn('[telemetry] failed to get device UUID from backend:', e);
    }
    // IPC 在但没能给出 ID：用内存里的会话 id 兜底，绝不写 localStorage
    // （Rust 的 identity.json 才是唯一持久副本）。
    try {
        if (!inMemoryId) inMemoryId = crypto.randomUUID();
        return inMemoryId;
    } catch (e) {
        console.warn('[telemetry] crypto.randomUUID unavailable, skip report');
        return null;
    }
}

/**
 * 根据权威平台信息返回 device_type 枚举值。
 *
 * 优先级：Tauri IPC（Rust 的 app_fetch_platform，编译期按 target_os 决定，最权威）
 *   > UA-CH 的 navigator.userAgentData.platform
 *   > navigator.platform（已废弃、可指纹识别，只在没有更好来源时兜底）
 * 只做「是否 Windows / Linux / Mac」的粗分类，不读取更细的设备特征。
 */
export async function getDeviceType() {
    let platform = null;
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
        try {
            platform = await invoke('app_fetch_platform');
        } catch (e) {
            // 旧版本宿主/测试桩可能没有这条命令；忽略，走下面的兜底
        }
    }
    if (!platform) {
        platform = navigator.userAgentData?.platform || navigator.platform || '';
    }
    const p = String(platform);
    if (/win/i.test(p)) return 'windows-desktop';
    if (/linux/i.test(p)) return 'linux-desktop';
    if (/mac/i.test(p)) return 'macos-desktop';
    return 'unknown-desktop';
}
