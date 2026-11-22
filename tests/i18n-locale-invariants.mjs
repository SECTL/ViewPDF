// i18n / 9 个语言包的不变量。
//
// 为什么要单独一支：i18n 缺键、错占位符、切语言没落盘，全都是「不报错」的静默故障 ——
// 界面上要么显示字面 key，要么占位符永远不被替换，控制台最多一句 warn。
// 本文件做两类检查：
//   1) 9 个 locale JSON 的**键集 / 值类型 / 占位符**完全一致（静态结构）；
//   2) 把真正的 i18n.js 放进 node:vm 跑 —— 缺键回退、参数替换、切语言落盘 + document.lang。
//
// VP_LOCALES_DIR 让 i18n-locale-invariants-mutation.mjs 指向临时副本打补丁，
// 不碰真实工作区。i18n.js 本体也支持 VP_APP_SRC 覆写（与其他 harness 同一约定）。
//
// 单独跑：node tests/i18n-locale-invariants.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = process.env.VP_APP_SRC || path.join(ROOT, 'src');
const LOCALES = process.env.VP_LOCALES_DIR || path.join(SRC, 'locales');
const LOCALES_FILES = ['de-DE', 'en-US', 'es-ES', 'fr-FR', 'ja-JP', 'ko-KR', 'ru-RU', 'zh-CN', 'zh-TW'];

let pass = 0, fail = 0;
const str = (v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());
function eq(label, got, want, detail) {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + str(got) + ' want=' + str(want) + (detail && !ok ? '\n         ' + detail : ''));
}
function ok(label, got, detail) { eq(label, !!got, true, detail); }

// 源码文本断言前必须剥注释：这里的注释里直接点名了标识符，
// 不剥的话「删掉这行代码」的变异会被注释里的同名文字顶住。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function flatten(obj, prefix = '', out = {}) {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
const tokens = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

// ── 1. 语言包结构 ────────────────────────────────────────────────
console.log('--- 语言包结构（9 个 locale 必须逐键对齐）---');
let names = [];
try {
  names = fs.readdirSync(LOCALES).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
} catch (e) {
  fail++;
  console.log('FAIL  读取语言包目录失败: ' + e.message);
}
eq('语言包共 9 个', names.length, 9);
eq('语言包文件名固定', names.join(','), LOCALES_FILES.join(','));

const parsed = {};
const flatSets = {};
for (const n of names) {
  const p = path.join(LOCALES, n + '.json');
  try {
    parsed[n] = JSON.parse(fs.readFileSync(p, 'utf8'));
    flatSets[n] = flatten(parsed[n]);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + n + '.json 无法解析: ' + e.message);
  }
}
eq('9 个语言包全部解析成功', Object.keys(parsed).length, 9);

if (Object.keys(flatSets).length === LOCALES_FILES.length) {
  const ref = LOCALES_FILES[0];
  const base = Object.keys(flatSets[ref]).sort();
  console.log('  基准语言包 ' + ref + '：' + base.length + ' 个叶子键');
  eq('基准语言包非空', base.length > 0, true);

  // 键集（键名被删、被改名、被加错，format_translate 都会回退成字面 key）
  for (const n of LOCALES_FILES) {
    const keys = Object.keys(flatSets[n]);
    const missing = base.filter((k) => !(k in flatSets[n]));
    const extra = keys.filter((k) => !base.includes(k));
    eq(n + ' 键集与基准完全一致', missing.length + extra.length, 0,
      '缺=' + missing.slice(0, 8).join(',') + ' 多=' + extra.slice(0, 8).join(','));
  }

  // 值必须是非空字符串：数字/数组/null 在 format_translate 里都会回退成 key
  for (const n of LOCALES_FILES) {
    const bad = Object.entries(flatSets[n]).filter(([, v]) => typeof v !== 'string' || v.length === 0).map(([k]) => k);
    eq(n + ' 所有叶子值是非空字符串', bad.length, 0, bad.slice(0, 8).join(','));
  }

  // 占位符集合必须一致：调用方 format_translate(key, {error:...}) 只替换它知道的那些。
  // 某个语言少写一个 {error}，用户就永远看到 "{error}" 字面量，而程序没有任何报错。
  const placeholderKeys = base.filter((k) => tokens(flatSets[ref][k]));
  const badTokens = [];
  for (const k of placeholderKeys) {
    const want = tokens(flatSets[ref][k]);
    for (const n of LOCALES_FILES.slice(1)) {
      if (tokens(flatSets[n][k]) !== want) badTokens.push(n + '.' + k + ' [' + tokens(flatSets[n][k]) + '] want [' + want + ']');
    }
  }
  eq('带 {param} 的键占位符在 9 个包中一致（' + placeholderKeys.length + ' 个键）', badTokens.length, 0,
    badTokens.slice(0, 8).join('\n         '));

  // 调用 settings.deleteThemeError 时只替换 {error}（settings.js 里的真实写法）
  eq('settings.deleteThemeError 用 {error} 占位符（调用方只替换它）',
    tokens(flatSets['en-US']['settings.deleteThemeError']), 'error');
}

// ── 2. 真跑 i18n.js ─────────────────────────────────────────────
console.log('\n--- format_translate / update_locale（node:vm 执行真实 i18n.js）---');
const i18nSrc = fs.readFileSync(path.join(SRC, 'modules', 'i18n.js'), 'utf8');
const stripped = stripComments(i18nSrc);
ok('源码含缺失键回退 return key', /return\s+key\s*;/.test(stripped));
ok('源码含缺失键 warn', /console\.warn\s*\(\s*`Translation not found/.test(stripped));

function defaultFetch(url) {
  const m = /^locales\/([\w-]+)\.json$/.exec(String(url));
  if (m && parsed[m[1]]) return Promise.resolve({ ok: true, json: async () => parsed[m[1]] });
  return Promise.resolve({ ok: false, status: 404 });
}
function boot({ fetchImpl = defaultFetch, invoke, savedLocale, doc } = {}) {
  const store = new Map();
  if (savedLocale !== undefined) store.set('language', savedLocale);
  const warns = [];
  const invokeCalls = [];
  const sandbox = {
    window: { __TAURI__: invoke ? { core: { invoke: async (cmd, args) => { invokeCalls.push([cmd, args]); return invoke(cmd, args); } } } : undefined },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    fetch: fetchImpl,
    document: doc || { querySelectorAll: () => [], documentElement: { lang: '' } },
    console: { warn: (...a) => warns.push(a.join(' ')), error: () => {}, log: () => {} },
  };
  vm.runInNewContext(i18nSrc, sandbox, { filename: 'i18n.js' });
  return { i18n: sandbox.window.i18n, sandbox, warns, invokeCalls, store };
}
function settle(promise, label, ms = 1500) {
  return Promise.race([
    Promise.resolve(promise).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
    new Promise((res) => setTimeout(() => res({ ok: false, e: new Error('timeout: ' + label) }), ms)),
  ]);
}

{
  const { i18n, warns } = boot();
  ok('window.i18n 已注册', i18n && typeof i18n.format_translate === 'function');

  i18n.messages = { a: { b: 'B', n: 42, arr: [1, 2], hi: 'Hi {name}, you have {n} msg {name}' } };
  eq('存在的键返回翻译值', i18n.format_translate('a.b'), 'B');
  warns.length = 0;
  eq('顶层缺失键回退为 key 本身', i18n.format_translate('missing.key'), 'missing.key');
  ok('缺失键会 console.warn（便于定位）', warns.some((w) => w.includes('missing.key')));
  eq('中间段缺失回退为 key 本身', i18n.format_translate('a.noSuch.deep'), 'a.noSuch.deep');
  eq('字符串叶子后多走一段也回退', i18n.format_translate('a.b.extra'), 'a.b.extra');
  eq('数字叶子回退为 key 本身', i18n.format_translate('a.n'), 'a.n');
  eq('数组叶子回退为 key 本身', i18n.format_translate('a.arr'), 'a.arr');
  eq('参数替换', i18n.format_translate('a.hi', { name: 'A', n: 3 }), 'Hi A, you have 3 msg A');
  eq('未提供参数保留 {param} 字面量', i18n.format_translate('a.hi', { name: 'A' }), 'Hi A, you have {n} msg A');
}

// 语言切换：加载 + 渲染 + 两处持久化 + document.lang，缺一不可。
{
  const el = { getAttribute: (a) => (a === 'data-i18n' ? 'common.confirm' : null), textContent: '', placeholder: '', title: '' };
  const doc = {
    querySelectorAll: (sel) => (sel === '[data-i18n]' ? [el] : []),
    documentElement: { lang: '' },
  };
  const invoke = async (cmd, args) => {
    if (cmd === 'settings_save_all') return { ok: true };
    if (cmd === 'settings_fetch_all') return { settings: { language: 'fr-FR' } };
    throw new Error('unexpected invoke ' + cmd);
  };
  const ctx = boot({ invoke, doc });
  const r1 = await settle(ctx.i18n.update_locale('de-DE'), 'update_locale');
  ok('update_locale 正常结算', r1.ok, r1.ok ? '' : String(r1.e));
  if (r1.ok) {
    eq('切换后 current_locale', ctx.i18n.current_locale, 'de-DE');
    eq('切换后 messages 已换成目标语言', ctx.i18n.format_translate('common.confirm'), parsed['de-DE'].common.confirm);
    eq('data-i18n 节点被重渲染', el.textContent, parsed['de-DE'].common.confirm);
    eq('document.documentElement.lang 已更新', doc.documentElement.lang, 'de-DE');
    eq('localStorage.language 已更新', ctx.store.get('language'), 'de-DE');
    const save = ctx.invokeCalls.find(([c]) => c === 'settings_save_all');
    ok('settings_save_all 已调用', !!save);
    eq('持久化写入的是目标语言', save && save[1] && save[1].settings && save[1].settings.language, 'de-DE');
  }

  const saved = await settle(ctx.i18n.fetch_saved_locale(), 'fetch_saved_locale');
  ok('fetch_saved_locale 正常结算', saved.ok, saved.ok ? '' : String(saved.e));
  if (saved.ok) eq('从配置读到已保存语言', saved.v, 'fr-FR');

  const noTauri = boot({ savedLocale: 'ja-JP' });
  const r2 = await settle(noTauri.i18n.fetch_saved_locale(), 'fetch_saved_locale(no tauri)');
  ok('无 Tauri 时结算', r2.ok, r2.ok ? '' : String(r2.e));
  if (r2.ok) eq('无 Tauri 时回落到 localStorage', r2.v, 'ja-JP');
}

// 加载失败必须回落到 zh-CN，而不是把 messages 留成上一次的旧语言。
{
  const ctx = boot({
    fetchImpl: (url) => (String(url).includes('xx-XX')
      ? Promise.resolve({ ok: false })
      : defaultFetch(url)),
  });
  const r = await settle(ctx.i18n.load_messages('xx-XX'), 'load_messages fallback');
  ok('load_messages 失败路径正常结算', r.ok, r.ok ? '' : String(r.e));
  if (r.ok) {
    eq('加载失败回落到 zh-CN', ctx.i18n.current_locale, 'zh-CN');
    eq('回落后的 messages 确实是 zh-CN', ctx.i18n.format_translate('common.confirm'), parsed['zh-CN'].common.confirm);
  }
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
