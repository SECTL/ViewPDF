// 变异测试：破坏更新解析的不变式，断言 update-resolve.mjs 变红。
//
// 守卫写错方向 / 正则匹配不到 / 断言写反，都会让它一直绿着，把真回归一起放行 ——
// 比没有守卫更危险，因为它还给人「这块测过了」的错觉。本轮就有三条断言最初
// 写反了（以为 Bata10 > Bata2、以为预发布通道会提示降级），是变异测试之外
// 的人工核对抓出来的；这份脚本负责剩下那些「改了会不会有人发现」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const TARGET = 'modules/update/update-resolve.js';
const ORCHESTRATOR = 'modules/update/update.js';
const ORCHESTRATOR_CALLER_OOBE = 'oobe.js';
const ORCHESTRATOR_CALLER_SETTINGS = 'modules/settings/settings.js';
const PANEL = 'modules/settings/settings-panel.js';
const TELEMETRY = 'modules/telemetry/telemetry-api.js';
const ENTRY = 'init.js';
const IDENTITY = 'modules/sectl-client.js';
const BUILD_IDENTITY = 'modules/build-identity.js';
const HARNESS = path.join(ROOT, 'tests', 'update-resolve.mjs');

let pass = 0, fail = 0;
function report(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   ' + detail : ''));
}

function fresh_copy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewpdf-update-'));
  fs.cpSync(SRC, path.join(dir, 'src'), { recursive: true });
  return path.join(dir, 'src');
}

function patch(src_dir, rel, pairs) {
  const p = path.join(src_dir, rel);
  let body = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (!body.includes(from)) throw new Error(`补丁锚点未命中 ${rel}: ${JSON.stringify(from.slice(0, 70))}`);
    body = body.replace(from, to);
  }
  fs.writeFileSync(p, body);
}

/**
 * 每条变异：{ name, pairs, expect } 或 { name, file, pairs, expect }。
 * 身份常量住在 `modules/sectl-client.js`，解析逻辑在 `update-resolve.js`，
 * 用默认的 `file` 指向后者，需要动身份常量时显式给 `file`。
 */
function apply(src_dir, m) {
  patch(src_dir, m.file || TARGET, m.pairs);
}

function run(src_dir) {
  const r = spawnSync(process.execPath, [HARNESS], {
    env: { ...process.env, VP_APP_SRC: src_dir },
    encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = [...out.matchAll(/^FAIL\s+(.*)$/gm)].map((m) => m[1].trim());
  return { code: r.status, failed, out };
}

const MUTATIONS = [
  // ── 构建身份覆盖（ViewPDFDev）──
  // 它的每种坏法都不报错，只是「覆盖看起来没生效」或「静默改掉了不该改的东西」。
  {
    name: '非法输入被静默当成正式版（敲错字符却毫无反馈，只会去怀疑别处）',
    file: BUILD_IDENTITY,
    pairs: [['  const parsed = parse_version(s);\n  if (!parsed) return null;', '  const parsed = parse_version(s) || { core: [0, 0, 0], pre: [] };']],
    expect: '拒绝 "abc"',
  },
  {
    name: 'parse_override 对垃圾输入不再返回 null（下游会把 0.0.0 当合法版本）',
    file: BUILD_IDENTITY,
    pairs: [['  if (!s) return null;\n  const parsed = parse_version(s);\n  if (!parsed) return null;', '  if (!s) return null;\n  const parsed = parse_version(s) || { core: [0, 0, 0], pre: [] };']],
    expect: '拒绝 "abc"',
  },
  {
    name: 'set 时非法输入不抛错，直接覆盖（覆盖会带着 0.0.0 生效）',
    file: BUILD_IDENTITY,
    pairs: [["  if (!parsed) throw new Error(`无法解析的版本号：${JSON.stringify(raw)}（示例：v0.3.1-Bata3）`);", '  if (!parsed) return null;']],
    expect: 'setVersion 非法值抛错',
  },
  {
    // 有效的破坏方式：把赋值提到校验**之前**。第一版写成
    // `_override = parsed || null`，而那个位置上的 parsed 必然为真（校验已经过了），
    // 于是变异是空操作、harness 全绿 —— 变异测试判定「抓不到」才把它摆上台面。
    // 空操作比没有守卫更危险：它给了一种「这里测过了」的错觉。
    name: '赋值提到校验之前（敲错一次就把正在生效的 beta 清成正式版）',
    file: BUILD_IDENTITY,
    pairs: [[
      '  const parsed = parse_override(raw);\n  if (!parsed) throw new Error(`无法解析的版本号：${JSON.stringify(raw)}（示例：v0.3.1-Bata3）`);\n  _override = parsed;',
      '  const parsed = parse_override(raw);\n  _override = parsed;\n  if (!parsed) throw new Error(`无法解析的版本号：${JSON.stringify(raw)}（示例：v0.3.1-Bata3）`);',
    ]],
    expect: '非法值不改变已有覆盖',
  },
  {
    name: '预发布覆盖的 version 填成带后缀的全串（覆盖出来的 beta 与真实 beta 行为不一致，预览失去意义）',
    file: BUILD_IDENTITY,
    pairs: [['    version: parsed.core.join(\'.\'),', '    version: semver,']],
    expect: 'version 取核心版本',
  },
  {
    name: '覆盖生效时仍然去问 Tauri（预览值被真实构建身份盖掉）',
    file: BUILD_IDENTITY,
    pairs: [['  if (_override) return { ..._override };\n  return invoke(\'app_fetch_build_info\');', "  return invoke('app_fetch_build_info');"]],
    expect: '覆盖生效时一次 IPC 都不该发',
  },
  {
    name: '返回内部对象而不是副本（调用方一改就污染了已存的覆盖）',
    file: BUILD_IDENTITY,
    pairs: [['  if (_override) return { ..._override };', '  if (_override) return _override;']],
    expect: '调用方改它不会污染已存状态',
  },
  {
    name: 'clearVersion 不通知订阅者（面板刷不回正式版外观，横幅还留着）',
    file: BUILD_IDENTITY,
    pairs: [['  const had = _override !== null;\n  _override = null;\n  if (had) _notify();\n  return had;', '  const had = _override !== null;\n  _override = null;\n  return had;']],
    expect: '清除时也通知一次',
  },
  {
    name: '覆盖被写进配置（等于给发行版埋一个用户会误触发的假版本号，还会一路影响更新判定）',
    file: BUILD_IDENTITY,
    pairs: [['  _override = parsed;', "  _override = parsed;\n  try { window.__TAURI__.core.invoke('settings_save_all_local', { settings: { versionOverride: parsed.tag } }); } catch (_) { /* 忽略 */ }"]],
    expect: 'build-identity.js 不含 settings_save',
  },
  {
    name: '遥测改走 resolve_build_identity（开发期每次预览都往服务端上报假版本号，污染版本分布统计）',
    file: TELEMETRY,
    pairs: [["            invoke('app_fetch_version')", "            (await import('../build-identity.js')).resolve_build_identity(invoke)"]],
    expect: '遥测仍直接用 app_fetch_version',
  },
  {
    name: 'ViewPDFDev 只靠消费方间接加载（设置面板懒加载 → 控制台里 ViewPDFDev is not defined）',
    file: ENTRY,
    pairs: [["import './modules/build-identity.js';", "// 挪到消费方里间接加载了\n"]],
    expect: 'init.js 侧载 build-identity',
  },
  {
    name: '消费方绕开覆盖入口、直接调 app_fetch_build_info（覆盖在那一处完全不生效）',
    file: ORCHESTRATOR_CALLER_SETTINGS,
    pairs: [['const info = await resolve_build_identity(invoke);', "const info = await invoke('app_fetch_build_info');"]],
    expect: '用 resolve_build_identity 判定通道',
  },
  {
    name: '预发布标识符解析被丢弃（回到旧 Rust 行为：预发布永不提示）',
    pairs: [[
      "const pre = pre_part ? pre_part.split('.') : [];",
      "const pre = [];",
    ]],
    // 这个变异会同时打红十几条断言，标签只需命中其中一条即可
    expect: '解析带预发布',
  },
  {
    name: '核心版本比较被忽略',
    pairs: [[
      "    if (va.core[i] !== vb.core[i]) return va.core[i] < vb.core[i] ? -1 : 1;",
      "    if (false) return 0;",
    ]],
    expect: '0.2.5 < 0.3.0',
  },
  {
    name: '预发布优先级反过来（预发布被当成比正式版新）',
    pairs: [['  if (va.pre.length === 0) return 1;', '  if (va.pre.length === 0) return -1;']],
    expect: '正式版 > 同核心预发布',
  },
  {
    name: 'Windows 扩展名优先级被抹平（.exe / .msi 退化为靠数组顺序碰运气）',
    pairs: [['    score += ext_idx >= 0 ? (ext_rank.length - ext_idx) : -1;', '    score += ext_idx >= 0 ? 0 : -1;']],
    expect: '数组倒序后仍选中 exe',
  },
  {
    name: 'os 匹配不再参与打分（会下到别的系统的包）',
    pairs: [[
      "    if (want_os && p_os) score += (p_os === want_os.toLowerCase()) ? 4 : -4;",
      "",
    ]],
    expect: 'Windows 选中 exe',
  },
  {
    name: 'enabled=false 不再被排除（会下到已停用的包）',
    pairs: [['    if (p.enabled === false) continue;', '']],
    expect: 'enabled=false 被排除',
  },
  {
    name: '版本 tag 不再过滤（会给旧版本挑包）',
    pairs: [['    if (!p || p.version_tag !== tag) continue;', '    if (!p) continue;']],
    expect: '版本 tag 不匹配则不选',
  },
  {
    name: 'package_id 归一被去掉（镜像下载候选静默消失）',
    pairs: [['  return { ...best, package_id: best.package_id ?? best.$id ?? null };', '  return best;']],
    expect: '第一条走 SECTL 分发接口',
  },
  {
    name: '候选链丢掉服务器镜像那一条',
    pairs: [[
      "    out.push(`${SECTL_API_BASE}/api/software/download?packageId=${encodeURIComponent(pkg.package_id)}&source=server`);",
      "",
    ]],
    expect: '三条候选',
  },
  {
    name: '候选链顺序反了（GitHub 优先于镜像）',
    pairs: [['    out.push(`https://gh-proxy.com/${gh}`);\n    out.push(gh);', '    out.push(gh);\n    out.push(`https://gh-proxy.com/${gh}`);']],
    expect: '第二条走 gh-proxy',
  },
  {
    name: '空响应被当成有更新（网络故障时谎报可更新）',
    pairs: [['  const has_update = !!tag && is_newer(current_semver, latest_semver);', '  const has_update = true;']],
    expect: 'latest-tag 无 latest 时不崩',
  },
  {
    name: '缺包不再被标记（有新版但下不了，UI 分不出来）',
    pairs: [['    package_missing: has_update && !pkg,', '    package_missing: false,']],
    expect: '包缺失被标记',
  },
  {
    name: '「已是最新」时拿最新版说明冒充（撒谎）',
    pairs: [['    release_notes: has_update ? (version_row?.changelog || \'\') : (current_row?.changelog || \'\'),', "    release_notes: version_row?.changelog || '',"]],
    expect: '无更新且版本不同时：说明必须取当前版本',
  },
  {
    name: '预发布通道误取 latest 而不是 latest_prerelease',
    pairs: [['    ? (latestTag?.latest_prerelease || latestTag?.latest)', '    ? (latestTag?.latest)']],
    expect: '最新 tag 是预发布',
  },
  {
    // ── 本次修掉的两个真 bug（生产接口上 A/B 4 轮复现）──
    name: 'repo 的斜杠又被 encodeURIComponent 编码成 %2F（服务端不解码 → 404 → 全员「已是最新」）',
    pairs: [['encodeURI(DISTRIBUTION_REPO)', 'encodeURIComponent(DISTRIBUTION_REPO)']],
    expect: '不含 %2F',
  },
  {
    name: '查询失败的 404 被当成「通道没版本」（故障被伪装成「你已是最新」）',
    pairs: [[
      "  if (status === 404 && body?.error === 'not_found' && typeof body?.channel === 'string') {",
      "  if (status === 404 && body?.error === 'not_found') {",
    ]],
    expect: '查询失败 404',
  },
  {
    name: '任何 4xx/5xx 都算 empty（不只是 404 的通道空态）',
    pairs: [[
      "  if (status === 404 && body?.error === 'not_found' && typeof body?.channel === 'string') {",
      "  if (status >= 400 && body?.error === 'not_found' && typeof body?.channel === 'string') {",
    ]],
    expect: '即使 body 长得像通道空态也必须是 error',
  },
  {
    name: '只看 status 不看 error 就判 empty',
    pairs: [[
      "  if (status === 404 && body?.error === 'not_found' && typeof body?.channel === 'string') {",
      "  if (status === 404 && typeof body?.channel === 'string') {",
    ]],
    expect: '有 channel 但 error',
  },
  {
    name: '2xx 但形状不对（无 latest）被当成 ok（又回到「谎报已是最新」）',
    pairs: [['    return body?.latest ? CHANNEL_PROBE_OK : CHANNEL_PROBE_ERROR;', '    return CHANNEL_PROBE_OK;']],
    expect: '200 但无 latest',
  },
  {
    name: 'probe_channel 对任何输入都返回 error',
    pairs: [[
      "export function probe_channel(status, body) {\n  if (status >= 200 && status < 300) {",
      "export function probe_channel(status, body) {\n  if (false) {",
    ]],
    expect: 'stable 有版本 → ok',
  },
  {
    name: '故障原因被抹掉（红色横幅只能显示「失败」，用户没法自查是不是自己网络的问题）',
    pairs: [['  return body?.error_description || (body?.error ? String(body.error) : `HTTP ${status}`);', '  return \'failed\';']],
    expect: '取服务端 error_description',
  },
  {
    name: 'URL 退回内联拼接 + encodeURIComponent（%2F 的来源被搬回调用方）',
    file: ORCHESTRATOR,
    pairs: [['  const tag_url = build_latest_tag_url(channel);', "  const tag_url = `/api/software/latest-tag?repo=${encodeURIComponent('SECTL/ViewPDF')}&channel=${channel}`;"]],
    expect: '用 build_latest_tag_url',
  },
  {
    name: 'checkForUpdate 不再对探测失败 throw（直接落到 channel_empty = 谎报「已是最新」）',
    file: ORCHESTRATOR,
    pairs: [[
      "  if (probe === CHANNEL_PROBE_ERROR) {\n    throw new Error(`latest-tag 查询失败：${channel_probe_reason(tagRes.status, tagRes.body)}`);\n  }",
      '',
    ]],
    expect: '探测出 error 时 throw',
  },
  {
    name: 'empty 的判定被换成 ok（通道真没版本时反而去解析，会误报有更新）',
    file: ORCHESTRATOR,
    pairs: [['  if (probe === CHANNEL_PROBE_EMPTY) {', '  if (probe === CHANNEL_PROBE_OK) {']],
    expect: '空通道不抛错',
  },
  {
    name: '未知探测状态被当成「正常」放行（probe_channel 加了新状态就会静默说谎）',
    file: ORCHESTRATOR,
    pairs: [[
      "  if (probe !== CHANNEL_PROBE_OK) {\n    throw new Error(`latest-tag 响应无法判定：${channel_probe_reason(tagRes.status, tagRes.body)}`);\n  }",
      '',
    ]],
    expect: '非 ok/empty 的未知状态也 throw',
  },
  {
    // ── 第三个 bug：返回值形状与调用点对不上 ──
    // 曾经是：checkForUpdate 返回 {has_update,...}，调用点写
    // `const { result } = await ...` → result 恒为 undefined → 两个 UI 的
    // `if (!result)` 把**每次**检查都判成「检查更新失败」。
    // 纯函数层测再多也看不见这一层，所以守卫必须跨到调用点上。
    name: '调用点解构 checkForUpdate 的返回值（result 恒为 undefined → 永远「检查更新失败」）',
    file: ORCHESTRATOR_CALLER_OOBE,
    pairs: [['const result = await checkForUpdate({ channel: \'stable\' });', 'const { result } = await checkForUpdate({ channel: \'stable\' });']],
    expect: '不解构 checkForUpdate 的返回值',
  },
  {
    name: '设置面板解构 checkForUpdate 的返回值（同一处错误在第二个调用点）',
    file: ORCHESTRATOR_CALLER_SETTINGS,
    pairs: [['const result = await checkForUpdate({ channel: _update_channel() });', 'const { result } = await checkForUpdate({ channel: _update_channel() });']],
    expect: '不解构 checkForUpdate 的返回值',
  },
  {
    name: '返回值多包一层 result（形状又对不上了，且这次是反方向）',
    file: ORCHESTRATOR,
    pairs: [['  return resolve_update(tagRes.body, dist, build, { platform, arch: opts.arch || \'\', channel });', '  return { result: resolve_update(tagRes.body, dist, build, { platform, arch: opts.arch || \'\', channel }) };']],
    expect: '返回值里**没有** result 字段',
  },
  {
    name: '空通道的返回值被改成包一层（形状对不上）',
    file: ORCHESTRATOR,
    // ⚠️ 必须写成**语法合法**的补丁。第一版写成 `return { result: {`，
    // 对象少一个闭合花括号 → 模块 import 就炸 → 整个 harness 崩溃退出，
    // 一条 FAIL 都打不出来，变异测试只看到「变红了但没命中预期标签」。
    // 崩溃 ≠ 守卫生效：断言根本没跑。改成一个合法但语义错的属性。
    pairs: [['  if (probe === CHANNEL_PROBE_EMPTY) {\n    return {\n      has_update: false,', '  if (probe === CHANNEL_PROBE_EMPTY) {\n    return {\n      result: null,\n      has_update: false,']],
    expect: '空通道也没有 result 字段',
  },
  {
    name: 'inject seam 被摘掉（checkForUpdate 又跑不起来，真跑守卫随之全废）',
    file: ORCHESTRATOR,
    pairs: [['  const invoke = _ipc(opts);', '  const invoke = window.__TAURI__.core.invoke;']],
    expect: 'invoke 走注入缝',
  },
  {
    name: '构建身份改用 app_fetch_version 判定（Bata2 与正式版都是 0.3.0 → 横幅不出现、版本号显示 0.3.0）',
    file: ORCHESTRATOR_CALLER_SETTINGS,
    pairs: [["const info = await resolve_build_identity(invoke);", "const info = { version: await invoke('app_fetch_version'), tag: '', prerelease: false };"]],
    expect: '用 resolve_build_identity 判定通道',
  },
  {
    name: '版本号无条件显示 tag（正式版用户的版本号凭空多个 v 前缀）',
    file: ORCHESTRATOR_CALLER_SETTINGS,
    pairs: [['versionNumber.textContent = info?.prerelease ? (info.tag || v) : v;', 'versionNumber.textContent = info?.tag || v;']],
    expect: '预发布时版本号显示 tag',
  },
  {
    name: '版本号取反：正式版显示 tag、预发布显示 Cargo 版本（正好把两个都搞错）',
    file: ORCHESTRATOR_CALLER_SETTINGS,
    pairs: [['versionNumber.textContent = info?.prerelease ? (info.tag || v) : v;', 'versionNumber.textContent = info?.prerelease ? v : (info.tag || v);']],
    expect: '正式版仍显示 Cargo 版本',
  },
  {
    name: '正式版也显示横幅（所有用户都看到「预发布版」）',
    file: ORCHESTRATOR_CALLER_SETTINGS,
    pairs: [["                if (info?.prerelease) {\n                    const tagEl", "                if (true) {\n                    const tagEl"]],
    expect: '横幅显隐由 prerelease 决定',
  },
  {
    name: '构建身份查询失败时反而显示横幅（正式版用户看到「预发布版」）',
    file: ORCHESTRATOR_CALLER_SETTINGS,
    pairs: [["            console.warn('获取构建身份失败:', error);\n            if (banner) banner.style.display = 'none';", "            console.warn('获取构建身份失败:', error);\n            if (banner) banner.style.display = '';"]],
    expect: '查询失败时隐藏而不是显示',
  },
  {
    name: '构建身份被拆成两次查询（多一轮往返，且版本号与横幅可能读到不同结果）',
    file: ORCHESTRATOR_CALLER_SETTINGS,
    pairs: [["const info = await resolve_build_identity(invoke);", "const info = await resolve_build_identity(invoke);\n            await resolve_build_identity(invoke);"]],
    expect: '横幅与版本号共用同一次 IPC',
  },
  {
    // 位置守卫只能靠**真的把两处对调**来打破。横幅现在在 .sp-content 里，
    // 变异把它塞回侧栏 —— 症状是 220px 的导航里挤一条带版本号的横幅。
    // ⚠️ 两段补丁里都要写全当前的 data-i18n 键名。键名一改，这些锚点就静默失效
    // —— 表现为「补丁未落地」，很容易被误读成守卫写错。
    name: '横幅被塞回侧栏（220px 的导航里挤一条带版本号的横条）',
    file: PANEL,
    pairs: [[
      '<div class="sp-content">\n                        <div class="sp-prerelease-banner" id="prereleaseBanner" style="display:none;"><span class="sp-prerelease-banner-label" data-i18n="settings.prereleaseWarning">此版本可能会不稳定，请不要在正式环境中使用！！！</span><span class="sp-prerelease-banner-tag" id="prereleaseBannerTag"></span></div>\n                        <div class="sp-page" id="pageApp">',
      '<div class="sp-content">\n                        <div class="sp-page" id="pageApp">',
    ], [
      '<button class="sidebar-item" id="btnTheme"><span class="sp-btn-icon"><img data-icon="theme-icon" width="16" height="16" alt=""></span><span class="btn-text">主题</span></button>',
      '<button class="sidebar-item" id="btnTheme"><span class="sp-btn-icon"><img data-icon="theme-icon" width="16" height="16" alt=""></span><span class="btn-text">主题</span></button>\n                            <div class="sp-prerelease-banner" id="prereleaseBanner" style="display:none;"><span class="sp-prerelease-banner-label" data-i18n="settings.prereleaseWarning">此版本可能会不稳定，请不要在正式环境中使用！！！</span><span class="sp-prerelease-banner-tag" id="prereleaseBannerTag"></span></div>',
    ]],
    expect: '横幅在 .sp-content 内',
  },
  {
    name: '内容区里残留两份横幅（id 重复，getElementById 会取到排在前面的那个）',
    file: PANEL,
    pairs: [[
      '<div class="sp-content">',
      '<div class="sp-content"><div class="sp-prerelease-banner" id="prereleaseBanner" style="display:none;"><span class="sp-prerelease-banner-label" data-i18n="settings.prereleaseBadge">预发布版</span><span class="sp-prerelease-banner-tag" id="prereleaseBannerTag"></span></div>',
    ]],
    expect: '横幅只出现一次',
  },
  {
    name: 'build 缺失时乐观判有更新',
    pairs: [['  const current_semver = build?.semver || strip_tag_prefix(build?.tag || build?.version || \'\');', "  const current_semver = '0.0.1';"]],
    expect: 'build 缺失时保守判无更新',
  },
  {
    name: 'Client ID 填成服务端规范的平台 ID（/online 回 400、distribution 回空数组）',
    file: IDENTITY,
    pairs: [["export const SECTL_CLIENT_ID = '6a48ced10013cdd594f8';", "export const SECTL_CLIENT_ID = 'platform_9c8003bb30f77c70';"]],
    expect: 'Client ID 取值正确',
  },
  {
    name: 'API base 写错（所有请求打到别处）',
    file: IDENTITY,
    pairs: [["export const SECTL_API_BASE = 'https://appwrite.sectl.cn';", "export const SECTL_API_BASE = 'https://appwrite.example.com';"]],
    expect: 'API base',
  },
  {
    name: '项目 slug 写错（回退路径按 slug 过滤，会把整个项目判成"没找到"）',
    pairs: [["export const DISTRIBUTION_PROJECT_SLUG = 'ViewPDF';", "export const DISTRIBUTION_PROJECT_SLUG = 'viewpdf';"]],
    expect: '项目 slug',
  },
  {
    name: '版本解析对非数字段不再拒绝（把非法 tag 当合法版本比）',
    pairs: [['    if (!/^\\d+$/.test(parts[i])) return null;', '    if (false) return null;']],
    expect: '非数字返回 null',
  },
];

console.log('--- 变异测试：每个不变式被破坏时，harness 必须变红 ---');

{
  const dir = fresh_copy();
  const base = run(dir);
  report('基线（未变异）全绿', base.code === 0, base.code === 0 ? '' : base.failed.join(' | '));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}

for (const m of MUTATIONS) {
  const dir = fresh_copy();
  let thrown = null;
  try {
    apply(dir, m);
  } catch (e) {
    thrown = e.message;
  }
  if (thrown) {
    report(m.name, false, '补丁未落地: ' + thrown);
  } else {
    const r = run(dir);
    const caught = r.failed.some((f) => f.includes(m.expect));
    report(m.name, caught, caught ? '' : (r.code === 0
      ? 'harness 仍然全绿 —— 这条守卫抓不到该变异，等于没守'
      : '变红了但没命中预期标签: ' + r.failed.join(' | ')));
  }
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
