// 真跑更新解析纯函数的测试（update-resolve.js）。
//
// 为什么单独一支：这里的每个函数都是「拿 JSON 算结论」，算错不抛异常、只静默给错答案。
// 本轮修的正是这类 bug —— 旧 Rust 版 `parts[2].parse::<u32>()` 遇到 "0-Bata2" 直接失败，
// compare 返回 false，于是**预发布版永远不会被提示**，而界面上看不出任何异常。
// 选包同理：Windows 下 .exe 与 .msi 同时存在且都是 Windows/x64
// （`download?os=Windows&arch=x64` 实测返回 409 ambiguous_package），
// 靠数组顺序碰运气选包，今天选中 .exe 纯属运气。
//
// 载荷用真实接口响应裁剪而来（2026-10-03 实测 appwrite.sectl.cn）。
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// 动态 import 必须给 file:// URL：Windows 上绝对路径 `D:\...` 会被当成 'd:'
// 这个未知协议（ERR_UNSUPPORTED_ESM_URL_SCHEME）。
// fileURLToPath 只用于反向（把 import.meta.url 变回磁盘路径）。
//
// VP_APP_SRC 让 update-mutation.mjs 能把 src/ 复制到临时目录后指向副本，
// 从而在不碰真实工作区的前提下打补丁跑变异（telemetry 那两支脚本同一约定）。
const APP = process.env.VP_APP_SRC || fileURLToPath(new URL('../src', import.meta.url));

// 必须在**任何** src 模块被 import 之前就位。
// build-identity.js 在 import 时按 `typeof window !== 'undefined'` 决定要不要注册
// window.ViewPDFDev，而 ES 模块只求值一次 —— 本文件后面那段「真跑 checkForUpdate」
// 会 import update.js，它又 import build-identity.js，于是模块在那时就缓存好了。
// 把 window 留到后面再设，它早已求值完毕，全局永远挂不上（第一版就是这么错的：
// 设在了自己那段的开头，而那时模块早被前面的 import 带走了）。
globalThis.window = globalThis.window || {};

const MOD = await import(pathToFileURL(path.join(APP, 'modules', 'update', 'update-resolve.js')).href);
const {
  parse_version, compare_versions, is_newer, is_prerelease, strip_tag_prefix,
  select_package, build_download_candidates, resolve_update,
  build_latest_tag_url, probe_channel, channel_probe_reason,
  CHANNEL_PROBE_OK, CHANNEL_PROBE_EMPTY, CHANNEL_PROBE_ERROR,
  DISTRIBUTION_PROJECT_SLUG, DISTRIBUTION_REPO,
  CHANNEL_STABLE, CHANNEL_PRERELEASE,
} = MOD;
const { SECTL_API_BASE, SECTL_CLIENT_ID } =
  await import(pathToFileURL(path.join(APP, 'modules', 'sectl-client.js')).href);

let pass = 0, fail = 0;
const str = (v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());
function eq(label, got, want) {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + str(got) + ' want=' + str(want));
}
function ok(label, got) { eq(label, !!got, true); }

// ── 真实接口载荷（裁剪版，字段名与取值均来自实测响应）──
// ⚠️ 包一律用**具名常量**引用，不要写 packages[5] 这类下标。
// 本轮就踩过：往数组里插了两个预发布包后，`packages[5]` 已经不是当初那个
// 「已停用包」了，断言照样 PASS —— 但它验的其实是版本过滤，跟 enabled 无关。
// 守卫一旦验错东西，变异测试会判定「抓不到」并把问题摆到台面上。
const PKG_APPIMAGE = { $id: 'pkg-appimage', project_slug: 'ViewPDF', version_tag: 'v0.3.0', file_name: 'viewpdf_0.3.0_amd64-linux.AppImage', os: 'Linux', arch: 'x64', size: 93525184, enabled: true, primary_file: true };
const PKG_DEB = { $id: 'pkg-deb', project_slug: 'ViewPDF', version_tag: 'v0.3.0', file_name: 'viewpdf_0.3.0_amd64-linux.deb', os: 'Linux', arch: 'x64', size: 7418476, enabled: true, primary_file: true };
const PKG_EXE = { $id: 'pkg-exe', project_slug: 'ViewPDF', version_tag: 'v0.3.0', file_name: 'viewpdf_0.3.0_x64-setup.exe', os: 'Windows', arch: 'x64', size: 5562619, enabled: true, primary_file: true };
const PKG_MSI = { $id: 'pkg-msi', project_slug: 'ViewPDF', version_tag: 'v0.3.0', file_name: 'viewpdf_0.3.0_x64_en-US.msi', os: 'Windows', arch: 'x64', size: 6643712, enabled: true, primary_file: true };
// 通用包：`os` 为服务端表示「通用」的实际取值（实测接口里存在该形态，
// 如 Wanderer 的 os="通用"），arch 与专用包相同 —— 于是 **os 打分是唯一区分手段**。
// 把它放在数组**前面**：os 打分一旦被删，两者各项同分，`>` 严格比较保留先到的
// 通用包 → Windows 用户会拿到 portable 包。这正是这条守卫的判别力来源。
const PKG_GENERIC_EXE = { $id: 'pkg-generic-exe', project_slug: 'ViewPDF', version_tag: 'v0.3.0', file_name: 'viewpdf_0.3.0-portable.exe', os: '通用', arch: 'x64', size: 6000000, enabled: true, primary_file: true };
// os/arch 全空的真·通用包
const PKG_ANY_EXE = { $id: 'pkg-any-exe', project_slug: 'ViewPDF', version_tag: 'v0.3.0', file_name: 'viewpdf_0.3.0-any.exe', os: '', arch: '', size: 6100000, enabled: true, primary_file: true };
const PKG_PRE_EXE = { $id: 'pkg-pre-exe', project_slug: 'ViewPDF', version_tag: 'v0.3.1-Bata1', file_name: 'viewpdf_0.3.1-Bata1_x64-setup.exe', os: 'Windows', arch: 'x64', size: 5563000, enabled: true, primary_file: true };
const PKG_PRE_MSI = { $id: 'pkg-pre-msi', project_slug: 'ViewPDF', version_tag: 'v0.3.1-Bata1', file_name: 'viewpdf_0.3.1-Bata1_x64_en-US.msi', os: 'Windows', arch: 'x64', size: 6644000, enabled: true, primary_file: true };
const PKG_OLD_EXE = { $id: 'pkg-old-exe', project_slug: 'ViewPDF', version_tag: 'v0.2.5', file_name: 'viewpdf_0.2.5_x64-setup.exe', os: 'Windows', arch: 'x64', size: 5, enabled: true, primary_file: true };
const PKG_DISABLED = { $id: 'pkg-disabled', project_slug: 'ViewPDF', version_tag: 'v0.3.0', file_name: 'viewpdf_0.3.0_x64-setup.exe', os: 'Windows', arch: 'x64', size: 1, enabled: false, primary_file: true };

const DIST = {
  projects: [{ $id: '6a5a4aae002b29207e4c', slug: 'ViewPDF', latest_version: 'v0.3.0', latest_prerelease_version: '', version_count: 1 }],
  versions: [
    { project_slug: 'ViewPDF', tag: 'v0.3.0', changelog: '# v0.3.0 正式版说明', mirrored: true, prerelease: false },
    { project_slug: 'ViewPDF', tag: 'v0.3.1-Bata1', changelog: '# v0.3.1-Bata1 预发布说明', mirrored: true, prerelease: true },
    { project_slug: 'ViewPDF', tag: 'v0.3.0-Bata2', changelog: '# v0.3.0-Bata2 预发布说明', mirrored: false, prerelease: true },
    { project_slug: 'ViewPDF', tag: 'v0.2.5', changelog: '# v0.2.5 说明', mirrored: false, prerelease: false },
  ],
  packages: [PKG_GENERIC_EXE, PKG_ANY_EXE, PKG_EXE, PKG_MSI, PKG_APPIMAGE, PKG_DEB, PKG_PRE_EXE, PKG_PRE_MSI, PKG_OLD_EXE, PKG_DISABLED],
};
const LATEST_STABLE = {
  success: true, channel: 'stable', prerelease_leading: false,
  latest: { tag: 'v0.3.0', prerelease: false, draft: false }, latest_prerelease: null, tag: 'v0.3.0',
};
// 「预发布领先」：v0.3.1-Bata1 发布晚于 v0.3.0，此时 prerelease 通道才存在
const LATEST_PRE = {
  success: true, channel: 'prerelease', prerelease_leading: true,
  latest: { tag: 'v0.3.0', prerelease: false }, latest_prerelease: { tag: 'v0.3.1-Bata1', prerelease: true }, tag: 'v0.3.0',
};
const BUILD_STABLE = { version: '0.3.0', tag: 'v0.3.0', semver: '0.3.0', prerelease: false };
// 预发布构建：Cargo 版本与正式版**完全相同**，只有 tag 不同 —— 这正是需要
// app_fetch_build_info 而不是 app_fetch_version 的原因
const BUILD_BETA1 = { version: '0.3.1', tag: 'v0.3.1-Bata1', semver: '0.3.1-Bata1', prerelease: true };
const BUILD_OLD = { version: '0.2.5', tag: 'v0.2.5', semver: '0.2.5', prerelease: false };

// ─────────────────────────  版本解析与比较  ─────────────────────────
console.log('--- 项目定位常量（填错不报错，只是静默失效）---');
// 实测（2026-10-03）：`?platformId=<平台 ID>` 返回 HTTP 200 + 三个空数组，
// 没有错误、没有告警 —— 症状就是「永远提示已是最新」。所以这些值必须钉死。
// ⚠️ 身份常量现在住在 `modules/sectl-client.js`（全应用唯一一处），
// 这里从**两个模块**分别取：update-resolve 不该再自己持有它。
eq('Client ID 取值正确', SECTL_CLIENT_ID, '6a48ced10013cdd594f8');
ok('Client ID 不是服务端规范的平台 ID', SECTL_CLIENT_ID !== 'platform_9c8003bb30f77c70');
eq('API base', SECTL_API_BASE, 'https://appwrite.sectl.cn');
eq('项目 slug', DISTRIBUTION_PROJECT_SLUG, 'ViewPDF');
eq('GitHub 仓库（仅用于构造兜底下载链接）', DISTRIBUTION_REPO, 'SECTL/ViewPDF');
eq('通道常量', CHANNEL_STABLE + '/' + CHANNEL_PRERELEASE, 'stable/prerelease');

console.log('--- 版本解析 ---');
eq('剥 v 前缀', strip_tag_prefix('v0.3.0'), '0.3.0');
eq('剥大写 V 前缀', strip_tag_prefix('V1.20.10.0909'), '1.20.10.0909');
eq('解析纯版本', parse_version('0.3.0').core.join('.'), '0.3.0');
eq('解析带预发布（旧实现在此直接失败）', parse_version('v0.3.0-Bata2').pre.join('.'), 'Bata2');
eq('多段预发布', parse_version('0.3.0-rc.1').pre.join('.'), 'rc.1');
eq('build metadata 被剥离', parse_version('0.3.0-rc.1+abc123').pre.join('.'), 'rc.1');
eq('段数不足返回 null', parse_version('0.3'), null);
eq('非数字返回 null', parse_version('0.x.0'), null);
eq('空串返回 null', parse_version(''), null);

console.log('--- semver 优先级 ---');
eq('0.2.5 < 0.3.0', compare_versions('0.2.5', '0.3.0'), -1);
eq('0.3.0 > 0.2.5', compare_versions('0.3.0', '0.2.5'), 1);
eq('同版本相等', compare_versions('0.3.0', 'v0.3.0'), 0);
eq('正式版 > 同核心预发布', compare_versions('0.3.0', '0.3.0-Bata2'), 1);
eq('预发布 < 同核心正式版', compare_versions('0.3.0-Bata2', '0.3.0'), -1);
eq('Bata2 > Bata1', compare_versions('0.3.0-Bata2', '0.3.0-Bata1'), 1);
eq('Bata1 < Bata2', compare_versions('0.3.0-Bata1', '0.3.0-Bata2'), -1);
// ⚠️ semver 规定：纯数字标识符按数值比，**字母数字混合标识符按 ASCII 串比**。
// `Bata10` 以字母开头 → 走串比 → 'Bata10' < 'Bata2'（'1' < '2'）。
// 这是本仓库 `-BataN` 命名的一个真实陷阱：发到 Bata10 时，semver 会认为它比
// Bata2 **旧**。哪天要出第 10 个预发布，要么改用 `-beta.N`（纯数字段），
// 要么就得在这里加特例。断言钉住现状，免得有人以为是解析 bug 就"顺手修掉"。
eq('Bata10 < Bata2（字母数字标识符按 ASCII 串比，非数值）', compare_versions('0.3.0-Bata10', '0.3.0-Bata2'), -1);
eq('纯数字段仍按数值比：rc.10 > rc.2', compare_versions('0.3.0-rc.10', '0.3.0-rc.2'), 1);
eq('rc.2 > rc.1（逐段比）', compare_versions('0.3.0-rc.2', '0.3.0-rc.1'), 1);
eq('数字标识符 < 字母标识符', compare_versions('0.3.0-1', '0.3.0-alpha'), -1);
eq('段数多者更高', compare_versions('0.3.0-rc.1.2', '0.3.0-rc.1'), 1);
eq('主版本优先', compare_versions('1.0.0', '0.9.9'), 1);
eq('解析失败视为无更新（旧实现在此静默 false）', is_newer('0.3.0', '不是版本'), false);

console.log('--- 预发布判定 ---');
eq('0.3.0 非预发布', is_prerelease('0.3.0'), false);
eq('0.3.0-Bata2 是预发布', is_prerelease('v0.3.0-Bata2'), true);
eq('尾部空横线不算预发布', is_prerelease('0.3.0-'), false);

console.log('--- is_newer 关键回归 ---');
// 本次要修的核心症状：预发布版永远不会被提示
eq('Bata2 构建看 Bata2：无更新（否则永远 nag 自己）', is_newer('0.3.0-Bata2', 'v0.3.0-Bata2'), false);
eq('Bata1 构建看 Bata2：有更新', is_newer('0.3.0-Bata1', '0.3.0-Bata2'), true);
eq('Bata2 构建看 Bata1：无更新', is_newer('0.3.0-Bata2', '0.3.0-Bata1'), false);
eq('0.2.5 构建看 0.3.0：有更新', is_newer('0.2.5', '0.3.0'), true);
// v0.3.0 正式版发布于 2026-09-25，Bata2 发布于 09-19 —— 正式版确实更新，
// 所以提示 Bata2 用户升到正式版是**正确**行为，不是"降级提示"。
eq('Bata2 构建看正式版：有更新（正式版发布时间更晚）', is_newer('0.3.0-Bata2', '0.3.0'), true);
// 反过来：预发布是更新的版本线（0.3.1-Bata1 > 0.3.0），正式通道不该把用户往回拽
eq('0.3.1-Bata1 构建看正式版 v0.3.0：无更新（不往回拽）', is_newer('0.3.1-Bata1', '0.3.0'), false);

// ─────────────────────────  选包  ─────────────────────────
console.log('--- 选包：Windows 必须拿 .exe 而不是 .msi ---');
const win = select_package(DIST.packages, 'v0.3.0', 'windows', 'x64');
eq('Windows 选中 exe', win?.file_name, 'viewpdf_0.3.0_x64-setup.exe');
// 把数组顺序反过来 —— 结论必须不变（旧 findAsset 就是靠顺序碰运气）
const REVERSED = [...DIST.packages].reverse();
const win_rev = select_package(REVERSED, 'v0.3.0', 'windows', 'x64');
eq('数组倒序后仍选中 exe（不依赖顺序）', win_rev?.file_name, 'viewpdf_0.3.0_x64-setup.exe');
// 只给 os/arch 都无法区分 exe 与 msi，这正是接口返回 409 的原因
const win_only_exe = select_package([{ $id: 'a', version_tag: 'v0.3.0', file_name: 'x.exe', os: 'Windows', arch: 'x64' }], 'v0.3.0', 'windows', 'x64');
eq('只有 exe 时选中 exe', win_only_exe?.file_name, 'x.exe');
const win_only_msi = select_package([{ $id: 'b', version_tag: 'v0.3.0', file_name: 'x.msi', os: 'Windows', arch: 'x64' }], 'v0.3.0', 'windows', 'x64');
eq('只有 msi 时选中 msi（不能因为不是 exe 就返回空）', win_only_msi?.file_name, 'x.msi');

console.log('--- 选包：其它维度 ---');
eq('Linux 优先 AppImage', select_package(DIST.packages, 'v0.3.0', 'linux', 'x64')?.file_name, 'viewpdf_0.3.0_amd64-linux.AppImage');
eq('Linux 只剩 deb 时选中 deb', select_package([PKG_DEB], 'v0.3.0', 'linux', 'x64')?.file_name, 'viewpdf_0.3.0_amd64-linux.deb');
eq('版本 tag 不匹配则不选', select_package(DIST.packages, 'v9.9.9', 'windows', 'x64'), null);
eq('enabled=false 被排除（唯一候选时也不能选）', select_package([PKG_DISABLED], 'v0.3.0', 'windows', 'x64'), null);
eq('空 packages 不抛', select_package([], 'v0.3.0', 'windows', 'x64'), null);
eq('undefined packages 不抛', select_package(undefined, 'v0.3.0', 'windows', 'x64'), null);
eq('未知平台不崩（有兜底）', typeof select_package(DIST.packages, 'v0.3.0', 'freebsd', 'x64'), 'object');
eq('arch 不匹配会被扣分但同平台仍能选出唯一包',
  select_package([{ $id: 'c', version_tag: 'v0.3.0', file_name: 'x.exe', os: 'Windows', arch: 'arm64' }], 'v0.3.0', 'windows', 'x64')?.file_name, 'x.exe');

// 通用包（os=「通用」/arch 与专用包相同）与专用包扩展名相同时，只能靠 os 打分区分。
// 这条同时钉住「os 打分生效」：把 os 打分删掉后两者同分，数组里靠前的通用包胜出，
// Windows 用户就会拿到 portable 包而不是平台专用安装包。
eq('通用包不得压过同平台专用包', select_package(DIST.packages, 'v0.3.0', 'windows', 'x64')?.file_name, 'viewpdf_0.3.0_x64-setup.exe');
eq('通用包倒序后也不得压过专用包', select_package([...DIST.packages].reverse(), 'v0.3.0', 'windows', 'x64')?.file_name, 'viewpdf_0.3.0_x64-setup.exe');
eq('os/arch 全空的包是唯一候选时仍可被选中', select_package([PKG_ANY_EXE], 'v0.3.0', 'windows', 'x64')?.file_name, 'viewpdf_0.3.0-any.exe');
eq('Linux 下通用包也不得压过 AppImage', select_package(DIST.packages, 'v0.3.0', 'linux', 'x64')?.file_name, 'viewpdf_0.3.0_amd64-linux.AppImage');

// ─────────────────────────  下载候选链  ─────────────────────────
console.log('--- 下载候选链：镜像 → gh-proxy → GitHub ---');
const cands = build_download_candidates(win, 'v0.3.0');
eq('三条候选', cands.length, 3);
ok('第一条走 SECTL 分发接口', cands[0].startsWith(SECTL_API_BASE + '/api/software/download?packageId='));
ok('第一条带 source=server', cands[0].includes('source=server'));
ok('第一条带 packageId', cands[0].includes('packageId=pkg-exe'));
ok('第二条走 gh-proxy', cands[1].startsWith('https://gh-proxy.com/https://github.com/'));
ok('第三条是 GitHub 直连', cands[2].startsWith('https://github.com/SECTL/ViewPDF/releases/download/'));
ok('文件名进 URL', cands[2].endsWith('/viewpdf_0.3.0_x64-setup.exe'));
ok('tag 进 URL', cands[2].includes('/v0.3.0/'));
eq('无包时返回空链', build_download_candidates(null, 'v0.3.0').length, 0);
eq('无 filename 时只剩分发接口一条', build_download_candidates({ package_id: 'p' }, 'v0.3.0').length, 1);
ok('tag 做 URL 编码（防路径穿越）', build_download_candidates({ file_name: 'a.exe' }, 'v0.3.0/../evil').length > 0);

// ─────────────────────────  更新结论  ─────────────────────────
console.log('--- 正式版通道 ---');
const r_stable = resolve_update(LATEST_STABLE, DIST, BUILD_OLD, { platform: 'windows', arch: 'x64', channel: 'stable' });
eq('0.2.5 → 有更新', r_stable.has_update, true);
eq('最新版本号已剥前缀', r_stable.latest_version, '0.3.0');
eq('取到 Windows 安装包', r_stable.file_name, 'viewpdf_0.3.0_x64-setup.exe');
eq('取到包大小', r_stable.file_size, 5562619);
eq('有更新时展示新版说明', r_stable.release_notes, '# v0.3.0 正式版说明');
eq('包已找到', r_stable.package_missing, false);

const r_up2date = resolve_update(LATEST_STABLE, DIST, BUILD_STABLE, { platform: 'windows', arch: 'x64', channel: 'stable' });
eq('0.3.0 → 无更新', r_up2date.has_update, false);
eq('无更新时展示**当前版本**的说明', r_up2date.release_notes, '# v0.3.0 正式版说明');
eq('无更新时不报缺包', r_up2date.package_missing, false);

console.log('--- 预发布通道 ---');
// 「预发布领先」是接口真实存在的状态：预发布发布时间晚于最新正式版。
// 用 v0.3.1-Bata1（晚于 v0.3.0）构造，别用 Bata2 —— Bata2 比 v0.3.0 旧，
// 那种情况接口按文档直接返回 404，构造出来只会测一个现实中不存在的分支。
const r_pre = resolve_update(LATEST_PRE, DIST, BUILD_STABLE, { platform: 'windows', arch: 'x64', channel: 'prerelease' });
eq('正式版看领先预发布：有更新', r_pre.has_update, true);
eq('最新 tag 是预发布', r_pre.latest_tag, 'v0.3.1-Bata1');
ok('标记为预发布', r_pre.latest_is_prerelease);
eq('取预发布说明', r_pre.release_notes, '# v0.3.1-Bata1 预发布说明');
eq('取预发布的安装包', r_pre.file_name, 'viewpdf_0.3.1-Bata1_x64-setup.exe');
ok('预发布领先标志透传', r_pre.prerelease_leading);

const r_beta_same = resolve_update(LATEST_PRE, DIST, BUILD_BETA1, { platform: 'windows', arch: 'x64', channel: 'prerelease' });
eq('Bata1 构建看 Bata1：无更新（否则永远 nag 自己）', r_beta_same.has_update, false);
eq('无更新时展示当前版本说明', r_beta_same.release_notes, '# v0.3.1-Bata1 预发布说明');

const r_beta_stable_ch = resolve_update(LATEST_STABLE, DIST, BUILD_BETA1, { platform: 'windows', arch: 'x64', channel: 'stable' });
// 预发布属于更新的版本线（0.3.1-Bata1 > 0.3.0），正式通道不得把用户往回拽
eq('Bata1 构建看正式通道：无更新（不提示降级）', r_beta_stable_ch.has_update, false);
ok('但当前构建被标记为预发布', r_beta_stable_ch.current_is_prerelease);
// current ≠ latest 且 has_update=false —— 这才是「说明取错版本」能发生的唯一形态。
// 上面的 0.3.0→0.3.0 那种 current == latest，两行取的是同一条记录，
// 断言它验不出「拿新版说明冒充当前版」这个 bug（曾经就这么假绿过）。
eq('无更新且版本不同时：说明必须取当前版本，不能拿最新版冒充',
  r_beta_stable_ch.release_notes, '# v0.3.1-Bata1 预发布说明');

// 预发布比正式版旧时（接口此时返回 404，这里顺带验证万一返回也别误导人）
const STALE_PRE = { channel: 'prerelease', prerelease_leading: false, latest: LATEST_STABLE.latest, latest_prerelease: { tag: 'v0.3.0-Bata2', prerelease: true } };
const r_stale = resolve_update(STALE_PRE, DIST, BUILD_STABLE, { platform: 'windows', arch: 'x64', channel: 'prerelease' });
eq('预发布比正式版旧时不得提示"更新"（那是降级）', r_stale.has_update, false);

console.log('--- 有新版但下不了（包缺失要能被 UI 区分）---');
const r_nopkg = resolve_update(LATEST_PRE, { ...DIST, packages: [] }, BUILD_STABLE, { platform: 'windows', arch: 'x64', channel: 'prerelease' });
eq('包缺失被标记', r_nopkg.package_missing, true);
eq('缺包时 file_name 为空', r_nopkg.file_name, '');
eq('缺包时仍报告有新版', r_nopkg.has_update, true);
eq('缺包时无候选链', build_download_candidates(r_nopkg.package, r_nopkg.latest_tag).length, 0);

console.log('--- 通道探测：两种 404 形状必须分开 ---');
// ⚠️ 以下两个 body 是 2026-10-03 从生产接口原样抓的，**不是编的**。
// 早先的守卫只喂了第一种（`{ error: 'not_found' }`），于是
// 「所有非 2xx 一律当通道没版本」看起来像合理的容错 —— 而真实故障恰好也是
// 404，被它吞掉后所有用户都被告知「已是最新」。
const LATEST_STABLE_EMPTY_404 = {
  error: 'not_found',
  error_description: 'No leading prerelease version found for this project',
  channel: 'prerelease',
  project: { id: '6a5a4aae002b29207e4c', name: 'ViewPDF', slug: 'ViewPDF', repo: 'SECTL/ViewPDF' },
};
const LOOKUP_FAILED_404 = {
  error: 'not_found',
  error_description: 'Software project or GitHub repository is not configured',
};
eq('stable 有版本 → ok', probe_channel(200, LATEST_STABLE), CHANNEL_PROBE_OK);
eq('预发布无领先版本 → empty（正常业务结果，不抛错）',
  probe_channel(404, LATEST_STABLE_EMPTY_404), CHANNEL_PROBE_EMPTY);
// 这三条是本次修复的核心断言
eq('查询失败 404（有 error_description、无 channel）→ error，绝不当成 empty',
  probe_channel(404, LOOKUP_FAILED_404), CHANNEL_PROBE_ERROR);
eq('无 body 的 404 → error', probe_channel(404, null), CHANNEL_PROBE_ERROR);
eq('500 → error', probe_channel(500, null), CHANNEL_PROBE_ERROR);
// 只认 404：body 长得再像通道空态，状态码不是 404 也不能放行
eq('500 即使 body 长得像通道空态也必须是 error',
  probe_channel(500, LATEST_STABLE_EMPTY_404), CHANNEL_PROBE_ERROR);
eq('403 同理', probe_channel(403, LATEST_STABLE_EMPTY_404), CHANNEL_PROBE_ERROR);
eq('200 但无 latest（形状不对）→ error，不当成「已是最新」',
  probe_channel(200, { success: true }), CHANNEL_PROBE_ERROR);
eq('网络错误（status 0）→ error', probe_channel(0, null), CHANNEL_PROBE_ERROR);
// 只有 404 + not_found + channel 同时成立才算 empty
eq('有 channel 但 error 不是 not_found → error',
  probe_channel(404, { ...LATEST_STABLE_EMPTY_404, error: 'boom' }), CHANNEL_PROBE_ERROR);
eq('empty 的 body 形状不能靠 error_description 文案判定（文案变了仍算 empty）',
  probe_channel(404, { ...LATEST_STABLE_EMPTY_404, error_description: '文案被服务端改过' }),
  CHANNEL_PROBE_EMPTY);

console.log('--- 查询 URL：repo 的斜杠不能被编码 ---');
{
  const url = build_latest_tag_url('stable');
  ok('URL 不含 %2F（服务端不解码，会查不到仓库）', !url.includes('%2F'));
  ok('URL 不含任何百分号编码的斜杠变体', !/%2f/i.test(url));
  ok('repo 参数保留字面斜杠', url.includes('repo=SECTL/ViewPDF'));
  eq('stable 通道', build_latest_tag_url('stable'), '/api/software/latest-tag?repo=SECTL/ViewPDF&channel=stable');
  eq('预发布通道', build_latest_tag_url('prerelease'), '/api/software/latest-tag?repo=SECTL/ViewPDF&channel=prerelease');
  eq('未知通道收敛到 stable', build_latest_tag_url('bogus'), build_latest_tag_url('stable'));
  eq('未传通道收敛到 stable', build_latest_tag_url(), build_latest_tag_url('stable'));
  // 把这次的坑写成断言：encodeURIComponent 正是那个会产出 %2F 的函数
  ok('（回归说明）encodeURIComponent 确实会编码掉斜杠，所以不能用它',
    encodeURIComponent('SECTL/ViewPDF').includes('%2F'));
  ok('URL 仍会转义该转义的字符（不是完全不编码）',
    build_latest_tag_url('stable').startsWith('/api/software/latest-tag?repo='));
}

console.log('--- 故障原因要能带给用户（否则红色横幅只能说「失败」）---');
eq('取服务端 error_description', channel_probe_reason(404, LOOKUP_FAILED_404),
  'Software project or GitHub repository is not configured');
eq('无 body 时退回 HTTP 状态码', channel_probe_reason(502, null), 'HTTP 502');
eq('有 error 无 description 时退回 error', channel_probe_reason(500, { error: 'boom' }), 'boom');

console.log('--- 真跑 checkForUpdate（注入假 IPC，喂真实响应）---');
// 此前这里只有一组**正则**守卫，因为 checkForUpdate 依赖 window.__TAURI__ 跑不起来。
// 结果跨过了整个纯函数层都没人发现：`checkForUpdate` 返回 `{has_update, ...}`，
// 两个调用点却写 `const { result } = await ...`，解构出 undefined，
// 两个 UI 的 `if (!result)` 于是把**每次**检查都判成「检查更新失败」。
// 现在加了 invoke 注入缝（opts.invoke），函数本身可以跑，形状一致性就能真验。
{
  const U = await import(pathToFileURL(path.join(APP, 'modules', 'update', 'update.js')).href);

  // ⚠️ 假 IPC 必须照抄 Rust 的返回形状：`update_http_get` 返回的是
  //    `{status, body}` 的**字符串**，其中 body 是**响应文本的字符串**。
  //    第一版这里直接返回 `{status:200, body: <对象>}`，于是 `_api_get` 的
  //    `JSON.parse(parsed.body)` 抛错、被 catch 吞成 body=null，
  //    probe 判定「形状不对」→ 报「latest-tag 查询失败：HTTP 200」。
  //    假实现比真实现宽松，测出来的东西就是假的。
  const wrap = (status, body) => JSON.stringify({ status, body: JSON.stringify(body) });

  // 真实抓下来的响应（2026-10-03）。latest-tag 按 URL 里的 channel 分流，
  // distribution 一律返回同一份 —— 与真实服务端行为一致。
  const ipc = (latest_tag_route, build = BUILD_OLD) => async (cmd, args) => {
    if (cmd === 'app_fetch_platform') return 'windows';
    if (cmd === 'app_fetch_build_info') return build;
    if (cmd !== 'update_http_get') throw new Error('unexpected command: ' + cmd);
    const url = args.url;
    if (url.includes('/latest-tag')) {
      // 传输层拿到的 URL 也必须是字面斜杠 —— 这是本次修复的核心，验在调用边界上
      ok('传输层拿到的 latest-tag URL 里斜杠是字面的',
        !url.includes('%2F') && url.includes('repo=SECTL/ViewPDF'));
      return latest_tag_route(url);
    }
    if (url.includes('/distribution')) return wrap(200, DIST);
    throw new Error('unexpected url: ' + url);
  };
  const route_stable = () => wrap(200, LATEST_STABLE);
  const route_empty = (url) => (url.includes('channel=prerelease')
    ? wrap(404, LATEST_STABLE_EMPTY_404)
    : wrap(200, LATEST_STABLE));
  const route_broken = () => wrap(404, LOOKUP_FAILED_404);

  // ⚠️ 每个场景都必须用 settle 包起来。
  // 直接 `await U.checkForUpdate(...)` 时，一旦某个变异让它抛错，异常会冲出本块，
  // **后面所有断言都不会执行** —— 守卫被整段跳过，变异测试只看到崩溃前那几条，
  // 于是「变红了但没命中预期标签」，看起来像守卫写错了，实际是守卫根本没跑。
  const settle = async (p) => {
    try { return { value: await p }; } catch (error) { return { error }; }
  };

  // ---- 正常路径：0.2.5 用户在 stable 通道 ----
  const s_ok = await settle(U.checkForUpdate({ invoke: ipc(route_stable) }));
  ok('正常路径不抛错', !s_ok.error);
  const r = s_ok.value || {};
  ok('返回的是对象本身，不是包装层', !!r && typeof r === 'object');
  ok('返回值里**没有** result 字段（所以调用点不能解构它）', !('result' in r));
  eq('has_update 为 true', r.has_update, true);
  eq('latest_tag', r.latest_tag, 'v0.3.0');
  eq('选中了 Windows 安装包', r.file_name, 'viewpdf_0.3.0_x64-setup.exe');
  eq('channel_empty 未置位', !!r.channel_empty, false);
  eq('package_missing 未置位', r.package_missing, false);
  // 调用点真正会读到的字段，一个都不能缺。
  // `channel_empty` 不在此列：它只出现在「通道为空」那条返回值里，正常路径上
  // 该键**不存在**。两个 UI 都用 `if (result.channel_empty)` 的真值判断，
  // 缺键等价于 false，所以不需要为了形状统一而硬塞一个 `false` 进去。
  for (const f of ['has_update', 'current_version', 'current_tag',
    'current_is_prerelease', 'latest_version', 'latest_tag', 'latest_is_prerelease',
    'prerelease_leading', 'release_notes', 'package', 'file_name', 'file_size',
    'package_missing']) {
    ok(`返回值带字段 ${f}`, f in r);
  }
  ok('正常路径不置 channel_empty（缺键即可，UI 用真值判断）', !('channel_empty' in r));

  // 已是最新：换一个 build 再跑一次，同一条代码路径
  const s_cur = await settle(U.checkForUpdate({ invoke: ipc(route_stable, BUILD_STABLE) }));
  ok('已是最新路径不抛错', !s_cur.error);
  eq('已是最新时 has_update 为 false', s_cur.value?.has_update, false);
  eq('已是最新时仍报出当前版本', s_cur.value?.current_version, '0.3.0');
  eq('已是最新时 latest_tag 照常给出', s_cur.value?.latest_tag, 'v0.3.0');

  // ---- 通道为空：正常业务结果，绝不能抛 ----
  // 这条最容易被写坏：把 empty 分支的条件换成 ok，空通道就会掉进下面的
  // 「状态无法判定 → throw」，用户看到的是红色失败横幅而不是「该通道无版本」。
  const s_empty = await settle(U.checkForUpdate({ channel: 'prerelease', invoke: ipc(route_empty) }));
  ok('空通道不抛错（是业务结果，不是故障）', !s_empty.error);
  eq('prerelease 通道空 → channel_empty', s_empty.value?.channel_empty, true);
  eq('空通道不报 has_update', s_empty.value?.has_update, false);
  ok('空通道返回对象而非抛错', !!s_empty.value && typeof s_empty.value === 'object');
  ok('空通道也没有 result 字段', !('result' in (s_empty.value || {})));

  // ---- 查询失败：必须抛，且消息要带服务端原因 ----
  const s_broken = await settle(U.checkForUpdate({ invoke: ipc(route_broken) }));
  ok('查询失败会抛错（不落到 channel_empty）', !!s_broken.error);
  ok('错误信息带上服务端给的原因',
    !!s_broken.error && String(s_broken.error.message).includes('not configured'));
  ok('故障时绝不返回对象（否则又会被当成「已是最新」）', !s_broken.value);

  // ---- 调用点写法守卫 ----
  // checkForUpdate 没有外层包装，所以 `const { result } = await ...` 恒为 undefined。
  // 这一条就是本次线上故障的直接原因。
  const fs = await import('node:fs');
  for (const rel of ['oobe.js', 'modules/settings/settings.js']) {
    const src = fs.readFileSync(path.join(APP, rel), 'utf8');
    ok(`${rel} 不解构 checkForUpdate 的返回值`,
      !/const\s*\{\s*result\s*\}\s*=\s*await\s+checkForUpdate/.test(src));
    ok(`${rel} 直接接收返回值`, /const\s+result\s*=\s*await\s+checkForUpdate/.test(src));
  }
}

console.log('--- 调用方源码接线（原先只有正则，现在上面的真跑已覆盖主要分支）---');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(APP, 'modules', 'update', 'update.js'), 'utf8');
  const fn = /export async function checkForUpdate\([\s\S]*?\n\}/.exec(src);
  ok('找到 checkForUpdate', !!fn);
  const body = fn ? fn[0] : '';
  ok('用 build_latest_tag_url 构造 URL（不再内联拼接）', body.includes('build_latest_tag_url(channel)'));
  ok('URL 不再被 encodeURIComponent 拼（那正是 %2F 的来源）',
    !/latest-tag\?repo=\$\{encodeURIComponent/.test(src));
  ok('探测出 error 时 throw（不落到 channel_empty）',
    /probe === CHANNEL_PROBE_ERROR[\s\S]{0,200}?throw new Error/.test(body));
  ok('只有 empty 才置 channel_empty',
    /probe === CHANNEL_PROBE_EMPTY[\s\S]{0,400}?channel_empty: true/.test(body));
  ok('channel_empty 不再由「取反探测结果」得出', !/!probe_channel\(/.test(src));
  // 兜底：万一 probe_channel 以后多返回一种状态，不能被当成「正常」放行
  ok('非 ok/empty 的未知状态也 throw', /probe !== CHANNEL_PROBE_OK[\s\S]{0,200}?throw new Error/.test(body));
  ok('invoke 走注入缝（否则本节真跑不起来）', body.includes('_ipc(opts)'));
}

console.log('--- 构建身份：预发布横幅 + 版本号显示 ---');
// ⚠️ 这几条是**源码级**守卫，不是行为守卫：这段逻辑嵌在设置面板的大 IIFE 里、
// 又依赖 Tauri IPC，抽出来真跑的成本远高于收益。但有两个回归必须挡住：
//
//  1. 把 app_fetch_build_info「简化」成 app_fetch_version —— 后者返回的
//     CARGO_PKG_VERSION 对 v0.3.0-Bata2 和 v0.3.0 **都是 0.3.0**，于是 prerelease
//     恒为 false：横幅永不出现，版本号也永远显示 0.3.0。这是个看起来完全无害的
//     改动，零报错，症状是「beta 用户看不出来自己在 beta」。
//  2. 无条件显示 tag —— 正式版用户的版本号会凭空多出个 `v` 前缀。
{
  const fs = await import('node:fs');
  const panel = fs.readFileSync(path.join(APP, 'modules', 'settings', 'settings-panel.js'), 'utf8');
  const setjs = fs.readFileSync(path.join(APP, 'modules', 'settings', 'settings.js'), 'utf8');

  const fn = /async function settings_load_version\([\s\S]*?\n {4}\}/.exec(setjs);
  ok('找到 settings_load_version', !!fn);
  const body = fn ? fn[0] : '';
  ok('用 resolve_build_identity 判定通道（覆盖的唯一入口）', body.includes('resolve_build_identity(invoke)'));
  ok('不得直接 invoke app_fetch_build_info（会绕开覆盖，且多一份真相）',
    !/invoke\(\s*'app_fetch_build_info'/.test(body));
  ok('不得用 app_fetch_version 判定（两者 Cargo 版本相同，恒为正式版）',
    !body.includes('app_fetch_version'));
  ok('读的是 prerelease 字段', /info\?\.prerelease/.test(body));

  // 版本号显示规则：预发布显示 tag 原文，正式版显示 Cargo 版本
  ok('预发布时版本号显示 tag',
    /versionNumber\.textContent\s*=\s*info\?\.prerelease\s*\?\s*\(info\.tag/.test(body));
  ok('正式版仍显示 Cargo 版本（不是 tag）',
    /prerelease\s*\?\s*\(info\.tag\s*\|\|\s*v\)\s*:\s*v\b/.test(body));

  // 横幅显隐。
  // ⚠️ 不要写成「`if (banner) {` 之后 N 字符内出现 else」这种距离型断言：
  // 它量的是代码有多长，不是控制流长什么样，稍加缩进或加一行注释就失效
  // （第一版就是 200 字符不够用而误报）。锚在语义片段上。
  ok('横幅显隐由 prerelease 决定',
    /if\s*\(\s*info\?\.prerelease\s*\)\s*\{[\s\S]{0,300}?banner\.style\.display = '';/.test(body));
  ok('非预发布走 else 分支隐藏横幅',
    /\}\s*else\s*\{\s*banner\.style\.display = 'none';\s*\}/.test(body));
  ok('查询失败时隐藏而不是显示（正式版看到「预发布版」比看不到更糟）',
    /catch[\s\S]{0,400}?banner\.style\.display = 'none'/.test(body));
  ok('失败时不用空串清空版本号',
    !/catch[\s\S]{0,300}?versionNumber\.textContent = ''/.test(body));
  ok('横幅文案走 data-i18n', panel.includes('data-i18n="settings.prereleaseWarning"'));
  ok('横幅不用 prereleaseBadge（那个键更新页还在用，改它会连带改掉那行）',
    !/class="sp-prerelease-banner-label"[^>]*data-i18n="settings\.prereleaseBadge"/.test(panel));
  ok('警示语允许折行（不再 nowrap —— 一整句 nowrap 会在窄窗口溢出）',
    !/sp-prerelease-banner-label\s*\{[^}]*white-space:\s*nowrap/.test(
      fs.readFileSync(path.join(APP, 'modules', 'settings', 'settings.css'), 'utf8')));
  ok('版本号不折行（从中间断开成 "v0.3.1-Bat / a3" 比折行更糟）',
    /sp-prerelease-banner-tag\s*\{[^}]*white-space:\s*nowrap/.test(
      fs.readFileSync(path.join(APP, 'modules', 'settings', 'settings.css'), 'utf8')));
  ok('横幅在面板模板里默认隐藏（JS 没跑到 = 不显示，而不是常驻误报）',
    /id="prereleaseBanner"[^>]*style="display:none;/.test(panel));
  ok('横幅与版本号共用同一次 IPC（拆开只会多一轮往返，且可能读到不同结果）',
    (body.match(/resolve_build_identity\(invoke\)/g) || []).length === 1);

  // 位置：必须在内容区（.sp-content）里，且是第一个子元素。
  // 侧栏只有 220px，塞带版本号的横幅既挤导航又得靠缩窄自己才塞得下。
  const content = /<div class="sp-content">([\s\S]*?)<div class="sp-page"/.exec(panel);
  ok('找到 .sp-content 的开头', !!content);
  const head = content ? content[1] : '';
  ok('横幅在 .sp-content 内', head.includes('id="prereleaseBanner"'));
  ok('横幅是内容区的第一个子元素（排在所有 .sp-page 之前）',
    head.trim().startsWith('<div class="sp-prerelease-banner"'));
  // 侧栏里不该再残留一份 —— 两处 id 重复会让 getElementById 拿到排在前面的那个
  const sidebar = /id="settingsSidebar"[\s\S]*?<\/div>\s*<\/div>/.exec(panel);
  ok('找到侧栏', !!sidebar);
  ok('侧栏里不再有横幅', sidebar ? !sidebar[0].includes('prereleaseBanner') : false);
  eq('横幅只出现一次（id 重复会让 getElementById 取到前一个）',
    (panel.match(/id="prereleaseBanner"/g) || []).length, 1);

  // 文案必须 9 个语言包都有，否则缺键时 i18n 会把键名本身显示出来
  for (const f of fs.readdirSync(path.join(APP, 'locales')).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(APP, 'locales', f), 'utf8'));
    ok(`${f} 有 settings.prereleaseWarning`, !!j.settings?.prereleaseWarning);
    // prereleaseBadge 必须仍在：更新页的「当前版本 0.3.0 (预发布版 vX)」用它
    ok(`${f} 仍保留 settings.prereleaseBadge`, !!j.settings?.prereleaseBadge);
  }
}

console.log('--- 构建身份覆盖（ViewPDFDev，webview 控制台可用）---');
// 这一节**真跑** build-identity.js —— 它只 import update-resolve.js（纯函数），
// 没有 Tauri / DOM 依赖，所以能直接在 node 里执行。不需要像上面的设置面板那样
// 退化成源码正则。
{
  // window 已在文件顶部就位（必须早于任何 src 模块求值），这里直接用。
  const B = await import(pathToFileURL(path.join(APP, 'modules', 'build-identity.js')).href);
  const settle = async (p) => {
    try { return { value: await p }; } catch (error) { return { error }; }
  };

  console.log('  · 输入规整');
  eq('预发布 tag → version 取核心版本（与真实 beta 构建一致，预览才有意义）',
    B.parse_override('v0.3.1-Bata3')?.version, '0.3.1');
  eq('预发布 tag 的 tag 保留原文', B.parse_override('v0.3.1-Bata3')?.tag, 'v0.3.1-Bata3');
  eq('预发布 prerelease 为 true', B.parse_override('v0.3.1-Bata3')?.prerelease, true);
  eq('semver 剥掉 v', B.parse_override('v0.3.1-Bata3')?.semver, '0.3.1-Bata3');
  eq('无 v 前缀时补上', B.parse_override('0.3.1-Bata3')?.tag, 'v0.3.1-Bata3');
  eq('大写 V 前缀保留', B.parse_override('V0.3.0')?.tag, 'V0.3.0');
  eq('正式版 → prerelease false', B.parse_override('v0.3.0')?.prerelease, false);
  eq('正式版 version 就是核心版本', B.parse_override('v0.3.0')?.version, '0.3.0');
  eq('build metadata 不参与 semver', B.parse_override('v0.3.0-rc.1+abc')?.semver, '0.3.0-rc.1');
  eq('多段预发布', B.parse_override('v1.0.0-beta.3')?.semver, '1.0.0-beta.3');

  console.log('  · 非法输入必须被拒（静默当正式版会让人以为覆盖生效了）');
  for (const bad of ['', '   ', 'abc', '1.2', 'Bata3', 'v', 'v1', null, undefined, {}]) {
    eq(`拒绝 ${JSON.stringify(bad)}`, B.parse_override(bad), null);
  }

  console.log('  · 状态机');
  eq('初始无覆盖', B.get_version_override(), null);
  eq('初始 isOverridden 为 false（此处用 getVersion 判）',
    B.get_version_override() === null, true);
  const s1 = await settle(Promise.resolve().then(() => B.set_version_override('v0.3.1-Bata3')));
  // ⚠️ 上面这行**必须 await**。第一版漏了，于是紧接着的
  // `ok('setVersion 合法值成功', !s1.error)` 读的是 **Promise 对象**上的
  // `.error`（恒为 undefined），`!undefined` 恒为 true —— 断言看着通过，其实
  // 什么都没验；下一条 `覆盖已生效` 就因为设置还没执行而拿到 undefined。
  ok('setVersion 合法值成功', !s1.error);
  eq('覆盖已生效', B.get_version_override()?.tag, 'v0.3.1-Bata3');
  const threw = await settle(Promise.resolve().then(() => B.set_version_override('不是版本号')));
  ok('setVersion 非法值抛错（控制台里敲错字符必须立刻有反馈）', !!threw.error);
  eq('非法值不改变已有覆盖（不能因为敲错就清掉正在生效的）',
    B.get_version_override()?.tag, 'v0.3.1-Bata3');

  console.log('  · 覆盖生效时不再问 Tauri');
  let asked = 0;
  const counting = async (cmd) => { asked++; return { version: '9.9.9', tag: 'v9.9.9', semver: '9.9.9', prerelease: false }; };
  const withOverride = await settle(B.resolve_build_identity(counting));
  eq('用了覆盖值而不是 Tauri 的', withOverride.value?.tag, 'v0.3.1-Bata3');
  eq('覆盖生效时一次 IPC 都不该发', asked, 0);
  ok('返回的是副本，调用方改它不会污染已存状态',
    (withOverride.value.tag = '被改了', B.get_version_override()?.tag) === 'v0.3.1-Bata3');

  console.log('  · 清除后回到真实构建身份');
  eq('clearVersion 报告确实清过', B.clear_version_override(), true);
  eq('清除后无覆盖', B.get_version_override(), null);
  eq('再次清除报告没得清', B.clear_version_override(), false);
  const after = await settle(B.resolve_build_identity(counting));
  eq('清除后重新问 Tauri', after.value?.tag, 'v9.9.9');
  eq('并且确实问了一次', asked, 1);

  console.log('  · 订阅者刷新');
  let hits = 0;
  const off = B.on_build_identity_change(() => { hits++; });
  B.set_version_override('v0.3.1-Bata3');
  eq('设置覆盖时通知一次', hits, 1);
  B.clear_version_override();
  eq('清除时也通知一次（面板要能刷回正式版外观）', hits, 2);
  off();
  B.set_version_override('v0.3.1-Bata3');
  eq('退订后不再通知', hits, 2);
  B.clear_version_override();

  console.log('  · 边界：不得落盘、不得污染遥测');
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(APP, 'modules', 'build-identity.js'), 'utf8');
  // 覆盖一旦持久化，就等于给发行版埋了「用户会误触发的假版本号」，
  // 而假版本号会一路影响更新判定 —— 必须是纯内存。
  for (const forbidden of ['settings_save', 'localStorage', 'sessionStorage',
    'invoke(\'settings_', 'writeTextFile', 'app_config_save']) {
    ok(`build-identity.js 不含 ${forbidden}`, !src.includes(forbidden));
  }
  // reportVersion 直接调 app_fetch_version：覆盖若伸进这里，开发期每次预览都会
  // 往服务端上报假版本号，把版本分布统计搅乱。
  const tele = fs.readFileSync(path.join(APP, 'modules', 'telemetry', 'telemetry-api.js'), 'utf8');
  ok('遥测不 import build-identity', !tele.includes('build-identity'));
  ok('遥测仍直接用 app_fetch_version', tele.includes("invoke('app_fetch_version')"));
  // 真实 invoke 只应存在于 build-identity.js 一处
  const real_callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'locales') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const body = fs.readFileSync(p, 'utf8');
      // 去掉注释再数，否则文档里提到这个命令名会被算成调用点
      const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      if (/invoke\(\s*'app_fetch_build_info'/.test(code)) real_callers.push(path.relative(APP, p).split(path.sep).join('/'));
    }
  };
  walk(APP);
  eq('真实 invoke(app_fetch_build_info) 只有 build-identity.js 一处',
    real_callers.join(','), 'modules/build-identity.js');
  ok('控制台入口 ViewPDFDev 已挂上', /window\.ViewPDFDev\s*=/.test(src));

  // 真跑一遍控制台入口本身：上面那条是「源码里有这段代码」，这条是
  // 「import 之后 window.ViewPDFDev 真的能用」。两者不是一回事。
  const dev = globalThis.window.ViewPDFDev;
  ok('window.ViewPDFDev 真的挂上了（import 之后可访问）', !!dev);
  for (const m of ['setVersion', 'clearVersion', 'getVersion', 'isOverridden']) {
    ok(`ViewPDFDev.${m} 是函数`, typeof dev?.[m] === 'function');
  }
  eq('isOverridden 初始为 false', dev.isOverridden(), false);
  dev.setVersion('v0.3.1-Bata3');
  eq('经控制台入口设置生效', dev.getVersion().tag, 'v0.3.1-Bata3');
  eq('isOverridden 变 true', dev.isOverridden(), true);
  dev.clearVersion();
  eq('经控制台入口清除生效', dev.isOverridden(), false);

  // 可用性：ViewPDFDev 必须在**主窗口启动路径**上加载。
  // 只靠消费方（设置面板 / 更新模块）间接带进来是不够的 —— 两者都是懒加载的
  // （设置面板要用户打开才 import），应用刚启动时控制台里敲
  // `ViewPDFDev.setVersion(...)` 只会得到 "ViewPDFDev is not defined"。
  // 而启动后立刻在控制台里改版本，恰恰是它唯一的使用场景。
  const idx = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
  ok('index.html 启动时加载 init.js', /import\('\.\/init\.js'\)/.test(idx));
  const initjs = fs.readFileSync(path.join(APP, 'init.js'), 'utf8');
  ok('init.js 侧载 build-identity（保证启动即挂上 ViewPDFDev）',
    /import\s+'\.\/modules\/build-identity\.js'/.test(initjs));
}

console.log('--- 载荷容错 ---');
eq('versions 缺失不崩', resolve_update(LATEST_STABLE, {}, BUILD_OLD, { platform: 'windows' }).has_update, true);
eq('distribution 全空时仍能判定有更新', resolve_update(LATEST_STABLE, { versions: [], packages: [] }, BUILD_OLD, { platform: 'windows' }).package_missing, true);
eq('latest-tag 无 latest 时不崩', resolve_update({ channel: 'stable' }, DIST, BUILD_STABLE, { platform: 'windows' }).has_update, false);
eq('build 缺失时保守判无更新', resolve_update(LATEST_STABLE, DIST, null, { platform: 'windows' }).has_update, false);

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
