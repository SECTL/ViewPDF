// 「移动」图标可换成 Windows 光标造型 —— 行为 + 接线验证。
//
// 核心逻辑（theme_fetch_icon_path 的重定向）是运行时行为，所以真跑：把三个方法体
// 从真实源码抠出来 .call(mock) 执行，测的是真代码。
import fs from 'node:fs';

const THEME_SRC = process.env.THEME_SRC || 'src/themes/theme.js';
const SRC = fs.readFileSync(THEME_SRC, 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

// theme.js 是 2 空格缩进的对象字面量方法，闭合是 `\n  }`。
// params 必须显式声明形参：抠出来的方法体引用 iconName / enabled，
// new Function 不声明就直接 ReferenceError —— 症状看起来像"功能没实现"。
function extractMethod(name, params = []) {
  const m = new RegExp('(?:^|\\n)\\s*' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}').exec(SRC);
  return m ? new Function(...params, m[1]) : null;
}

const fetchIconPath = extractMethod('theme_fetch_icon_path', ['iconName']);
const setMoveCursor = extractMethod('theme_set_user_move_cursor_icon', ['enabled']);
const fetchMoveCursor = extractMethod('theme_fetch_move_cursor_icon');

eq('抠出 theme_fetch_icon_path', !!fetchIconPath, true);
eq('抠出 theme_set_user_move_cursor_icon', !!setMoveCursor, true);
eq('抠出 theme_fetch_move_cursor_icon', !!fetchMoveCursor, true);
if (!fetchIconPath || !setMoveCursor || !fetchMoveCursor) process.exit(1);

const THEMES = ['com.viewstage.theme.simplify', 'com.viewstage.theme.dark'];

// mock：主题包解析器照抄真实形状（fetch_icon_path 收到图标名，返回最终路径）
const mkTheme = () => {
  const t = {
    currentTheme: THEMES[0],
    currentThemeModule: {
      fetch_icon_path(name) { t.resolved_name = name; return `resolved:${name}`; },
    },
    _user_move_cursor_icon: undefined,
    load_calls: 0,
    theme_load_icons() { this.load_calls++; },
  };
  t.theme_set_user_move_cursor_icon = function (v) { return setMoveCursor.call(t, v); };
  t.theme_fetch_move_cursor_icon = function () { return fetchMoveCursor.call(t); };
  t.path = (name) => fetchIconPath.call(t, name);
  return t;
};

const run = () => {
  // ===== 1. 关闭时：一切照旧 =====
  {
    const t = mkTheme();
    eq('默认（未设置）视为关闭', fetchMoveCursor.call(t), false);
    eq('关闭时 move → move', t.path('move'), 'resolved:move');
    eq('关闭时传给主题包的名字未变', t.resolved_name, 'move');
  }

  // ===== 2. 打开时：只有 move 被重定向 =====
  {
    const t = mkTheme();
    setMoveCursor.call(t, true);
    eq('打开后开关为真', fetchMoveCursor.call(t), true);
    eq('打开时 move → move-cursor', t.path('move'), 'resolved:move-cursor');
    eq('打开时传给主题包的名字是 move-cursor', t.resolved_name, 'move-cursor');
  }
  {
    // 重定向必须幂等：把「move-cursor」本身喂进去要原样透传。
    // 这条在当前「输出为常量」的写法下天然成立，所以它防的不是前缀匹配，
    // 而是有人把实现改成 `iconName + '-cursor'` 拼接 —— 那种写法下
    // 'move-cursor' 会变成 'move-cursor-cursor'，图标直接空白，且只在开关
    // 打开后出现。
    const t = mkTheme();
    setMoveCursor.call(t, true);
    eq('打开时 move-cursor 原样透传（重定向幂等）', t.path('move-cursor'), 'resolved:move-cursor');
    eq('打开时大小写不同的 Move 不被误伤', t.path('Move'), 'resolved:Move');
  }

  // ===== 3. 切换会立刻刷新已插入的图标 =====
  {
    const t = mkTheme();
    setMoveCursor.call(t, true);
    eq('setter 触发一次全量图标加载', t.load_calls, 1);
    setMoveCursor.call(t, false);
    eq('关掉也刷新一次', t.load_calls, 2);
    eq('关掉后回到 move', t.path('move'), 'resolved:move');
  }

  {
    // 「其它图标不受影响」必须在**开关已打开**的前提下断言。漏掉 setMoveCursor
    // 的话这个块里开关是关的，重定向压根不发生，于是这一整组断言恒真 ——
    // 把重定向改成「对所有图标生效」也照样全绿。
    const t = mkTheme();
    setMoveCursor.call(t, true);
    eq('前置：开关确实打开了', fetchMoveCursor.call(t), true);
    for (const name of ['pen', 'eraser', 'reply', 'arrow-repeat', 'blackboard',
      'chevron-left', 'chevron-right', 'dismiss', 'gear']) {
      eq(`打开时 ${name} 不受影响`, t.path(name), 'resolved:' + name);
    }
  }

  // ===== 4. 归一化：只有严格 true 才算打开 =====
  {
    const t = mkTheme();
    for (const v of [1, 'true', {}, [], 'yes', null, undefined]) {
      setMoveCursor.call(t, v);
      // 断言**存进去的值**，不是 getter 的读数：getter 用 `=== true` 时
      // `1 === true` 为假，于是「setter 原样存」这个错误永远测不出来
      //（getter 恰好把它挡住了）。要抓 setter 的错就得看存储值。
      eq(`setter 把 ${JSON.stringify(v)} 归一化为布尔 false`, t._user_move_cursor_icon, false);
      eq(`  且 getter 读到关闭`, fetchMoveCursor.call(t), false);
    }
    setMoveCursor.call(t, true);
    eq('setter 把 true 原样存为 true', t._user_move_cursor_icon, true);
  }
  {
    // 绕过 setter 直接写字段：这时才轮到 getter 的严格性说话
    const t = mkTheme();
    for (const v of ['true', 1, {}, []]) {
      t._user_move_cursor_icon = v;
      eq(`getter：绕过 setter 塞入 ${JSON.stringify(v)} 仍算关闭`, fetchMoveCursor.call(t), false);
    }
    t._user_move_cursor_icon = true;
    eq('getter：塞入 true 才算打开', fetchMoveCursor.call(t), true);
  }

  // ===== 5. 无主题包时（用户自定义主题缺 fetch_icon_path）不崩、不丢重定向 =====
  {
    const t = mkTheme();
    t.currentThemeModule = {};
    setMoveCursor.call(t, true);
    eq('无主题包时打开走内置路径', t.path('move'), 'themes/com.viewstage.theme.simplify/icons/move-cursor.svg');
    setMoveCursor.call(t, false);
    eq('无主题包时关闭走内置路径', t.path('move'), 'themes/com.viewstage.theme.simplify/icons/move.svg');
  }

  // ===== 6. 素材：两个主题各一份，且完全一致 =====
  const svgs = THEMES.map((t) => {
    const p = `src/themes/${t}/icons/move-cursor.svg`;
    try { return { t, body: fs.readFileSync(p, 'utf8').trim() }; }
    catch (e) { return { t, body: null }; }
  });
  for (const s of svgs) ok(`${s.t} 有 move-cursor.svg`, s.body);
  eq('两个主题的 move-cursor.svg 内容一致', svgs[0].body === svgs[1].body, true);
  // 双色是"光标"与"箭头"的唯一区别：单色光标缩到 16px 就是个看不出形状的轮廓
  ok('光标 SVG 是双色的（有 fill 和 stroke）', svgs[0].body && /fill="#fff"/.test(svgs[0].body) && /stroke="#000"/.test(svgs[0].body));
  ok('光标 SVG 描边带 miterlimit（尖角不被截平）', svgs[0].body && /stroke-miterlimit/.test(svgs[0].body));
  // 字形来自 Fluent System Icons（MIT）。双色/描边是本项目的取舍，字形来源是许可要求，
  // 两者分开断言 —— 换字形库时前者可以重新决策，后者不能悄悄丢掉。
  ok('光标 SVG 注明了出处与许可', svgs[0].body && /Fluent System Icons/.test(svgs[0].body) && /MIT/.test(svgs[0].body));

  // ===== 7. 接线：开关在设置面板里恰好一次 =====
  const panel = fs.readFileSync('src/modules/settings/settings-panel.js', 'utf8');
  eq('settings-panel 里 moveCursorIconToggle 恰好一处',
    (panel.match(/id="moveCursorIconToggle"/g) || []).length, 1);
  // 锚在开关自身那一行上（往前 240 字符 = 同一条 sp-setting-item 内）。
  // 写成 panel.includes('data-i18n=…') 之类的整档匹配会被任何无关位置的同名键满足，
  // 看着在守、其实什么都没验 —— format_translate 找不到键时返回键本身，
  // 症状是界面直接显示 "settings.moveCursorIcon" 这一串标识符。
  const toggleAt = panel.indexOf('id="moveCursorIconToggle"');
  ok('存在开关节点', toggleAt > 0);
  const labelBefore = panel.slice(Math.max(0, toggleAt - 240), toggleAt);
  ok('同一行所属的 setting-item 带 data-i18n="settings.moveCursorIcon"',
    labelBefore.includes('data-i18n="settings.moveCursorIcon"'));

  // ===== 8. 接线：读取 / 保存 / 启动应用三处齐全 =====
  const settingsJs = fs.readFileSync('src/modules/settings/settings.js', 'utf8');
  ok('设置面板回填开关状态', settingsJs.includes('moveCursorIconToggle.checked = settings.moveCursorIcon === true'));
  ok('切换时保存到配置', settingsJs.includes('settings_save_all_local({ moveCursorIcon: enabled })'));
  ok('切换时立即应用', settingsJs.includes('theme_set_user_move_cursor_icon?.(enabled)'));

  const initJs = fs.readFileSync('src/init.js', 'utf8');
  ok('启动时应用（否则重启后设置不生效）', /theme_set_user_move_cursor_icon\?\.\(settings\?\.moveCursorIcon === true\)/.test(initJs));

  // ===== 9. Rust 默认值 =====
  const libRs = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
  // 一条断言同时管住两件事：键存在，且值为 false。拆成两条的话，「改成 true」
  // 会被存在性那条抓住、「删掉键」被值那条抓住，报告里就分不清是哪个破坏了哪条。
  // 也刻意放进 defaults —— 未知键 config_validate_and_merge 不校验，
  // 键写错类型要到读的时候才炸。
  ok('settings_defaults 里 moveCursorIcon 为 false（放进 defaults 才吃到 bool 校验）',
    /"moveCursorIcon"\s*:\s*false/.test(libRs));

  // ===== 10. 9 个语言包都有键 =====
  const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'ru-RU'];
  for (const loc of LOCALES) {
    const j = JSON.parse(fs.readFileSync(`src/locales/${loc}.json`, 'utf8'));
    const v = j.settings?.moveCursorIcon;
    ok(`${loc} 带 settings.moveCursorIcon`, typeof v === 'string' && v.trim() !== '');
    // format_translate 找不到键时返回键本身 —— 界面会直接显示 "settings.moveCursorIcon"
    ok(`${loc} 的值不是键名本身（否则等于没翻）`, v !== 'settings.moveCursorIcon');
  }

  // ===== 11. 两处「移动」按钮都走 data-icon="move" =====
  const reader = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');
  const bb = fs.readFileSync('src/modules/blackboard/blackboard.js', 'utf8');
  ok('阅读器 drBtnMove 用 data-icon="move"', /id="drBtnMove"[\s\S]{0,120}?data-icon="move"/.test(reader));
  ok('小黑板 bbBtnMove 用 data-icon="move"', /btn\('bbBtnMove'[\s\S]{0,120}?img\('move'/.test(bb));
  // 解析口是唯一生效点：任何一处绕过它硬编码图标名，开关就对该处失效
  ok('没有绕过解析口硬编码 move.svg',
    !/icons\/move\.svg/.test(reader) && !/icons\/move\.svg/.test(bb));

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) process.exitCode = 1;
};

run();