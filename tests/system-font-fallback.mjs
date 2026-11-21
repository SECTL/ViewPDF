// 复杂文字兼容模式（系统字体回退）的接线测试。
//
// 这个开关横跨 Rust 默认配置、设置面板、设置读写、启动回放、pdf.js 打开参数
// 与渲染线程门控 —— 任何一处断开都会静默回到「音符显示成方框」。
// 门控条件额外做一次真实求值，避免只靠正则看到注释里的同名字样。
import fs from 'node:fs';
import vm from 'node:vm';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);
const read = (p) => fs.readFileSync(p, 'utf8');
const count = (text, re) => (text.match(re) || []).length;

const rust = read('src-tauri/src/lib.rs');
const panel = read('src/modules/settings/settings-panel.js');
const settings = read('src/modules/settings/settings.js');
const init = read('src/init.js');
const main = read('src/main.js');
const reader = read('src/modules/pdf/document_reader.js');

console.log('--- Rust 默认配置 ---');
ok('Rust settings_defaults 含 systemFontFallback 且默认关闭',
  /"systemFontFallback":\s*false/.test(rust));

console.log('--- 设置面板 ---');
ok('面板里有 systemFontFallbackToggle',
  /id="systemFontFallbackToggle"/.test(panel));
ok('开关是原生 checkbox 且带 switch 属性',
  /type="checkbox" switch id="systemFontFallbackToggle"/.test(panel));
ok('label 用 for 关联到开关',
  /<label class="sp-setting-label" for="systemFontFallbackToggle"/.test(panel));
ok('开关带 data-i18n',
  /data-i18n="settings\.systemFontFallback"/.test(panel));
ok('提示文案带 data-i18n',
  /data-i18n="settings\.systemFontFallbackHint"/.test(panel));

console.log('--- 设置读写 ---');
ok('面板回显只认显式 true',
  /settings\.systemFontFallback === true/.test(settings));
ok('切换后落盘到同一键',
  /settings_save_all_local\(\{\s*systemFontFallback: systemFontFallbackToggle\.checked\s*\}\)/.test(settings));

console.log('--- 启动回放 ---');
ok('init.js 在打开文档前把值写入全局',
  /window\.__systemFontFallback = settings\.systemFontFallback === true/.test(init));
ok('回放发生在渲染档位回放下游不冲突（同一函数体内）',
  /window\.__systemFontFallback/.test(init) && /apply_perf_tier/.test(init));
ok('设置变更时同步全局值（本次会话新文档立即生效）',
  /if \(settings\.systemFontFallback !== undefined\) \{\s*window\.__systemFontFallback = settings\.systemFontFallback === true;/.test(main));

console.log('--- pdf.js 打开参数（检测元数据始终可用）---');
eq('阅读器打开与后台重载两处都传 useSystemFonts: true',
  count(main, /useSystemFonts:\s*true/g), 2);
eq('同样两处都传 fontExtraProperties: true',
  count(main, /fontExtraProperties:\s*true/g), 2);
ok('Word 转换路径仍保持旧口径（未被误改）',
  /wordPdfDoc = await pdfjsLib\.getDocument\(\{[\s\S]{0,400}?useSystemFonts: false/.test(main));

console.log('--- 自动检测 ---');
ok('检测函数存在且按页数上限扫描',
  /async function main_document_needs_system_font\(doc\)/.test(main) &&
  /FONT_FALLBACK_SCAN_PAGES = 3/.test(main));
ok('用 getTextContent 读取字体样式',
  /page\.getTextContent\(\{ disableNormalization: true \}\)/.test(main));
ok('识别 pdf.js 的系统字体替换标记',
  /styles\[name\]\?\.fontSubstitution/.test(main));
ok('识别字体解析失败兜底名',
  /\/\^InvalidPDFjsFont_\/\.test\(name\)/.test(main));
eq('文档打开后挂了询问（两处）',
  count(main, /main_ask_system_font_fallback\(/g), 3); // 1 定义 + 2 调用

console.log('--- 询问对话框与启用 ---');
ok('用原生 dialog + showModal',
  /document\.createElement\('dialog'\)/.test(main) && /dialog\.showModal\(\)/.test(main));
ok('同一文档只问一次（WeakSet 去重）',
  /_fontFallbackAskedFolders\.has\(folder\)/.test(main));
ok('启用时先同步内存标志（不等事件分发）',
  /window\.__systemFontFallback = true;[\s\S]{0,200}?invoke\('settings_save_all'/.test(main));
ok('启用后落盘到 systemFontFallback',
  /invoke\('settings_save_all', \{ settings: \{ systemFontFallback: true \} \}\)/.test(main));
ok('启用后广播 settings-changed',
  /emit\('settings-changed', \{ systemFontFallback: true \}\)/.test(main));
ok('启用后按当前档位清缓存并重渲染可见页',
  /reader\.apply_perf_tier\?\.\(reader\.render_perf_tier \|\| 'balanced'\)/.test(main));
ok('对话框样式在始终加载的 styles.css 里',
  /dialog\.font-fallback-dialog/.test(read('src/styles.css')));

console.log('--- 渲染线程门控 ---');
ok('渲染线程路径被兼容模式门控',
  /if \(!window\.__systemFontFallback\) \{/.test(reader));
const gateIdx = reader.indexOf('if (!window.__systemFontFallback) {');
const workerIdx = reader.indexOf('const worker_host = ', gateIdx);
ok('门控确实位于 worker_host 之前（不是死代码）',
  gateIdx !== -1 && workerIdx > gateIdx);

// 真跑一次门控条件：编译器/注释改名不会让守卫变瞎。
const gate = /if \((!window\.__systemFontFallback)\) \{/.exec(reader);
ok('能抽出布尔表达式', !!gate);
if (gate) {
  const cond = gate[1];
  const sandbox = { window: { __systemFontFallback: true } };
  eq('开启兼容模式 → 不走渲染线程', vm.runInNewContext(cond, sandbox), false);
  sandbox.window.__systemFontFallback = false;
  eq('默认 → 仍走渲染线程', vm.runInNewContext(cond, sandbox), true);
}

console.log('--- 9 个语言包 ---');
let missing = [];
for (const f of fs.readdirSync('src/locales').filter((x) => x.endsWith('.json'))) {
  const j = JSON.parse(read('src/locales/' + f));
  for (const k of ['systemFontFallback', 'systemFontFallbackHint',
                   'systemFontDetectTitle', 'systemFontDetectBody',
                   'systemFontDetectEnable', 'systemFontDetectLater']) {
    if (!j.settings?.[k]) missing.push(f + ':' + k);
  }
}
eq('全部语言包都带齐开关文案与询问文案', missing.join(','), '');

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
