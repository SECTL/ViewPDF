// 剩余前端模块的不变量：renderMarkdown / build-identity / settings-panel /
// telemetry 辅助模块 / pdf 加载与页面管理 / 维护线程。
//
// 口径：静态结构断言（剥注释后匹配）+ node:vm / 动态 import 真跑关键函数。
// 不扫描整个 src/ —— 只读本文件点名的具体文件，避免读到别的 agent 半改状态。
// 这些模块不配变异（硬约束：只允许对 locale JSON 做变异），所以守卫本身要写成
// 一旦接线改错就会红的形态，而不是「文件里出现过某个字符串」。
//
// 单独跑：node tests/module-invariants.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = process.env.VP_APP_SRC || path.join(ROOT, 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const imp = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

let pass = 0, fail = 0;
const str = (v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());
function eq(label, got, want, detail) {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + str(got) + ' want=' + str(want) + (detail && !ok ? '\n         ' + detail : ''));
}
function ok(label, got, detail) { eq(label, !!got, true, detail); }

// 源码文本断言前剥注释。这里的注释直接点名 app_fetch_build_info 等标识符，
// 不剥的话「删掉唯一调用点」的改动会被注释本身顶住。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function settle(promise, label, ms = 1500) {
  return Promise.race([
    Promise.resolve(promise).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    new Promise((res) => setTimeout(() => res({ ok: false, e: new Error('timeout: ' + label) }), ms)),
  ]);
}

// build-identity.js 在 import 时按 typeof window 决定挂不挂 ViewPDFDev（ESM 只求值一次）
globalThis.window = globalThis.window || {};

// ── 1. renderMarkdown.js ────────────────────────────────────────
console.log('--- renderMarkdown：渲染结构 + XSS 防护 ---');
{
  const src = read('modules/renderMarkdown.js');
  const sandbox = { URL };
  vm.runInNewContext(src, sandbox, { filename: 'renderMarkdown.js' });
  const { renderMarkdownSimple, escapeHtml, safeHref } = sandbox;

  eq('空输入渲染为固定占位', renderMarkdownSimple(''), '<p class="changelog-empty">暂无更新说明</p>');
  ok('1~2 级标题 → h3', renderMarkdownSimple('# Title') === '<h3>Title</h3>\n');
  ok('3 级标题 → h4', renderMarkdownSimple('### Title') === '<h4>Title</h4>\n');
  ok('无序列表结构闭合', /<ul>\n<li>one<\/li>\n<\/ul>\n/.test(renderMarkdownSimple('- one')));
  ok('有序列表结构闭合', /<ol>\n<li>one<\/li>\n<\/ol>\n/.test(renderMarkdownSimple('1. one')));
  ok('粗体', renderMarkdownSimple('**b**').includes('<strong>b</strong>'));
  ok('行内代码', renderMarkdownSimple('`c`').includes('<code>c</code>'));

  const evil = renderMarkdownSimple('<script>alert(1)</script>\n[x](javascript:alert(1))\n[y](https://example.com/a?b=1&c=2)');
  ok('<script> 被转义而非原样输出', evil.includes('&lt;script&gt;') && !evil.includes('<script>'));
  ok('javascript: 链接被降为 #', evil.includes('href="#"') && !evil.includes('javascript:'));
  ok('正常 https 链接保留', evil.includes('href="https://example.com/a?b=1&amp;c=2"') || evil.includes('href="https://example.com/a?b=1&c=2"'));
  ok('外链固定 noopener noreferrer', evil.includes('rel="noopener noreferrer"') && evil.includes('target="_blank"'));
  eq('data: 协议被拦', safeHref('data:text/html;base64,xxx'), '#');
  eq('空 href → #', safeHref(''), '#');
  eq('escapeHtml 转义双引号', escapeHtml('a"b'), 'a&quot;b');

  const stripped = stripComments(src);
  ok('协议白名单只放 http/https', /\[\s*'http:',\s*'https:'\s*\]/.test(stripped));
  ok('href 在转义后还原 &amp; 再过白名单', stripped.includes("href.replace(/&amp;/g, '&')"));
  ok('escapeHtml 覆盖 &', stripped.includes("replace(/&/g, '&amp;')"));
}

// ── 2. build-identity.js ────────────────────────────────────────
console.log('\n--- build-identity：唯一读取口 + 仅内存覆盖 ---');
{
  const bi = await imp('modules/build-identity.js');
  const dev = globalThis.window.ViewPDFDev;
  ok('window.ViewPDFDev 已注册', dev && typeof dev === 'object');
  ok('四个开发入口齐全', ['setVersion', 'clearVersion', 'getVersion', 'isOverridden'].every((k) => typeof dev[k] === 'function'));

  dev.clearVersion();
  eq('初始未覆盖', dev.isOverridden(), false);
  const beta = dev.setVersion('v0.3.1-Bata3');
  eq('覆盖形状 = Rust AppBuildInfo 四字段', Object.keys(beta).sort().join(','), ['version', 'tag', 'semver', 'prerelease'].sort().join(','));
  eq('version 是核心版本（与 Cargo 对齐）', beta.version, '0.3.1');
  eq('tag 保留原文', beta.tag, 'v0.3.1-Bata3');
  eq('semver 剥 v 前缀', beta.semver, '0.3.1-Bata3');
  eq('预发布标记', beta.prerelease, true);
  eq('覆盖已生效', dev.isOverridden(), true);

  const stable = dev.setVersion('0.3.0');
  eq('无 v 前缀时 tag 补 v', stable.tag, 'v0.3.0');
  eq('正式版 prerelease=false', stable.prerelease, false);
  eq('正式版 version', stable.version, '0.3.0');

  let threw = false;
  try { dev.setVersion('Bata3'); } catch (_) { threw = true; }
  eq('非法输入抛错（不静默当正式版）', threw, true);
  eq('非法输入不改变原覆盖', dev.getVersion().tag, 'v0.3.0');

  const calls = [];
  const r = await settle(bi.resolve_build_identity(async (cmd) => { calls.push(cmd); return { tag: 'real' }; }), 'resolve with override');
  ok('resolve 正常结算', r.ok, r.ok ? '' : String(r.e));
  if (r.ok) {
    eq('有覆盖时不调 Tauri', calls.length, 0);
    eq('返回覆盖身份', r.v.tag, 'v0.3.0');
    r.v.tag = 'MUTATED';
    eq('返回的是副本，外面改不动内部状态', dev.getVersion().tag, 'v0.3.0');
  }
  dev.clearVersion();
  eq('clearVersion 后未覆盖', dev.isOverridden(), false);
  const r2 = await settle(bi.resolve_build_identity(async (cmd) => { calls.push(cmd); return { version: '1.2.3', tag: 'v1.2.3', semver: '1.2.3', prerelease: false }; }), 'resolve real');
  ok('resolve 正常路径结算', r2.ok, r2.ok ? '' : String(r2.e));
  if (r2.ok) {
    eq('无覆盖时唯一一次 invoke', calls.slice(-1).join(','), 'app_fetch_build_info');
    eq('Rust 身份原样透传', r2.v.tag, 'v1.2.3');
  }

  const biSrc = stripComments(read('modules/build-identity.js'));
  ok('覆盖只存内存（无 localStorage）', !/\blocalStorage\b/.test(biSrc));
  ok('覆盖不落 config（无 settings_save / writeTextFile）', !/settings_save|writeTextFile|config\.json/.test(biSrc));
  eq('app_fetch_build_info 全文件只有一个调用点', (biSrc.match(/invoke\(\s*['"]app_fetch_build_info['"]/g) || []).length, 1);

  for (const f of ['modules/settings/settings.js', 'modules/update/update.js', 'modules/telemetry/telemetry-api.js']) {
    const s = stripComments(read(f));
    ok(f + ' 不直接 invoke app_fetch_build_info', !/invoke\(\s*['"]app_fetch_build_info['"]/.test(s));
  }
  const api = stripComments(read('modules/telemetry/telemetry-api.js'));
  ok('遥测仍走 app_fetch_version（不被开发覆盖污染）', /invoke\(\s*['"]app_fetch_version['"]/.test(api));
  ok('遥测不读 build_info', !/app_fetch_build_info/.test(api));

  const lib = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const m = /struct\s+AppBuildInfo\s*\{([\s\S]*?)\}/.exec(lib);
  ok('Rust 侧 AppBuildInfo 存在', !!m);
  if (m) {
    const fields = [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]).sort().join(',');
    eq('Rust 字段与前端覆盖形状一致', fields, ['version', 'tag', 'semver', 'prerelease'].sort().join(','));
  }
}

// ── 3. settings-panel.js ────────────────────────────────────────
console.log('\n--- settings-panel：模板结构 + 危险 innerHTML 使用点 ---');
{
  const panel = await imp('modules/settings/settings-panel.js');
  const html = panel.SETTINGS_PANEL_HTML;
  ok('导出 markup 模板字符串', typeof html === 'string' && html.length > 1000);
  for (const id of [
    'settingsPanel', 'pageApp', 'pageCanvas', 'pageDocReader', 'pageTheme', 'pageStorage', 'pageAbout', 'pageUpdate',
    'modalOverlay', 'restartModal', 'renderPerfTierGroup', 'renderPerfTierHint',
    'macosTitleBarToggle', 'toolbarTextToggle', 'moveCursorIconToggle', 'fullscreenButtonToggle',
  ]) ok('模板含 #' + id, html.includes('id="' + id + '"'));

  // 档位提示由 JS 单独写；挂 data-i18n 会被 render_page_texts 覆盖成空
  const hintTag = (html.match(/<[^>]*id="renderPerfTierHint"[^>]*>/) || [''])[0];
  ok('#renderPerfTierHint 没有 data-i18n', !!hintTag && !hintTag.includes('data-i18n'));

  const localeCodes = fs.readdirSync(path.join(SRC, 'locales')).filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, '')).sort().join(',');
  const selectCodes = [...new Set([...html.matchAll(/data-value="([a-z]{2}-[A-Z]{2})"/g)].map((m) => m[1]))].sort().join(',');
  eq('语言下拉的 9 个值与 locale 文件一一对应', selectCodes, localeCodes);

  for (const f of ['modules/settings/settings-panel.js', 'modules/settings/settings.js']) {
    const s = stripComments(read(f));
    ok(f + ' 无 innerHTML/outerHTML/insertAdjacentHTML/document.write',
      !/innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(s));
  }
  const ss = stripComments(read('modules/settings/settings.js'));
  ok('sanitizer 第一档：原生 setHTML', /\.setHTML\s*\(/.test(ss));
  ok('sanitizer 第二档：DOMPurify', /DOMPurify\.sanitize/.test(ss));
  ok('sanitizer 第三档：DOMParser 白名单', /settings_sanitize_fragment/.test(ss));
  ok('落 DOM 用 replaceChildren（不经 innerHTML）', /replaceChildren\s*\(/.test(ss));
  ok('更新说明渲染点都先过 sanitize_html（至少两处）', (ss.match(/sanitize_html\(_upd\.notes,\s*_render_changelog/g) || []).length >= 2);
}

// ── 4. telemetry 辅助模块 ───────────────────────────────────────
console.log('\n--- telemetry：身份单一真源 / geo 翻译 / 配置边界 ---');
{
  const CLIENT = '6a48ced10013cdd594f8';
  const PLATFORM = 'platform_9c8003bb30f77c70';
  const ID_FILES = [
    'modules/sectl-client.js', 'modules/telemetry/telemetry-config.js',
    'modules/telemetry/telemetry-api.js', 'modules/telemetry/telemetry-identity.js',
    'modules/telemetry/telemetry-geo.js', 'modules/telemetry/telemetry-geo-translate.js',
    'modules/update/update-resolve.js', 'modules/update/update.js',
    'modules/settings/settings.js', 'modules/build-identity.js',
  ];
  const clientHits = [];
  for (const f of ID_FILES) {
    const s = stripComments(read(f));
    if (s.includes(CLIENT)) clientHits.push(f);
    ok(f + ' 不含平台 ID 字面量', !s.includes(PLATFORM));
  }
  eq('Client ID 只出现在 sectl-client.js', clientHits.join(','), 'modules/sectl-client.js');

  const sectl = await imp('modules/sectl-client.js');
  eq('SECTL_CLIENT_ID 取值', sectl.SECTL_CLIENT_ID, CLIENT);
  eq('SECTL_API_BASE 取值', sectl.SECTL_API_BASE, 'https://appwrite.sectl.cn');

  const cfg = await imp('modules/telemetry/telemetry-config.js');
  eq('心跳周期 4 分钟', cfg.HEARTBEAT_INTERVAL_MS, 4 * 60 * 1000);
  ok('心跳周期对 5 分钟在线窗口留 ≥20% 余量', cfg.HEARTBEAT_INTERVAL_MS <= 5 * 60 * 1000 * 0.8);
  eq('geo 缓存 30 天', cfg.GEO_CACHE_TTL, 30 * 24 * 60 * 60 * 1000);
  eq('geo API host', new URL(cfg.GEO_API_URL).hostname, 'freeipapi.com');
  const lib = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  ok('geo host 已登记进 Rust 白名单', lib.includes('"freeipapi.com"'));

  const tr = await imp('modules/telemetry/telemetry-geo-translate.js');
  eq('国家翻译', tr.translateRegion('China', 'country'), '中国');
  eq('省份翻译', tr.translateRegion('Beijing', 'province'), '北京');
  eq('城市翻译', tr.translateRegion('Shenzhen', 'city'), '深圳');
  eq('未知地区保留原文', tr.translateRegion('Atlantis', 'city'), 'Atlantis');
  eq('空名字 → 未知', tr.translateRegion('', 'country'), '未知');
  const g = tr.translateGeo({ ip: '1.2.3.4', country_name: 'United States', region: 'California', city: 'Atlantis', district: null });
  eq('country 翻译', g.country_name, '美国');
  eq('district 缺省时用 city 兜底', g.district, 'Atlantis');
  eq('ip 原样', g.ip, '1.2.3.4');

  const geo = await imp('modules/telemetry/telemetry-geo.js');
  const split = geo.splitCityDistrict('Jinrongjie (Xicheng District)');
  eq('freeipapi 括号拆分：city', split.city, 'Jinrongjie');
  eq('freeipapi 括号拆分：district', split.district, 'Xicheng District');
  eq('无括号时 district=null', geo.splitCityDistrict('Berlin').district, null);
  eq('空输入 city=null', geo.splitCityDistrict('').city, null);

  // telemetry-identity 是纯模块（无 import），去掉 export 后可在 vm 里多开几份跑不同场景
  const idClassic = read('modules/telemetry/telemetry-identity.js').replace(/^export\s+/gm, '');
  function bootIdentity(invoke, platform) {
    const sandbox = {
      window: { __TAURI__: invoke ? { core: { invoke } } : undefined },
      navigator: { userAgentData: platform ? { platform } : undefined, platform: platform || '' },
      crypto: { randomUUID: () => 'session-uuid-1' },
      console: { warn: () => {}, error: () => {}, log: () => {} },
    };
    vm.runInNewContext(idClassic, sandbox, { filename: 'telemetry-identity.js' });
    return sandbox;
  }
  const noTauri = bootIdentity(null, 'Win32');
  const i0 = await settle(noTauri.getInstallUUID(), 'getInstallUUID(no tauri)');
  ok('无 Tauri 时结算', i0.ok, i0.ok ? '' : String(i0.e));
  if (i0.ok) eq('无 Tauri 不生成持久 ID', i0.v, null);

  const withTauri = bootIdentity(async (cmd) => (cmd === 'get_device_uuid' ? 'uuid-from-rust' : 'Win32'), 'Win32');
  const i1 = await settle(withTauri.getInstallUUID(), 'getInstallUUID(rust)');
  ok('有 Tauri 时结算', i1.ok, i1.ok ? '' : String(i1.e));
  if (i1.ok) eq('优先用 Rust 持久化 UUID', i1.v, 'uuid-from-rust');
  const d1 = await settle(withTauri.getDeviceType(), 'getDeviceType(win)');
  ok('getDeviceType 结算', d1.ok, d1.ok ? '' : String(d1.e));
  if (d1.ok) eq('Windows → windows-desktop', d1.v, 'windows-desktop');

  const degraded = bootIdentity(async () => { throw new Error('no command'); }, 'Linux x86_64');
  const i2 = await settle(degraded.getInstallUUID(), 'getInstallUUID(fallback)');
  ok('IPC 失败时结算', i2.ok, i2.ok ? '' : String(i2.e));
  if (i2.ok) eq('IPC 失败回落会话级 id（不写 localStorage）', i2.v, 'session-uuid-1');
  const i3 = await settle(degraded.getInstallUUID(), 'getInstallUUID(fallback2)');
  ok('再次读取正常结算', i3.ok, i3.ok ? '' : String(i3.e));
  if (i3.ok) eq('会话级 id 进程内稳定', i3.v, 'session-uuid-1');
  const d2 = await settle(degraded.getDeviceType(), 'getDeviceType(linux)');
  ok('getDeviceType(linux) 结算', d2.ok, d2.ok ? '' : String(d2.e));
  if (d2.ok) eq('Linux → linux-desktop', d2.v, 'linux-desktop');
  ok('identity 模块不写 localStorage', !/\blocalStorage\b/.test(stripComments(read('modules/telemetry/telemetry-identity.js'))));
}

// ── 5. pdf 加载 / 页面管理 / 维护线程 ───────────────────────────
console.log('\n--- pdf：加载器 / 页面管理 / 维护线程协议 ---');
{
  const docEl = { _t: '', set textContent(v) { this._t = v; }, get textContent() { return this._t; } };
  globalThis.document = { getElementById: (id) => (id === 'loadingMessage' ? docEl : null) };
  globalThis.window.pdfjsLib = { GlobalWorkerOptions: {}, VerbosityLevel: { ERRORS: 1 } };
  globalThis.window.i18n = { format_translate: (k, p) => k + ':' + p.current + '/' + p.total };

  const dl = await imp('modules/pdf/document_loader.js');
  eq('init_pdfjs 成功', dl.init_pdfjs(), true);
  eq('workerSrc 指向本地 worker', globalThis.window.pdfjsLib.GlobalWorkerOptions.workerSrc, 'modules/pdf/pdf.worker.min.mjs');
  eq('verbosity 设为 ERRORS', globalThis.window.pdfjsLib.verbosity, 1);
  ok('资源基址以 / 结尾', dl.get_pdfjs_assets_base().endsWith('/'));

  let cleaned = 0;
  const pdf = { getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }), cleanup: () => { cleaned++; } }) };
  const pi = await settle(dl.get_pdf_page_info(pdf, 2, 7), 'get_pdf_page_info');
  ok('get_pdf_page_info 结算', pi.ok, pi.ok ? '' : String(pi.e));
  if (pi.ok) {
    eq('sourceId 由文档号+页码组成', pi.v.sourceId, 'doc-7-2');
    eq('只取页尺寸不做栅格化', pi.v.width, 600);
    eq('renderMode', pi.v.renderMode, 'pdfjs');
    eq('full/thumbnail 留空', pi.v.full === null && pi.v.thumbnail === null, true);
    eq('page.cleanup 被调用', cleaned, 1);
  }
  const pi2 = await settle(dl.get_pdf_page_info(pdf, 2, null), 'get_pdf_page_info(no doc)');
  ok('无文档号结算', pi2.ok, pi2.ok ? '' : String(pi2.e));
  if (pi2.ok) eq('doc_number=null 时 sourceId=null', pi2.v.sourceId, null);

  const requested = [];
  const pdf2 = { getPage: async (n) => { requested.push(n); return { getViewport: () => ({ width: 10, height: 20 }), cleanup() {} }; } };
  const rp = await settle(dl.render_pdf_pages_lazy(pdf2, 10, 3, 4), 'render_pdf_pages_lazy');
  ok('render_pdf_pages_lazy 结算', rp.ok, rp.ok ? '' : String(rp.e));
  if (rp.ok) {
    eq('10 页全部建元数据', rp.v.length, 10);
    eq('每页恰好请求一次', requested.join(','), Array.from({ length: 10 }, (_, i) => i + 1).join(','));
    eq('pageNum 连续', rp.v[9].pageNum, 10);
    eq('进度使用 i18n 文案', docEl.textContent, 'loading.processingPage:10/10');
  }

  const drp = await imp('modules/pdf/document_reader_page.js');
  const mgr = new drp.DocumentReaderPageManager();
  mgr.init_from_folder_pages([
    { full: 'blob:a', thumbnail: 'blob:t', width: 200, height: 100, pageNum: 3, renderMode: 'pdfjs' },
    { full: 'blob:b' },
  ]);
  eq('页面数', mgr.get_page_count(), 2);
  eq('初始页', mgr.current_index, 0);
  eq('thumbnail 缺失时回落 full', mgr.pages_list[1].thumbnail_url, 'blob:b');
  eq('renderMode 缺省为 image', mgr.pages_list[1].render_mode, 'image');
  eq('aspect_ratio 由尺寸算出', mgr.pages_list[0].aspect_ratio, 2);
  eq('越界切页被拒', mgr.switch_page(9), false);
  eq('切到同页被拒', mgr.switch_page(0), false);
  eq('正常切页', mgr.switch_page(1), true);
  eq('nav_prev', mgr.nav_prev(), true);
  eq('第一页 nav_prev 被拒', mgr.nav_prev(), false);
  eq('nav_next', mgr.nav_next(), true);
  mgr.destroy();
  eq('destroy 清空页表', mgr.get_page_count(), 0);
  eq('destroy 重置 current_index', mgr.current_index, -1);

  // worker 协议：id 回显 + 串行处理 + 单条失败不崩
  const posted = [];
  let fatalHandler = null;
  const mwSandbox = {
    self: {
      onmessage: null,
      addEventListener: (type, fn) => { if (type === 'error') fatalHandler = fn; },
      postMessage: (m) => posted.push(m),
    },
  };
  vm.runInNewContext(read('modules/pdf/maintenance-worker.js'), mwSandbox, { filename: 'maintenance-worker.js' });
  const post = (data) => mwSandbox.self.onmessage({ data });
  post({ type: 'stringify', id: 7, data: { a: 1 } });
  eq('stringify 回包内容', posted.at(-1).json, '{"a":1}');
  eq('id 原样回显', posted.at(-1).id, 7);
  post({ type: 'parse', id: 8, json: '{"b":2}' });
  eq('parse 回包', posted.at(-1).data.b, 2);
  post({ type: 'ping', id: 9 });
  eq('ping → pong', posted.at(-1).type, 'pong');
  post({ type: 'wat', id: 10 });
  eq('未知类型 → error', posted.at(-1).type, 'error');
  post({ type: 'parse', id: 11, json: '{bad' });
  eq('非法 JSON → error 不崩', posted.at(-1).type, 'error');
  const beforeNull = posted.length;
  post(null);
  eq('非对象消息被忽略', posted.length, beforeNull);
  ok('注册了致命错误兜底监听', typeof fatalHandler === 'function');

  // 宿主：id 配对 + 致命错误拒绝所有在途请求
  class FakeWorker {
    constructor() { this.sent = []; FakeWorker.last = this; }
    postMessage(m) { this.sent.push(m); }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = FakeWorker;
  const hostMod = await imp('modules/pdf/maintenance-worker-host.js');
  const h = new hostMod.MaintenanceWorkerHost();
  eq('有 Worker 时 available=true', h.available, true);
  const p = h.stringify({ a: 1 });
  const req = FakeWorker.last.sent[0];
  eq('请求 type', req.type, 'stringify');
  ok('请求带自增 id', typeof req.id === 'number');
  h._on_message({ type: 'stringify-done', id: req.id, json: '{"a":1}' });
  const pr = await settle(p, 'host stringify');
  ok('host stringify 结算', pr.ok, pr.ok ? '' : String(pr.e));
  if (pr.ok) eq('按 id 配对到正确 resolve', pr.v, '{"a":1}');

  const h2 = new hostMod.MaintenanceWorkerHost();
  const p2 = h2.parse('{}');
  h2._on_worker_down('boom');
  const pr2 = await settle(p2, 'host fatal');
  eq('致命错误拒绝在途请求', pr2.ok, false);
  eq('致命错误后 available=false', h2.available, false);
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
