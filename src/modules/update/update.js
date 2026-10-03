/**
 * 更新模块 — 检查、下载、安装
 *
 * 数据源全部走 SECTL 分发接口（`api/software/latest-tag` + `api/software/distribution`），
 * **不再直连 GitHub**：既避开 GitHub 限流，也避开国内直连不通的老问题，
 * 并且下载优先走服务器镜像（stk），速度与统计口径都更好。
 * 纯逻辑（版本比较 / 选包 / 候选链）在 `update-resolve.js`，那里可被验证脚本真跑。
 */

import {
  resolve_update,
  channel_has_version,
  build_download_candidates,
  DISTRIBUTION_PROJECT_SLUG,
  DISTRIBUTION_REPO,
  CHANNEL_STABLE,
  CHANNEL_PRERELEASE,
} from './update-resolve.js';
// 身份常量直接取自单一事实来源，不经 update-resolve.js 转手
import { SECTL_API_BASE, SECTL_CLIENT_ID } from '../sectl-client.js';

let _unlistenProgress = null;

// ── 接口调用 ───────────────────────────────────────────────────────

/**
 * 走 Tauri IPC 发 GET（绕开 WebView 的 CORS）。
 * Rust 侧只放行 `appwrite.sectl.cn`，且**不把非 2xx 当错误** ——
 * 404 + JSON 体是「该通道没有版本」这一正常业务结果的表达方式，
 * 所以状态码必须原样带回前端判断。
 */
async function _api_get(path_and_query) {
  const { invoke } = window.__TAURI__.core;
  const raw = await invoke('update_http_get', { url: SECTL_API_BASE + path_and_query });
  const parsed = JSON.parse(raw);
  const status = parsed?.status ?? 0;
  let body = null;
  try {
    body = JSON.parse(parsed?.body || 'null');
  } catch (_) {
    body = null;
  }
  return { status, body };
}

/**
 * 拉软件包列表。
 *
 * 先按 Client ID 精确查（查询参数名叫 `platformId`，但值是 Client ID ——
 * 见 update-resolve.js 里的说明）；**返回 0 个项目时回退到全量 + 本地按 slug 筛**。
 *
 * 这个回退不是防御性冗余，是实测必需：把遥测的平台 ID 传进去，接口安静地返回
 * `{projects:[],versions:[],packages:[]}` + HTTP 200，不报错、不告警 ——
 * 症状就是「永远提示已是最新」。
 */
async function _fetch_distribution() {
  const by_id = await _api_get(`/api/software/distribution?platformId=${encodeURIComponent(SECTL_CLIENT_ID)}`);
  if (by_id.status === 200 && by_id.body?.projects?.length) return by_id.body;
  if (by_id.status !== 200) {
    console.warn('[update] distribution filtered query failed:', by_id.status, by_id.body);
  }

  console.warn('[update] distribution matched no project for the Client ID, falling back to unfiltered + slug match');
  const all = await _api_get('/api/software/distribution');
  if (all.status !== 200 || !Array.isArray(all.body?.projects)) return null;
  if (!all.body.projects.some(p => p?.slug === DISTRIBUTION_PROJECT_SLUG)) return null;

  // 全量响应里混着其它项目的数据，按项目过滤，否则会下到别人的安装包。
  // ⚠️ 本地过滤**不可省**：实测 ?projectSlug= 与 ?projectId= 服务端根本不生效
  // （照样返回全部 11 个项目），只有 platformId 这一个查询参数是真过滤。
  return {
    projects: all.body.projects.filter(p => p?.slug === DISTRIBUTION_PROJECT_SLUG),
    versions: (all.body.versions || []).filter(v => v?.project_slug === DISTRIBUTION_PROJECT_SLUG),
    packages: (all.body.packages || []).filter(p => p?.project_slug === DISTRIBUTION_PROJECT_SLUG),
  };
}

/**
 * 检查更新。
 *
 * @param opts.channel  'stable'（默认）| 'prerelease'
 * @param opts.platform 由 app_fetch_platform 提供
 * @param opts.arch     可选，用于在同平台多包时进一步收窄
 */
export async function checkForUpdate(opts = {}) {
  const { invoke } = window.__TAURI__.core;
  const channel = opts.channel === CHANNEL_PRERELEASE ? CHANNEL_PRERELEASE : CHANNEL_STABLE;
  const platform = opts.platform || (await invoke('app_fetch_platform'));

  const build = await invoke('app_fetch_build_info');

  const tag_url =
    `/api/software/latest-tag?repo=${encodeURIComponent(DISTRIBUTION_REPO)}&channel=${channel}`;
  const [tagRes, dist] = await Promise.all([_api_get(tag_url), _fetch_distribution()]);

  // 该通道没有任何版本（例如没发过领先的预发布版）——不是错误，别弹失败横幅
  if (!channel_has_version(tagRes.status, tagRes.body)) {
    return {
      has_update: false,
      channel_empty: true,
      channel,
      current_version: build.version,
      current_tag: build.tag,
      current_is_prerelease: build.prerelease,
      latest_version: '',
      latest_tag: '',
      release_notes: '',
      package: null,
      file_name: '',
      file_size: null,
      package_missing: false,
      prerelease_leading: !!tagRes.body?.prerelease_leading,
    };
  }

  if (!dist) throw new Error('获取软件分发信息失败');

  return resolve_update(tagRes.body, dist, build, { platform, arch: opts.arch || '', channel });
}

/**
 * 下载更新包。
 *
 * `result` 来自 `checkForUpdate()`。候选链按可信度排好（服务器镜像 → gh-proxy →
 * GitHub），Rust 侧逐个尝试。**先校验非空**：版本查到了但没匹配到本机的包时
 * `package` 为 null，早点抛错比让 Rust 收到空数组再报错好定位得多。
 */
export async function startDownload(result) {
  const { invoke } = window.__TAURI__.core;
  const pkg = result?.package;
  if (!pkg) throw new Error('没有可用于当前平台的更新包');

  const urls = build_download_candidates(pkg, result?.latest_tag);
  if (!urls.length) throw new Error('无法构造下载地址');

  console.log(`[update] downloading ${pkg.file_name} (${urls.length} candidate sources)`);
  return await invoke('update_download_file', {
    urls,
    fileName: pkg.file_name,
    versionTag: result?.latest_tag || '',
  });
}

export async function installDownload(filePath) {
  const { invoke } = window.__TAURI__.core;
  await invoke('update_install_release', { filePath });
}

export async function cancelDownload() {
  const { invoke } = window.__TAURI__.core;
  await invoke('update_download_cancel');
}

export async function onProgress(callback) {
  if (_unlistenProgress) _unlistenProgress();
  const { listen } = window.__TAURI__.event;
  _unlistenProgress = await listen('update-download-progress', (event) => {
    callback(event.payload);
  });
}

export function offProgress() {
  if (_unlistenProgress) {
    _unlistenProgress();
    _unlistenProgress = null;
  }
}
