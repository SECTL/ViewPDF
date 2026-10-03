/**
 * 更新解析 —— 纯函数，无 IO、无 Tauri 依赖
 *
 * 为什么全放在前端而不是 Rust：这里每一个函数都是「拿接口返回的 JSON 算出结论」，
 * 而结论错了不会抛异常、只会静默地给出错误答案（选错安装包 / 漏报更新 / 反复提示
 * 同一版本）。放在 Rust 里就只能靠人读代码 review；放这里是纯函数，
 * `.workbuddy/verify/update-resolve.mjs` 能逐条真跑断言 + 做变异测试。
 *
 * Rust 侧只留传输（`update_http_get` / `update_download_file`）与信任校验。
 */

// ── SECTL 分发接口常量 ──────────────────────────────────────────────
// ⚠️⚠️ 两个「ID」别搞混，这是本接口最大的坑（2026-10-03 实测）：
//
//   平台 ID  platform_9c8003bb30f77c70   ← 服务端规范 ID，只在响应里回显
//   Client ID 6a48ced10013cdd594f8       ← **所有接口都用这个**
//
// 分发接口的查询参数名叫 `platformId`，但它过滤的字段
// `software_projects.platform_id` 里存的是 **Client ID**。
// 把平台 ID 传进去，服务端返回 **HTTP 200 + 三个空数组**，
// 不报错、不告警 —— 症状就是「永远提示已是最新」。
// 实测：`clientId=` 这个参数名服务端不认（直接 500），
// `platform_id=`（下划线）可用，但拼错成 `platformId` 之外的名字就静默失效。
// 身份常量的完整说明与各接口接受情况见 `modules/sectl-client.js`。
//
// ⚠️ 另两个看着能用、实际**完全不生效**的参数（实测均返回全部 11 个项目）：
//   ?projectSlug=ViewPDF   → 不过滤
//   ?projectId=…           → 不过滤
// 别为了「可读性」换成它们 —— 那等于关掉过滤，然后靠本地 slug 匹配兜底。
// 身份常量（API base + Client ID）统一住在 `modules/sectl-client.js`，这里**不再 re-export**：
// 再导出一遍就等于给同一个值开出两条 import 路径，正是这次 ID 用错的根源。
// 需要它们的调用方自己从 `sectl-client.js` 引。
import { SECTL_API_BASE } from '../sectl-client.js';

export const DISTRIBUTION_PROJECT_SLUG = 'ViewPDF';
export const DISTRIBUTION_REPO = 'SECTL/ViewPDF';

export const CHANNEL_STABLE = 'stable';
export const CHANNEL_PRERELEASE = 'prerelease';

// ── 版本比较 ───────────────────────────────────────────────────────

/** 剥掉 tag 的 `v` / `V` 前缀 */
export function strip_tag_prefix(tag) {
  return String(tag || '').trim().replace(/^[vV]/, '');
}

/**
 * 解析语义化版本：`0.3.0` / `v0.3.0` / `0.3.0-Bata2` / `0.3.0-rc.1+build`
 * 返回 `{ core: [maj, min, pat], pre: ['Bata2'] }`，解析不出来返回 null。
 *
 * 旧 Rust 实现用 `parts[2].parse::<u32>()`，`"0-Bata2"` 直接解析失败 →
 * 整个比较返回 false → 预发布版**永远不会被提示**。
 */
export function parse_version(raw) {
  const s = strip_tag_prefix(raw);
  if (!s) return null;
  // build metadata（+ 之后）不参与优先级比较
  const without_build = s.split('+')[0];
  const dash = without_build.indexOf('-');
  const core_part = dash >= 0 ? without_build.slice(0, dash) : without_build;
  const pre_part = dash >= 0 ? without_build.slice(dash + 1) : '';

  const parts = core_part.split('.');
  if (parts.length < 3) return null;
  const nums = [];
  for (let i = 0; i < 3; i++) {
    if (!/^\d+$/.test(parts[i])) return null;
    nums.push(Number(parts[i]));
  }
  const pre = pre_part ? pre_part.split('.') : [];
  return { core: nums, pre };
}

export function is_prerelease(raw) {
  const v = parse_version(raw);
  return !!v && v.pre.length > 0;
}

/** 单个预发布标识符比较：纯数字按数值比，否则按 ASCII 串比；数字 < 非数字 */
function compare_pre_identifier(a, b) {
  const a_num = /^\d+$/.test(a);
  const b_num = /^\d+$/.test(b);
  if (a_num && b_num) return Number(a) - Number(b);
  if (a_num) return -1;
  if (b_num) return 1;
  return a < b ? -1 : (a > b ? 1 : 0);
}

/** 标准 semver 优先级：核心版本 → 预发布（无预发布 > 有预发布）→ 标识符逐段比 */
export function compare_versions(a, b) {
  const va = parse_version(a);
  const vb = parse_version(b);
  // 任一侧解析不出来：无法判断，视为「无更新」。宁可漏提示也不要误报。
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va.core[i] !== vb.core[i]) return va.core[i] < vb.core[i] ? -1 : 1;
  }
  if (va.pre.length === 0 && vb.pre.length === 0) return 0;
  // 1.0.0 > 1.0.0-rc1：正式版高于同核心版本的预发布
  if (va.pre.length === 0) return 1;
  if (vb.pre.length === 0) return -1;
  const n = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < n; i++) {
    if (i >= va.pre.length) return -1;   // 段数少者优先
    if (i >= vb.pre.length) return 1;
    const c = compare_pre_identifier(va.pre[i], vb.pre[i]);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

/** latest 是否比 current 新 */
export function is_newer(current, latest) {
  return compare_versions(latest, current) > 0;
}

// ── 平台 / 包选择 ───────────────────────────────────────────────────

/** Rust `app_fetch_platform` 的取值 → 分发接口 packages[].os 的取值 */
const OS_NAMES = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

/**
 * 每个平台的安装包扩展名优先级（越靠前越优先）。
 * 关键：Windows 下 `.exe` 与 `.msi` **同时存在且都是 Windows/x64**
 * （实测 `download?os=Windows&arch=x64` 会返回 409 ambiguous_package），
 * 所以必须显式排序，不能靠 `packages.find(p => p.file_name.endsWith('.exe'))`
 * 之类碰运气 —— 旧 `findAsset()` 就是靠 assets 顺序，今天拿到 .exe 纯属运气。
 */
const EXT_PRIORITY = {
  windows: ['.exe', '.msi'],
  linux: ['.appimage', '.deb'],
  macos: ['.dmg'],
};

function ext_of(file_name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(file_name || ''));
  return m ? '.' + m[1].toLowerCase() : '';
}

/**
 * 从 distribution 的 packages 里挑出当前平台该下的那个包。
 *
 * 打分规则（分高者胜，完全确定性，不用排序稳定性做隐含假设）：
 *  1. 版本 tag 必须完全一致
 *  2. `enabled === false` 直接排除
 *  3. os 匹配 +4 / 不匹配 -4（os 字段为空视为通用包，0 分）
 *  4. arch 匹配 +2 / 不匹配 -2（空视为通用，0 分）
 *  5. 扩展名在优先级列表里：名次越靠前分越高（不在列表里 -1）
 *  6. `primary_file === true` +1
 */
export function select_package(packages, tag, platform, arch) {
  const list = Array.isArray(packages) ? packages : [];
  const want_os = OS_NAMES[platform] || '';
  const want_arch = String(arch || '').toLowerCase();
  const ext_rank = EXT_PRIORITY[platform] || EXT_PRIORITY.windows;

  let best = null;
  let best_score = -Infinity;
  for (const p of list) {
    if (!p || p.version_tag !== tag) continue;
    if (p.enabled === false) continue;

    const ext = ext_of(p.file_name);
    const ext_idx = ext_rank.indexOf(ext);
    let score = 0;

    const p_os = String(p.os || '').toLowerCase();
    if (want_os && p_os) score += (p_os === want_os.toLowerCase()) ? 4 : -4;

    const p_arch = String(p.arch || '').toLowerCase();
    if (want_arch && p_arch) score += (p_arch === want_arch) ? 2 : -2;

    // 扩展名优先级：名次 0 拿最高分，列表内递减；不在列表里给负分
    score += ext_idx >= 0 ? (ext_rank.length - ext_idx) : -1;
    if (p.primary_file === true) score += 1;

    if (score > best_score) {
      best_score = score;
      best = p;
    }
  }
  if (!best) return null;
  // 接口里包 ID 叫 `$id`（Appwrite 文档 ID），下载接口的参数却叫 `packageId`。
  // 在这里归一一次，下游就只认 `package_id` —— 否则候选链会静默少掉「服务器镜像」
  // 那一条（读不到 package_id 就只生成 GitHub 两条），表现为镜像下载永远不被尝试。
  return { ...best, package_id: best.package_id ?? best.$id ?? null };
}

// ── 下载候选链 ─────────────────────────────────────────────────────

/**
 * 构造有序下载候选链：服务器镜像 → gh-proxy → GitHub 直连。
 *
 * 三条都指向同一个文件；Rust 侧逐个尝试直到成功。顺序即优先级。
 * 只有拿到 `package_id` 才能用分发接口（它是最精确的定位方式），
 * 没有 package_id 时只剩 GitHub 两条 —— 那种情况通常意味着服务端没镜像该版本。
 */
export function build_download_candidates(pkg, tag) {
  const out = [];
  if (!pkg) return out;

  if (pkg.package_id) {
    out.push(`${SECTL_API_BASE}/api/software/download?packageId=${encodeURIComponent(pkg.package_id)}&source=server`);
  }

  const file = pkg.file_name || '';
  const tag_ = tag || pkg.version_tag || '';
  if (file && tag_) {
    const gh = `https://github.com/${DISTRIBUTION_REPO}/releases/download/${encodeURIComponent(tag_)}/${encodeURIComponent(file)}`;
    out.push(`https://gh-proxy.com/${gh}`);
    out.push(gh);
  }
  return out;
}

// ── 更新结论 ───────────────────────────────────────────────────────

/**
 * 把两个接口的响应合成一个更新结论。
 *
 * @param latestTag   GET /api/software/latest-tag 的响应体
 * @param dist        GET /api/software/distribution 的响应体
 * @param build       app_fetch_build_info 的返回
 * @param opts        { platform, arch, channel }
 */
export function resolve_update(latestTag, dist, build, opts) {
  const platform = opts?.platform || 'windows';
  const arch = opts?.arch || '';
  const channel = opts?.channel || CHANNEL_STABLE;

  const latest = channel === CHANNEL_PRERELEASE
    ? (latestTag?.latest_prerelease || latestTag?.latest)
    : latestTag?.latest;
  const tag = latest?.tag || latestTag?.tag || '';

  const versions = Array.isArray(dist?.versions) ? dist.versions : [];
  const packages = Array.isArray(dist?.packages) ? dist.packages : [];

  const latest_semver = strip_tag_prefix(tag);
  const current_semver = build?.semver || strip_tag_prefix(build?.tag || build?.version || '');

  const version_row = versions.find(v => strip_tag_prefix(v?.tag) === latest_semver);
  const pkg = select_package(packages, tag, platform, arch);

  const has_update = !!tag && is_newer(current_semver, latest_semver);

  // 「已是最新」时展示当前版本的说明。取不到就留空 —— 不能拿最新版的说明冒充。
  const current_row = versions.find(v => strip_tag_prefix(v?.tag) === current_semver);

  return {
    has_update,
    channel,
    current_version: build?.version || '',
    current_tag: build?.tag || '',
    current_is_prerelease: !!build?.prerelease,
    latest_version: latest_semver,
    latest_tag: tag,
    latest_is_prerelease: !!latest?.prerelease || is_prerelease(latest_semver),
    prerelease_leading: !!latestTag?.prerelease_leading,
    release_notes: has_update ? (version_row?.changelog || '') : (current_row?.changelog || ''),
    package: pkg,
    file_name: pkg?.file_name || '',
    file_size: pkg?.size ?? null,
    // 版本查到了但没有匹配本机的包 —— 这是「有新版但下不了」，必须能被 UI 区分开
    package_missing: has_update && !pkg,
  };
}

/**
 * 该通道当前是否可用。
 *
 * `latest-tag?channel=prerelease` 在没有领先预发布版时返回 **404 + JSON 体**，
 * 这是**正常业务结果**而不是故障（ViewPDF 目前就是如此：v0.3.0 正式版比
 * v0.3.0-Bata2 新，旧预发布不对外暴露）。所以非 2xx 一律按「该通道没版本」
 * 处理 —— 前端据此安静收场，不弹失败横幅。
 */
export function channel_has_version(status, body) {
  if (status < 200 || status >= 300) return false;
  return !!body?.latest;
}
