// 高内存模式回归守卫：内存充裕的电脑主动开启后，预加载/预挂载/缓存窗口放大。
// 默认必须关闭；开关经设置面板 → settings.js → init/main → apply_perf_tier 全链路接通。
import fs from 'node:fs';

const RS = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const DR = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');
const PANEL = fs.readFileSync('src/modules/settings/settings-panel.js', 'utf8');
const SET = fs.readFileSync('src/modules/settings/settings.js', 'utf8');
const INIT = fs.readFileSync('src/init.js', 'utf8');
const MAIN = fs.readFileSync('src/main.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

console.log('--- 默认关闭（Rust）---');
ok('settings_defaults 含 highMemoryMode 且默认 false',
  /"highMemoryMode":\s*false/.test(RS));

console.log('--- 设置面板 ---');
ok('面板有 highMemoryModeToggle', /id="highMemoryModeToggle"/.test(PANEL));
ok('开关是原生 checkbox + switch',
  /type="checkbox" switch id="highMemoryModeToggle"/.test(PANEL));
ok('label 用 for 关联',
  /<label class="sp-setting-label" for="highMemoryModeToggle"/.test(PANEL));
ok('带 data-i18n 文案与提示',
  /data-i18n="settings\.highMemoryMode"/.test(PANEL) &&
  /data-i18n="settings\.highMemoryModeHint"/.test(PANEL));

console.log('--- 设置读写 ---');
ok('回显只认显式 true',
  /settings\.highMemoryMode === true/.test(SET));
ok('切换落盘到同一键',
  /settings_save_all_local\(\{ highMemoryMode: highMemoryModeToggle\.checked \}\)/.test(SET));

console.log('--- 启动回放与设置变更 ---');
ok('init.js 把 highMemoryMode 传给 apply_perf_tier',
  /apply_perf_tier\?\.\(\s*window\.__renderPerfTier,\s*window\.__highMemoryMode\s*\)/.test(INIT));
ok('init.js 同步全局镜像',
  /window\.__highMemoryMode = settings\.highMemoryMode === true/.test(INIT));
ok('main.js 设置变更用镜像重放档位',
  /apply_perf_tier\?\.\(\s*window\.__renderPerfTier,\s*window\.__highMemoryMode === true\s*\)/.test(MAIN));

console.log('--- apply_perf_tier 放大逻辑 ---');
ok('第二形参 highMemory 默认 false',
  /apply_perf_tier\(tier, highMemory = false\)/.test(DR));
ok('放大倍数常量定义',
  /const HIGH_MEMORY_PRELOAD_MULT = 3;/.test(DR));
ok('预加载字段按倍数放大',
  /this\._image_keep_distance = p\.image_keep_distance \* mul/.test(DR) &&
  /this\._prerender_distance = p\.prerender_distance \* mul/.test(DR) &&
  /this\._prerender_urgent_span = p\.prerender_urgent_span \* mul/.test(DR));
ok('预挂载页数按倍数放大',
  /this\._premount_near_pages = PREMOUNT_NEAR_PAGES \* mul/.test(DR));
ok('缓存预算按倍数放大',
  /this\._bitmap_cache_max_bytes = p\.bitmap_cache_bytes \* mul/.test(DR) &&
  /this\._bitmap_cache_max_entries = p\.bitmap_cache_entries \* mul/.test(DR));
ok('实例字段初始化',
  /this\._high_memory_mode = false/.test(DR) &&
  /this\._premount_near_pages = PREMOUNT_NEAR_PAGES/.test(DR));

console.log('--- 9 个语言包 ---');
let missing = [];
for (const f of fs.readdirSync('src/locales').filter((x) => x.endsWith('.json'))) {
  const j = JSON.parse(readLocale(f));
  if (!j.settings?.highMemoryMode || !j.settings?.highMemoryModeHint) missing.push(f);
}
function readLocale(f) { return fs.readFileSync('src/locales/' + f, 'utf8'); }
eq('全部语言包带齐文案', missing.join(','), '');

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
