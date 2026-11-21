// 逐个改坏「阅读器全屏按钮」的不变式，断言 fullscreen-button.mjs 变红。
// 判定看「报告里出现预期标签的 FAIL 行」，不是「退出码非 0」——
// 变异若让模块无法解析，harness 会零 FAIL 行直接崩掉，那不叫守卫生效。
// 变异补丁必须保持**语法有效**：补丁本身写坏时 harness 加载失败、崩在导入阶段，
// 报告里同样没有预期的 FAIL 行，看上去像守卫失灵。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/fullscreen-button.mjs';

// 工作区里 lib.rs / settings.js 等可能是 CRLF，而仓库里是 LF。多行锚点写死 '\n'
// 会一个都匹配不上（表现为「锚点出现 0 次」）。影子副本一律读成 LF 再写回。
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const READER = 'src/modules/pdf/document_reader.js';
const MAIN = 'src/main.js';
const CSS = 'src/styles.css';
const PANEL = 'src/modules/settings/settings-panel.js';
const SETTINGS_JS = 'src/modules/settings/settings.js';
const LIB_RS = 'src-tauri/src/lib.rs';
const CAP = 'src-tauri/capabilities/default.json';
const THEME_JSON = {
  simplify: 'src/themes/com.viewstage.theme.simplify/theme.json',
  dark: 'src/themes/com.viewstage.theme.dark/theme.json',
};
const ICON = (t, n) => `src/themes/com.viewstage.theme.${t}/icons/${n}.svg`;

const ORIG = {};
for (const p of [READER, MAIN, CSS, PANEL, SETTINGS_JS, LIB_RS, CAP, ...Object.values(THEME_JSON)]) {
  ORIG[p] = readNorm(p);
}
// 素材不进 ORIG —— 它们是整个 icons 目录一起拷过去的。restore() 认不出来时
// 直接从真实源重拷一份（见下）。
const ICON_FILES = [];
for (const t of ['simplify', 'dark']) {
  for (const n of ['fullscreen', 'fullscreen-exit']) ICON_FILES.push(ICON(t, n));
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-mut-'));
const shadow = (p) => {
  const dst = path.join(tmpDir, p);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  return dst;
};

// harness 只认固定的相对路径，所以给一份影子目录树
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, 'tests', 'fullscreen-button.mjs'));
for (const p of Object.keys(ORIG)) fs.writeFileSync(shadow(p), ORIG[p], 'utf8');

for (const t of ['simplify', 'dark']) {
  const dir = `src/themes/com.viewstage.theme.${t}/icons`;
  fs.mkdirSync(path.join(tmpDir, dir), { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(`${dir}/${f}`, path.join(tmpDir, dir, f));
}
fs.mkdirSync(path.join(tmpDir, 'src', 'locales'), { recursive: true });
for (const f of fs.readdirSync('src/locales')) {
  fs.copyFileSync(`src/locales/${f}`, path.join(tmpDir, 'src/locales', f));
}

const runHarness = () => {
  let out = '';
  try { out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  return out;
};
const restore = (p) => {
  if (ORIG[p] !== undefined) fs.writeFileSync(shadow(p), ORIG[p], 'utf8');
  else fs.copyFileSync(p, shadow(p));   // 素材：直接从真实源重拷
};

let pass = 0, fail = 0;

// file 相对 tmpDir，from/to 直接对原文件内容操作
const MUTATIONS = [
  // ---------- 按钮标记 ----------
  {
    label: '工具栏里整个删掉全屏按钮',
    expect: '工具栏里有 drBtnFullscreen 按钮',
    file: READER, orig: ORIG[READER],
    from: `                <button class="toolbar-btn function-btn" id="drBtnFullscreen">
                    <img class="tb-glyph-enter" data-icon="fullscreen" width="16" height="16" alt="全屏">
                    <img class="tb-glyph-exit" data-icon="fullscreen-exit" width="16" height="16" alt="退出全屏">
                    <span>全屏</span>
                </button>
`,
    to: ``,
  },
  {
    label: '只有进入图标，删掉退出图标（切到全屏后图标空白）',
    expect: '带 data-icon="fullscreen-exit"',
    file: READER, orig: ORIG[READER],
    from: `                    <img class="tb-glyph-exit" data-icon="fullscreen-exit" width="16" height="16" alt="退出全屏">
`,
    to: ``,
  },
  {
    label: '删掉 tb-glyph-enter 类（CSS 二选一失去钩子）',
    expect: '两枚图标各有 tb-glyph-* 类',
    file: READER, orig: ORIG[READER],
    from: `<img class="tb-glyph-enter" data-icon="fullscreen"`,
    to: `<img data-icon="fullscreen"`,
  },
  {
    // 本次最容易漏的一处：工具栏是 init() 里现建的，晚于启动时的 theme_load_icons()。
    // 不补这一次，两枚 <img> 都是无 src 的空白，且没有任何报错。
    label: '_create_toolbar 不补 theme_load_icons（图标停在无 src 空白）',
    expect: '_create_toolbar 里补了 theme_load_icons',
    file: READER, orig: ORIG[READER],
    from: `        window.ThemeManager?.theme_load_icons?.();
        this._apply_text_visibility();
    }

    /**
     * 观测工具栏尺寸`,
    to: `        this._apply_text_visibility();
    }

    /**
     * 观测工具栏尺寸`,
  },
  {
    label: '按钮不绑 click（点了毫无反应）',
    expect: '绑定了 drBtnFullscreen 的 click',
    file: READER, orig: ORIG[READER],
    from: `        const fs_btn = document.getElementById('drBtnFullscreen');
        if (fs_btn) {
            fs_btn.addEventListener('click', () => this._toggle_fullscreen());
        }
`,
    to: `        const fs_btn = document.getElementById('drBtnFullscreen');
`,
  },
  {
    label: '不注册全屏状态同步（图标滞留在旧态）',
    expect: '注册了全屏状态同步',
    file: READER, orig: ORIG[READER],
    from: `        this._setup_fullscreen_state_sync();
`,
    to: `        /* 忘了同步 */`,
  },
  {
    label: '启动时不回填开关可见性（关过开关的用户重启后又看见按钮）',
    expect: '启动时回填开关可见性',
    file: READER, orig: ORIG[READER],
    from: `        this._update_minimize_btn_visibility();
        this._update_fullscreen_btn_visibility();
    }`,
    to: `        this._update_minimize_btn_visibility();
    }`,
  },


  // ---------- 点击 → 图标：必须由返回值驱动 ----------
  {
    // 这是本次最容易写错的一处。setFullscreen 在缺权限时被 ACL 拒绝，
    // 窗口没进全屏而图标已变成「退出全屏」，用户再点是「再次进入」，永远出不来。
    label: '点击后乐观假设已进全屏（忽略 helper 返回值）',
    expect: '切换失败（返回 false）：不得乐观加类',
    file: READER, orig: ORIG[READER],
    from: `        const now_fullscreen = await window.main_toggle_fullscreen?.();
        this._apply_fullscreen_state(now_fullscreen === true);`,
    to: `        await window.main_toggle_fullscreen?.();
        this._apply_fullscreen_state(true);`,
  },

  // ---------- 状态同步：回包乱序 / 重复注册 ----------
  {
    label: '去掉代次令牌（过期回包覆盖新状态 → 图标闪回）',
    expect: '过期回包被丢弃（不闪回）',
    file: READER, orig: ORIG[READER],
    from: `            if (token !== this._fullscreen_sync_token) return;
`,
    to: ``,
  },
  {
    label: '代次令牌在 await **之后**才自增（守卫恒不成立）',
    expect: '过期回包被丢弃（不闪回）',
    file: READER, orig: ORIG[READER],
    from: `            const token = ++this._fullscreen_sync_token;
            const is_fs = await window.main_fetch_fullscreen?.();`,
    to: `            const token = this._fullscreen_sync_token;
            const is_fs = await window.main_fetch_fullscreen?.();
            this._fullscreen_sync_token = token + 1;`,
  },
  {
    label: '去掉防重复注册的标记（一次点击切两次，看起来像没反应）',
    expect: '第二次调用不重复注册',
    file: READER, orig: ORIG[READER],
    from: `        if (this._fullscreen_sync_bound || !window.__TAURI__) return;`,
    to: `        if (!window.__TAURI__) return;`,
  },
  {
    label: '只挂 onResized 不挂 onFocusChanged',
    expect: '挂了 onFocusChanged',
    file: READER, orig: ORIG[READER],
    from: `            .then(() => getCurrentWindow().onFocusChanged(sync))
            .catch(() => {});
`,
    to: ``,
  },
  {
    label: '无 Tauri 时不守卫（无 Tauri 环境直接崩在解构上）',
    expect: '无 Tauri 时安全跳过',
    file: READER, orig: ORIG[READER],
    from: `        if (this._fullscreen_sync_bound || !window.__TAURI__) return;`,
    to: `        if (this._fullscreen_sync_bound) return;`,
  },

  // ---------- 开关缺省方向 ----------
  {
    label: '缺省方向写成 === true（老配置用户打开就发现按钮不见了）',
    expect: '不传参（老配置缺这个键）视为显示',
    file: READER, orig: ORIG[READER],
    from: `        this._show_fullscreen_btn = show !== false;
        const btn = document.getElementById('drBtnFullscreen');
        if (btn) btn.style.display = this._show_fullscreen_btn ? '' : 'none';`,
    to: `        this._show_fullscreen_btn = show === true;
        const btn = document.getElementById('drBtnFullscreen');
        if (btn) btn.style.display = this._show_fullscreen_btn ? '' : 'none';`,
  },
  {
    label: '回填写成 === true（缺键时被当成关闭）',
    expect: '配置缺键 → 显示',
    file: READER, orig: ORIG[READER],
    from: `            this._set_fullscreen_btn_visible(result?.settings?.showFullscreenButton !== false);
        } catch (_) {
            this._set_fullscreen_btn_visible(true);
        }`,
    to: `            this._set_fullscreen_btn_visible(result?.settings?.showFullscreenButton === true);
        } catch (_) {
        }`,
  },

  // ---------- 图标 / 文案 ----------
  {
    label: '不更新 title（看不出当前点了是进还是退）',
    expect: 'title 是「退出」',
    file: READER, orig: ORIG[READER],
    from: `        btn.title = label;
`,
    to: ``,
  },
  {
    label: '不更新 span 文案（工具栏文字与状态不一致）',
    expect: 'span 文案同步',
    file: READER, orig: ORIG[READER],
    from: `        const span = btn.querySelector('span');
        if (span) span.textContent = label;
`,
    to: ``,
  },
  {
    label: 'is-fullscreen 类永远不加（CSS 永不切到退出图标）',
    expect: '全屏中：加 is-fullscreen 类',
    file: READER, orig: ORIG[READER],
    from: `        btn.classList.toggle('is-fullscreen', is_fullscreen === true);`,
    to: `        btn.classList.remove('is-fullscreen');`,
  },

  // ---------- main.js ----------
  {
    // 无脑置 true：全屏就再也退不出来了（用户只能重启）
    label: '切换时无脑置 true（已全屏时点一下反而"确认进入"）',
    expect: '当前已全屏 → 请求退出',
    file: MAIN, orig: ORIG[MAIN],
    from: `        await getCurrentWindow().setFullscreen(!current);`,
    to: `        await getCurrentWindow().setFullscreen(true);`,
  },
  {
    // 最大化直进全屏会留任务栏黑边；删掉这段守卫后测试必须变红。
    label: '进全屏前不再还原最大化（任务栏黑边回归）',
    expect: '先还原再 setFullscreen',
    file: MAIN, orig: ORIG[MAIN],
    from: `    if (!current) {
        try {
            const win = getCurrentWindow();`,
    to: `    if (false) {
        try {
            const win = getCurrentWindow();`,
  },
  {
    // 权限缺失 → reject。若把 catch 去掉，异常一路冒到 click 处理器，
    // 图标不动、控制台一条未捕获的 promise rejection。
    label: 'setFullscreen 失败时不回传未改变的状态（图标说谎）',
    expect: 'setFullscreen 被拒：回传未改变的状态 false',
    file: MAIN, orig: ORIG[MAIN],
    from: `    } catch (e) {
        console.warn('[main] 切换全屏失败:', e);
        return current;
    }`,
    to: `    } catch (e) {
        console.warn('[main] 切换全屏失败:', e);
        return !current;
    }`,
  },
  {
    label: 'isFullscreen 不归一化（非布尔回包当真值）',
    expect: '非布尔回包归一为 false',
    file: MAIN, orig: ORIG[MAIN],
    from: `        return (await getCurrentWindow().isFullscreen()) === true;`,
    to: `        return await getCurrentWindow().isFullscreen();`,
  },
  {
    label: 'isFullscreen 抛错时不兜底（整条同步链炸掉）',
    expect: 'isFullscreen 抛错 → false',
    file: MAIN, orig: ORIG[MAIN],
    from: `        return (await getCurrentWindow().isFullscreen()) === true;
    } catch (_) {
        return false;
    }`,
    to: `        return (await getCurrentWindow().isFullscreen()) === true;
    } catch (_) {
        return true;
    }`,
  },
  {
    label: 'main_toggle_fullscreen 没挂到 window（reader 拿到 undefined，点击静默无效）',
    expect: 'main.js 把 main_toggle_fullscreen 挂到 window',
    file: MAIN, orig: ORIG[MAIN],
    from: `window.main_toggle_fullscreen = main_toggle_fullscreen;
`,
    to: ``,
  },
  {
    label: 'main_fetch_fullscreen 没挂到 window（同步链静默失效）',
    expect: 'main.js 把 main_fetch_fullscreen 挂到 window',
    file: MAIN, orig: ORIG[MAIN],
    from: `window.main_fetch_fullscreen = main_fetch_fullscreen;
`,
    to: ``,
  },

  // ---------- 权限 ----------
  {
    // 官方文档：core:window:default 只放开 getter 与 is* 查询，
    // 每一个改变窗口的方法都要自己的权限。漏这条 = 按钮点了毫无反应。
    label: 'capability 里删掉 allow-set-fullscreen（调用被 ACL 拒绝）',
    expect: 'capability 里有 core:window:allow-set-fullscreen',
    file: CAP, orig: ORIG[CAP],
    from: `    "core:window:allow-set-fullscreen",
`,
    to: ``,
  },
  {
    label: 'capability 里删掉 allow-is-fullscreen',
    expect: 'capability 里显式声明 core:window:allow-is-fullscreen',
    file: CAP, orig: ORIG[CAP],
    from: `    "core:window:allow-is-fullscreen",
`,
    to: ``,
  },

  // ---------- 素材 ----------
  // 路径数据的锚点用**字形前缀**而不是整条 path：换字形库（Fluent → 别的）时
  // 整条 path 会整批失效，变异脚本会集体报「锚点出现 0 次」。
  {
    // 「文件在不在」与「画得对不对」是两条不同的守卫。改图形内容不会让文件消失，
    // 所以这条的预期标签必须是一致性那条 —— 否则就是「标签写错、变异其实没被测到」。
    label: 'simplify 的 fullscreen.svg 画错了（与 dark 不一致）',
    expect: '两个主题的 fullscreen.svg 内容一致',
    file: ICON('simplify', 'fullscreen'), orig: readNorm(ICON('simplify', 'fullscreen')),
    from: `M5 6C5 5.44772 5.44772 5 6 5H8C8.55228 5 9 4.55228 9 4C9 3.44772 8.55228 3 8 3`,
    to: `M5 6C5 5.44772 5.44772 5 6 5H8C8.55228 5 9 4.55228 9 4C9 3.44772 8.55228 3 9 3`,
  },
  {
    label: 'simplify 主题少一个 fullscreen.svg（图标空白且不报错）',
    expect: 'simplify 有 fullscreen.svg',
    file: ICON('simplify', 'fullscreen'), del: true,
  },
  {
    label: 'dark 主题少一个 fullscreen-exit.svg（切到全屏后图标消失）',
    expect: 'dark 有 fullscreen-exit.svg',
    file: ICON('dark', 'fullscreen-exit'), del: true,
  },
  {
    // Fluent 原始素材就是硬编码的 fill="#212121"，直接搬进来在深色主题上几乎不可见。
    // 这条守的是「取色跟着主题走」，与字形是填充还是描边无关。
    label: '图标钉死 Fluent 原始颜色而不是 currentColor（深色主题上看不见）',
    expect: '跟随主题取色',
    file: ICON('dark', 'fullscreen-exit'), orig: readNorm(ICON('dark', 'fullscreen-exit')),
    from: `fill="currentColor"`,
    to: `fill="#212121"`,
  },
  {
    // MIT 要求许可声明随素材走。删掉注释后文件照样能用、图标照样显示，
    // 所以这条守卫守的是**法务**，不是功能 —— 但正因为没有任何症状才容易被顺手删掉。
    label: '删掉 SVG 里的出处/许可注释（MIT 声明随文件丢失）',
    expect: '注明了出处与许可',
    file: ICON('simplify', 'fullscreen'), orig: readNorm(ICON('simplify', 'fullscreen')),
    from: `<!-- Fluent System Icons「Full Screen Maximize」24 filled · MIT · © 2020 Microsoft Corporation -->\n`,
    to: ``,
  },
  {
    label: 'theme.json 里删掉 fullscreen 登记',
    expect: 'theme.json.icons.fullscreen 已登记',
    file: THEME_JSON.simplify, orig: ORIG[THEME_JSON.simplify],
    from: `    "fullscreen": "fullscreen",
`,
    to: ``,
  },
  {
    // 写错名字时 theme_fetch_icon_path 回落到字面名，<img> 拿到 404，
    // 图标空白且**不报错** —— 用户主题缺图时就是这个症状。
    label: 'theme.json 登记的名字指向不存在的文件（图标空白且不报错）',
    expect: '指向的文件存在',
    file: THEME_JSON.dark, orig: ORIG[THEME_JSON.dark],
    from: `    "fullscreen-exit": "fullscreen-exit"`,
    to: `    "fullscreen-exit": "fullscreen-exitt"`,
  },
  {
    label: 'dark 的 fullscreen.svg 与 simplify 不一致（换主题图标就变样）',
    expect: '两个主题的 fullscreen.svg 内容一致',
    file: ICON('dark', 'fullscreen'), orig: readNorm(ICON('dark', 'fullscreen')),
    from: `M5 6C5 5.44772 5.44772 5 6 5H8C8.55228 5 9 4.55228 9 4C9 3.44772 8.55228 3 8 3`,
    to: `M5 6C5 5.44772 5.44772 5 6 5H8C8.55228 5 9 4.55228 9 4C9 3.44772 8.55228 3 9 3`,
  },
  {
    label: '退出图标整份复制成进入图标（进/退看不出区别）',
    expect: '两枚图标内容不同',
    file: ICON('simplify', 'fullscreen-exit'), copyOver: ICON('simplify', 'fullscreen'),
  },

  // ---------- CSS ----------
  {
    label: '删掉「默认隐藏退出图标」（两枚图标叠在一起显示）',
    expect: '默认隐藏退出图标',
    file: CSS, orig: ORIG[CSS],
    from: `#drBtnFullscreen .tb-glyph-exit {
    display: none;
}
`,
    to: ``,
  },
  {
    label: '删掉「全屏中隐藏进入图标」',
    expect: '全屏中隐藏进入图标',
    file: CSS, orig: ORIG[CSS],
    from: `#drBtnFullscreen.is-fullscreen .tb-glyph-enter {
    display: none;
}
`,
    to: ``,
  },
  {
    label: '删掉「全屏中显示退出图标」（进全屏后图标反而消失）',
    expect: '全屏中显示退出图标',
    file: CSS, orig: ORIG[CSS],
    from: `#drBtnFullscreen.is-fullscreen .tb-glyph-exit {
    display: block;
}
`,
    to: ``,
  },
  {
    label: '多出一条 #drBtnFullscreen 规则（选择器被写宽，误伤别的按钮）',
    expect: '#drBtnFullscreen 规则恰好三条',
    file: CSS, orig: ORIG[CSS],
    from: `#drBtnFullscreen.is-fullscreen .tb-glyph-exit {
    display: block;
}
`,
    to: `#drBtnFullscreen.is-fullscreen .tb-glyph-exit {
    display: block;
}
#drBtnFullscreen {
    color: red;
}
`,
  },

  // ---------- 设置面板 ----------
  {
    label: '面板里删掉开关（设置页找不到这一项）',
    expect: 'settings-panel 里 fullscreenButtonToggle 恰好一处',
    file: PANEL, orig: ORIG[PANEL],
    from: `                            <div class="sp-setting-item"><label class="sp-setting-label" for="fullscreenButtonToggle" data-i18n="settings.showFullscreenButton">显示全屏按钮</label><label class="sp-toggle-switch"><input type="checkbox" switch id="fullscreenButtonToggle" checked><span class="sp-toggle-slider"></span></label></div>
`,
    to: ``,
  },
  {
    // format_translate 找不到键时返回键本身，界面会直接显示
    // "settings.showFullscreenButton" 这一串标识符 —— 不空白、不报错。
    label: '开关漏了 data-i18n（界面显示 settings.showFullscreenButton）',
    expect: '同一 setting-item 带 data-i18n="settings.showFullscreenButton"',
    file: PANEL, orig: ORIG[PANEL],
    from: `<label class="sp-setting-label" for="fullscreenButtonToggle" data-i18n="settings.showFullscreenButton">显示全屏按钮</label>`,
    to: `<label class="sp-setting-label" for="fullscreenButtonToggle">显示全屏按钮</label>`,
  },
  {
    label: '面板里出现第二个同名开关（勾一个另一个跟着动）',
    expect: 'settings-panel 里 fullscreenButtonToggle 恰好一处',
    file: PANEL, orig: ORIG[PANEL],
    from: `id="fullscreenButtonToggle" checked`,
    to: `id="fullscreenButtonToggle" checked><input type="checkbox" id="fullscreenButtonToggle"`,
  },
  {
    label: '设置面板不回填开关状态（重开面板显示错值）',
    expect: '回填开关状态且缺省方向为显示',
    file: SETTINGS_JS, orig: ORIG[SETTINGS_JS],
    from: `fullscreenButtonToggle.checked = settings.showFullscreenButton !== false;`,
    to: `fullscreenButtonToggle.checked = false;`,
  },
  {
    label: '切换时不落盘（重启后失效）',
    expect: '切换时保存到配置',
    file: SETTINGS_JS, orig: ORIG[SETTINGS_JS],
    from: `await settings_save_all_local({ showFullscreenButton: enabled });`,
    to: `/* 忘了存 */`,
  },
  {
    label: '切换时不立即应用（要重启才看到变化）',
    expect: '切换时立即应用',
    file: SETTINGS_JS, orig: ORIG[SETTINGS_JS],
    from: `window.documentReaderManager?._set_fullscreen_btn_visible?.(enabled);`,
    to: `/* 忘了应用 */`,
  },

  // ---------- Rust 默认值 ----------
  {
    // 写成 false 的话「升级前没这个键」的老配置与「用户主动关掉」无法区分，
    // 升级后所有人的按钮都消失了。
    label: 'Rust 默认值改成 false（升级即所有人按钮消失）',
    expect: 'config_fetch_default 里 showFullscreenButton 为 true',
    file: LIB_RS, orig: ORIG[LIB_RS],
    from: `"showFullscreenButton": true,`,
    to: `"showFullscreenButton": false,`,
  },
  {
    label: 'Rust defaults 里删掉这个键（吃不到 bool 类型校验）',
    expect: 'config_fetch_default 里 showFullscreenButton 为 true',
    file: LIB_RS, orig: ORIG[LIB_RS],
    from: `        "showFullscreenButton": true,
`,
    to: ``,
  },
];

for (const m of MUTATIONS) {
  if (m.skip) continue;
  if (m.copyOver) {
    // 把另一枚图标**整份**拷过来。字符串替换做不到这件事：真实的复制粘贴失误
    // 是整个文件被覆盖，而只替换 path 的一段会留下残余笔画，两枚图标仍然不同 ——
    // 于是「进/退看不出区别」这条守卫正确地没响，报告却显示成「变异没被抓到」。
    // 这是变异脚本自身的缺陷，不是守卫的漏洞，所以要单开一种变异形态。
    const target = shadow(m.file);
    fs.copyFileSync(m.copyOver, target);
    const out = runHarness();
    const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(m.expect));
    if (caught) { pass++; console.log('PASS  ' + m.label + '   → ' + m.expect); }
    else {
      fail++;
      console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）\n' +
        out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 5).join('\n'));
    }
    fs.copyFileSync(m.file, target);   // 还原
    continue;
  }
  if (m.del) {
    // 删整个文件：字符串替换做不到，得走文件系统
    const target = shadow(m.file);
    if (!fs.existsSync(target)) {
      fail++;
      console.log('FAIL  [' + m.label + '] 影子副本里找不到 ' + m.file);
      continue;
    }
    fs.rmSync(target);
    const out = runHarness();
    const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(m.expect));
    if (caught) { pass++; console.log('PASS  ' + m.label + '   → ' + m.expect); }
    else {
      fail++;
      console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）\n' +
        out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 5).join('\n'));
    }
    fs.copyFileSync(m.file, target);   // 还原
    continue;
  }
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
  fs.writeFileSync(shadow(m.file), mutated, 'utf8');
  const out = runHarness();
  const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) { pass++; console.log('PASS  ' + m.label + '   → ' + m.expect); }
  else {
    fail++;
    console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）\n' +
      out.split('\n').filter((l) => l.startsWith('FAIL') || l.startsWith('Error') || l.includes('SyntaxError')).slice(0, 5).join('\n'));
  }
  restore(m.file);   // 还原，避免上一条变异污染下一条
}

// 语言包类变异：改影子目录里的 JSON，跑完还原
const LOCALE_CASES = [
  {
    label: '某个语言包漏了 toolbar.fullscreen（按钮文字显示键名）',
    expect: '带 toolbar.fullscreen',
    apply: (j) => { delete j.toolbar.fullscreen; },
  },
  {
    label: '某个语言包漏了 settings.showFullscreenButton（设置项显示键名）',
    expect: '带 settings.showFullscreenButton',
    apply: (j) => { delete j.settings.showFullscreenButton; },
  },
  {
    label: '某个语言包的值就是键名本身（等于没翻）',
    expect: '值不是键名本身',
    apply: (j) => { j.toolbar.exitFullscreen = 'toolbar.exitFullscreen'; },
  },
];
for (const c of LOCALE_CASES) {
  const rel = 'src/locales/ja-JP.json';
  const dst = path.join(tmpDir, rel);
  const j = JSON.parse(fs.readFileSync(dst, 'utf8'));
  c.apply(j);
  fs.writeFileSync(dst, JSON.stringify(j, null, 2) + '\n', 'utf8');
  const out = runHarness();
  const caught = out.split('\n').some((l) => l.startsWith('FAIL') && l.includes('ja-JP') && l.includes(c.expect));
  if (caught) { pass++; console.log('PASS  ' + c.label + '   → ja-JP ' + c.expect); }
  else {
    fail++;
    console.log('FAIL  [' + c.label + '] 没抓到（预期 ja-JP ' + c.expect + '）\n' +
      out.split('\n').filter((l) => l.startsWith('FAIL')).slice(0, 5).join('\n'));
  }
  restore(rel);
}

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
fs.rmSync(tmpDir, { recursive: true, force: true });
if (fail) process.exitCode = 1;
