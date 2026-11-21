// 逐个改坏「移动图标可换光标造型」的不变式，断言 move-cursor-icon.mjs 变红。
// 判定看「报告里出现预期标签的 FAIL 行」，不是「退出码非 0」——
// 变异若让模块加载失败，harness 会零 FAIL 行直接退出，那不叫守卫生效。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/move-cursor-icon.mjs';

// lib.rs / settings.js 等在工作区里是 CRLF，而仓库里是 LF。多行锚点里写死 '\n'
// 会一个都匹配不上（表现为「锚点出现 0 次」）。影子副本一律读成 LF 再写回 ——
// 反正只是给 harness 读的，git 的行尾转换不参与。
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const THEME_SRC = 'src/themes/theme.js';
const THEME_ORIG = readNorm(THEME_SRC);

const PANEL_SRC = 'src/modules/settings/settings-panel.js';
const PANEL_ORIG = readNorm(PANEL_SRC);
const SETTINGS_JS = 'src/modules/settings/settings.js';
const SETTINGS_ORIG = readNorm(SETTINGS_JS);
const INIT_JS = 'src/init.js';
const INIT_ORIG = readNorm(INIT_JS);
const LIB_RS = 'src-tauri/src/lib.rs';
const LIB_ORIG = readNorm(LIB_RS);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-mut-'));

fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, 'tests', 'move-cursor-icon.mjs'));

// 每个源各一个副本，harness 只认固定的相对路径，所以给一份影子目录树
fs.mkdirSync(path.join(tmpDir, 'src', 'themes'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'src', 'modules', 'settings'), { recursive: true });
fs.mkdirSync(path.join(tmpDir, 'src-tauri', 'src'), { recursive: true });
for (const p of [
  'src/themes/theme.js',
  'src/modules/settings/settings-panel.js',
  'src/modules/settings/settings.js',
  'src/init.js',
  'src-tauri/src/lib.rs',
]) fs.writeFileSync(path.join(tmpDir, p), readNorm(p), 'utf8');

// 素材与语言包只读不改，复制过去免得 harness 找不到
for (const t of ['com.viewstage.theme.simplify', 'com.viewstage.theme.dark']) {
  fs.mkdirSync(path.join(tmpDir, 'src', 'themes', t, 'icons'), { recursive: true });
  for (const f of fs.readdirSync(`src/themes/${t}/icons`)) {
    fs.copyFileSync(`src/themes/${t}/icons/${f}`, path.join(tmpDir, 'src', 'themes', t, 'icons', f));
  }
}
fs.mkdirSync(path.join(tmpDir, 'src', 'locales'), { recursive: true });
for (const f of fs.readdirSync('src/locales')) {
  fs.copyFileSync(`src/locales/${f}`, path.join(tmpDir, 'src', 'locales', f));
}
fs.mkdirSync(path.join(tmpDir, 'src', 'modules', 'pdf'), { recursive: true });
fs.copyFileSync('src/modules/pdf/document_reader.js', path.join(tmpDir, 'src', 'modules', 'pdf', 'document_reader.js'));
fs.mkdirSync(path.join(tmpDir, 'src', 'modules', 'blackboard'), { recursive: true });
fs.copyFileSync('src/modules/blackboard/blackboard.js', path.join(tmpDir, 'src', 'modules', 'blackboard', 'blackboard.js'));

// file 相对 tmpDir，from/to 直接对原文件内容操作
const MUTATIONS = [
  {
    label: '重定向整个删掉（开关完全失效）',
    expect: '打开时 move → move-cursor',
    file: THEME_SRC,
    orig: THEME_ORIG,
    from: `    const name = (iconName === 'move' && this.theme_fetch_move_cursor_icon()) ? 'move-cursor' : iconName;`,
    to: `    const name = iconName;`,
  },
  {
    label: '忽略开关（无条件换成光标）',
    expect: '关闭时 move → move',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `const name = (iconName === 'move' && this.theme_fetch_move_cursor_icon()) ? 'move-cursor' : iconName;`,
    to: `const name = (iconName === 'move') ? 'move-cursor' : iconName;`,
  },
  {
    label: '重定向所有图标（整个工具栏变成光标）',
    expect: '打开时 pen 不受影响',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `const name = (iconName === 'move' && this.theme_fetch_move_cursor_icon()) ? 'move-cursor' : iconName;`,
    to: `const name = this.theme_fetch_move_cursor_icon() ? 'move-cursor' : iconName;`,
  },
  {
    // 注意变异形式：必须是「子串匹配 + 拼接输出」才真的会产生 move-cursor-cursor。
    // 单改匹配方式（前缀/子串）而输出仍是常量 'move-cursor'，结果一模一样 ——
    // 那是个抓不到任何东西的空变异，比没有守卫更危险。
    label: '改成子串匹配+拼接输出（move-cursor 变 move-cursor-cursor）',
    expect: '打开时 move-cursor 原样透传（重定向幂等）',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `const name = (iconName === 'move' && this.theme_fetch_move_cursor_icon()) ? 'move-cursor' : iconName;`,
    to: `const name = (String(iconName).includes('move') && this.theme_fetch_move_cursor_icon()) ? iconName + '-cursor' : iconName;`,
  },
  {
    label: '大小写不敏感匹配（Move 这样的名字被误伤）',
    expect: '打开时大小写不同的 Move 不被误伤',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `const name = (iconName === 'move' && this.theme_fetch_move_cursor_icon()) ? 'move-cursor' : iconName;`,
    to: `const name = (String(iconName).toLowerCase() === 'move' && this.theme_fetch_move_cursor_icon()) ? 'move-cursor' : iconName;`,
  },
  {
    label: '重定向后忘了用新名字（等于没重定向）',
    expect: '打开时传给主题包的名字是 move-cursor',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `      return this.currentThemeModule.fetch_icon_path(name);`,
    to: `      return this.currentThemeModule.fetch_icon_path(iconName);`,
  },
  {
    label: '重定向走内置路径而绕过主题包（用户自定义主题的图标映射失效）',
    expect: '打开时传给主题包的名字是 move-cursor',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `    const name = (iconName === 'move' && this.theme_fetch_move_cursor_icon()) ? 'move-cursor' : iconName;
    if (this.currentThemeModule`,
    to: `    const name = (iconName === 'move' && this.theme_fetch_move_cursor_icon()) ? 'move-cursor' : iconName;
    if (false && this.currentThemeModule`,
  },
  {
    label: 'setter 不刷新已插入的图标（切了但界面上不变）',
    expect: 'setter 触发一次全量图标加载',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `    this._user_move_cursor_icon = enabled === true;
    // 已插入 DOM 的 <img> 必须重设 src。不刷的话要等到下次全量加载才变，
    // 而「下次」可能永远不来 —— 黑板工具栏是懒加载的，用户不一定打开过。
    this.theme_load_icons();`,
    to: `    this._user_move_cursor_icon = enabled === true;`,
  },
  {
    // 必须指向「绕过 setter」那条断言：从 setter 走的路径里 setter 早已归一化，
    // getter 改成 `!!` 照样全绿 —— 期望标签写错就会把「抓到了」误判成「没抓到」。
    label: 'getter 用真值判断（绕过 setter 时字符串 "true" 也算打开）',
    expect: 'getter：绕过 setter 塞入 "true" 仍算关闭',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `  theme_fetch_move_cursor_icon() {
    return this._user_move_cursor_icon === true;
  },`,
    to: `  theme_fetch_move_cursor_icon() {
    return !!this._user_move_cursor_icon;
  },`,
  },
  {
    label: 'getter 默认当成打开（升级即变样）',
    expect: '默认（未设置）视为关闭',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `  theme_fetch_move_cursor_icon() {
    return this._user_move_cursor_icon === true;
  },`,
    to: `  theme_fetch_move_cursor_icon() {
    return this._user_move_cursor_icon !== false;
  },`,
  },
  {
    label: 'setter 不做归一化（原样存）',
    expect: 'setter 把 1 归一化为布尔 false',
    file: THEME_SRC, orig: THEME_ORIG,
    from: `this._user_move_cursor_icon = enabled === true;`,
    to: `this._user_move_cursor_icon = enabled;`,
  },
  {
    label: '面板里出现第二个同名开关',
    expect: 'settings-panel 里 moveCursorIconToggle 恰好一处',
    file: PANEL_SRC, orig: PANEL_ORIG,
    from: `<div class="sp-setting-item"><label class="sp-setting-label" for="moveCursorIconToggle" data-i18n="settings.moveCursorIcon">移动工具使用光标图标</label><label class="sp-toggle-switch"><input type="checkbox" switch id="moveCursorIconToggle"><span class="sp-toggle-slider"></span></label></div>`,
    to: `<div class="sp-setting-item"><label class="sp-setting-label" for="moveCursorIconToggle" data-i18n="settings.moveCursorIcon">移动工具使用光标图标</label><label class="sp-toggle-switch"><input type="checkbox" switch id="moveCursorIconToggle"><span class="sp-toggle-slider"></span></label></div><div class="sp-setting-item"><input type="checkbox" id="moveCursorIconToggle"></div>`,
  },
  {
    label: '开关漏了 data-i18n（界面直接显示 settings.moveCursorIcon）',
    expect: '同一行所属的 setting-item 带 data-i18n',
    file: PANEL_SRC, orig: PANEL_ORIG,
    from: `<label class="sp-setting-label" for="moveCursorIconToggle" data-i18n="settings.moveCursorIcon">移动工具使用光标图标</label>`,
    to: `<label class="sp-setting-label" for="moveCursorIconToggle">移动工具使用光标图标</label>`,
  },
  {
    label: '设置面板不回填开关状态（重开面板显示错值）',
    expect: '设置面板回填开关状态',
    file: SETTINGS_JS, orig: SETTINGS_ORIG,
    from: `moveCursorIconToggle.checked = settings.moveCursorIcon === true;`,
    to: `moveCursorIconToggle.checked = false;`,
  },
  {
    label: '切换时不落盘（重启后失效）',
    expect: '切换时保存到配置',
    file: SETTINGS_JS, orig: SETTINGS_ORIG,
    from: `await settings_save_all_local({ moveCursorIcon: enabled });`,
    to: `/* 忘了存 */`,
  },
  {
    label: '切换时不立即应用（要重启才看到变化）',
    expect: '切换时立即应用',
    file: SETTINGS_JS, orig: SETTINGS_ORIG,
    from: `window.ThemeManager?.theme_set_user_move_cursor_icon?.(enabled);`,
    to: `/* 忘了应用 */`,
  },
  {
    label: '启动时不应用（切了开关后重启就丢）',
    expect: '启动时应用',
    file: INIT_JS, orig: INIT_ORIG,
    from: `window.ThemeManager?.theme_set_user_move_cursor_icon?.(settings?.moveCursorIcon === true);`,
    to: `/* 启动忘了应用 */`,
  },
  {
    label: 'Rust 默认值改成 true（升级即变样）',
    expect: 'settings_defaults 里 moveCursorIcon 为 false',
    file: LIB_RS, orig: LIB_ORIG,
    from: `"moveCursorIcon": false,`,
    to: `"moveCursorIcon": true,`,
  },
  {
    label: 'Rust defaults 里删掉这个键（吃不到类型校验）',
    expect: 'settings_defaults 里 moveCursorIcon 为 false',
    file: LIB_RS, orig: LIB_ORIG,
    from: `        // 「移动」工具改用 Windows 光标造型图标。放进 defaults 才能吃到
        // config_validate_and_merge 的 bool 类型校验（同 macosTitleBar）。
        "moveCursorIcon": false,
`,
    to: ``,
  },
  {
    label: '某个语言包漏了键',
    expect: 'de-DE 带 settings.moveCursorIcon',
    file: null, // 单独处理
    skip: true,
  },
  {
    // MIT 要求许可声明随素材走。删掉注释后图标照样正常显示，没有任何症状 ——
    // 所以这条守的是法务，也正因为没症状才最容易被顺手删掉。
    label: '删掉光标 SVG 里的出处/许可注释',
    expect: '光标 SVG 注明了出处与许可',
    file: 'src/themes/com.viewstage.theme.simplify/icons/move-cursor.svg',
    orig: readNorm('src/themes/com.viewstage.theme.simplify/icons/move-cursor.svg'),
    from: `<!-- Fluent System Icons「Cursor」24 filled · MIT · © 2020 Microsoft Corporation -->\n`,
    to: ``,
  },
  {
    label: '阅读器绕过解析口硬编码图标名',
    expect: '没有绕过解析口硬编码 move.svg',
    file: 'src/modules/pdf/document_reader.js',
    orig: readNorm('src/modules/pdf/document_reader.js'),
    from: `<img data-icon="move" width="16" height="16" alt="移动">`,
    to: `<img src="themes/com.viewstage.theme.simplify/icons/move.svg" width="16" height="16" alt="移动">`,
  },
];

let pass = 0, fail = 0;

// 先把语言包缺失那条做掉：改影子目录里的 de-DE.json
{
  const p = path.join(tmpDir, 'src', 'locales', 'de-DE.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete j.settings.moveCursorIcon;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n', 'utf8');
  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes('de-DE 带 settings.moveCursorIcon'));
  if (caught) { pass++; console.log('PASS  某个语言包漏了键   → de-DE 带 settings.moveCursorIcon'); }
  else {
    fail++;
    console.log('FAIL  某个语言包漏了键   没抓到\n' + out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 4).join('\n'));
  }
  // 还原
  fs.copyFileSync('src/locales/de-DE.json', p);
}

for (const m of MUTATIONS) {
  if (m.skip) continue;
  const hits = m.orig.split(m.from).length - 1;
  if (hits !== 1) {
    fail++;
    console.log('FAIL  [' + m.label + '] 锚点出现 ' + hits + ' 次（必须恰好 1 次）');
    continue;
  }
  const mutated = m.orig.replace(m.from, m.to);
  if (mutated === m.orig) {
    fail++;
    console.log('FAIL  [' + m.label + '] 变异是空操作 —— 等于没改却报「抓到了」');
    continue;
  }
  const dst = path.join(tmpDir, m.file);
  fs.writeFileSync(dst, mutated, 'utf8');

  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }

  const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) { pass++; console.log('PASS  ' + m.label + '   → ' + m.expect); }
  else {
    fail++;
    console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）\n' +
      out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 5).join('\n'));
  }
  fs.writeFileSync(dst, m.orig, 'utf8');   // 还原，避免上一条变异污染下一条
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;