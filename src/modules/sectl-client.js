/**
 * SECTL 服务身份 —— 全应用**唯一**一处
 *
 * 为什么单独抽一个模块：SECTL 有两个长得很像、用途完全不同的 ID。此前它们分别
 * 住在 `telemetry-config.js`（平台 ID）和 `update-resolve.js`（Client ID），
 * 两边各自以为是对的，结果 `/api/stats/online` 一直报
 * `400 invalid_client / Platform not found` —— 而 `/api/stats/version`
 * 因为两种 ID 都收，看起来一切正常，把问题掩盖了很久。
 *
 * 身份标识只有一个：**Client ID**。
 *
 *   平台 ID    platform_9c8003bb30f77c70   ← 服务端内部的规范 ID，只在响应里回显
 *   Client ID  6a48ced10013cdd594f8       ← **客户端一律发这个**
 *
 * 实测（2026-10-03）各接口接受情况：
 *
 * | 接口                        | 平台 ID            | Client ID                     |
 * |-----------------------------|--------------------|-------------------------------|
 * | `POST /api/stats/online`    | ❌ 400 Platform not found | ✅ 200                  |
 * | `POST /api/stats/version`   | ⚠️ 201（照收，但存成规范 ID） | ✅ 200（自动归一到规范 ID） |
 * | `GET  /api/software/distribution?platformId=` | ❌ 200 + 空数组 | ✅ 200 + 正常数据 |
 *
 * 也就是说 **`/api/stats/version` 是唯一两个都收的接口** —— 它会静默接受错的 ID，
 * 于是「版本上报成功」根本不能证明 `online` 的 ID 是对的。别拿它当探针。
 */

export const SECTL_API_BASE = 'https://appwrite.sectl.cn';

/** 客户端对外一律使用这个 ID */
export const SECTL_CLIENT_ID = '6a48ced10013cdd594f8';
