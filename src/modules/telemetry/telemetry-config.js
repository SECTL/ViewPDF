/**
 * 遥测模块常量配置
 *
 * ⚠️ 这里**不再**定义平台 ID。SECTL 的身份标识统一住在 `modules/sectl-client.js`
 * （`SECTL_CLIENT_ID`）。此前本文件持有一份「平台 ID」，而 `/api/stats/online`
 * 要的是 Client ID，于是每次心跳都回 `400 invalid_client / Platform not found`；
 * 又因为 `/api/stats/version` 两种 ID 都收，版本上报一路绿灯，把故障掩盖了。
 */

export const STORAGE_KEY_INSTALL_ID = 'viewstage_install_id';
export const STORAGE_KEY_GEO_CACHE = 'viewstage_geo_cache';

export const GEO_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天
export const REQUEST_TIMEOUT = 10000; // 10 秒
export const GEO_REQUEST_TIMEOUT = 5000; // 5 秒

/**
 * IP 归属地查询服务。域名必须同步登记进 Rust 的 TELEMETRY_ALLOWED_HOSTS。
 * 换供应商时两处一起改，dpr-harness 有守卫盯着。
 */
export const GEO_API_URL = 'https://freeipapi.com/api/json';

export const API_ENDPOINT_ONLINE = '/api/stats/online';
export const API_ENDPOINT_VERSION = '/api/stats/version';

/**
 * 心跳周期。服务端按「最近 5 分钟内有过心跳」判定在线（online_count / peak_online
 * / daily-metrics / region-distribution 全部用这一个窗口）。
 *
 * **定 4 分钟而不是文档建议的 5 分钟**：周期一旦等于窗口，零余量。setInterval 必然
 * 带漂移，再叠上请求 RTT，相邻两次上报的**实际**间隔就是 300s + ε > 窗口，
 * 每个周期末尾设备都会被判成离线一小段 —— 折算成在线时长是系统性偏低，
 * 并发峰值（取窗口内设备数的最大值）也跟着塌。所以留 20% 余量：
 * 4 分钟 × 1.2 = 288s < 300s。要调小可以，**不要调到 ≥ 5 分钟**。
 *
 * 量级参考：每天 900 次请求，服务端限流阀是 120 次/分钟（按 IP+method+path），
 * 单机平均 0.6 次/分钟，余量极大。
 */
export const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;

/**
 * 启动后延迟多久发第一次。给 pdf.js 与首屏让路，避免和冷启动抢网络/主线程。
 */
export const HEARTBEAT_STARTUP_DELAY_MS = 3000;

/**
 * 服务端对 version 字段的长度约束（1–64 字符）。本地先夹住，
 * 免得把非法值发出去换回一个 400。
 */
export const VERSION_MAX_LENGTH = 64;