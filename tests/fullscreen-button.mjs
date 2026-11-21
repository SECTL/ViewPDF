// 阅读器工具栏「全屏」按钮 + 设置开关 —— 行为 + 接线验证。
//
// 为什么必须真跑：全屏这条链路上几乎每一环都只有运行时才看得见 ——
//   · main_toggle_fullscreen 返回的是**实际结果**而非乐观假设，setFullscreen
//     被 ACL 拒绝时图标不能跟着谎报「已进入全屏」
//   · 状态同步只能由 isFullscreen() 的 IPC 回包驱动，回包乱序会让图标闪回旧态
//   · 开关的缺省方向（show !== false）与 Rust 默认值必须同向，否则老配置用户
//     打开就发现按钮不见了，而他们从没碰过这个开关
// 这三样静态正则全都看不出来，所以下面的方法体是从真实源码抠出来执行的。
import fs from 'node:fs';

const READER = 'src/modules/pdf/document_reader.js';
const MAIN = 'src/main.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const o = Object.is(got, want);
  if (o) pass++; else fail++;
  console.log((o ? 'PASS  ' : 'FAIL  ') + label + '   got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};
// Object.is 对两个数组实例永远为 false —— 逐项比才写得对。
const eqArr = (label, got, want) => eq(label, JSON.stringify(got), JSON.stringify(want));
const ok = (label, got) => eq(label, !!got, true);

// await 必须带超时兜底：永不 settle 的 Promise 会让事件循环空掉，Node 退出码 0，
// 断言被静默跳过而测试「通过」。见 AGENTS.md。
const settle = (p, ms = 500) => Promise.race([
  Promise.resolve(p).then(v => ({ v }), e => ({ e })),
  new Promise(r => setTimeout(() => r({ timeout: true }), ms)),
]);

const READER_SRC = fs.readFileSync(READER, 'utf8');
const MAIN_SRC = fs.readFileSync(MAIN, 'utf8');

// 源码断言前必须剥注释：这里新加的注释详细解释了「为什么没有 onFullscreenChange」
// 「为什么读当前态再置反」，里面**点名了** isFullscreen / setFullscreen / drBtnFullscreen /
// theme_load_icons / core:window:allow-set-fullscreen —— 不剥的话 includes() 命中的是注释，
// 「删掉它」「把它挪个位置」这两类变异全都测不出来而报告全绿。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

// document_reader.js 是 class（4 空格缩进方法，闭合 \n    }）；
// main.js 是模块级 function（闭合 \n}）。两种形状各一个提取器。
//
// 抠出来之后有两个必须做对的地方，否则症状与「功能没实现」毫无关系：
//   1. **形参要显式声明**。函数体引用 show / is_fullscreen，不声明就是 ReferenceError。
//   2. **async 方法要用 AsyncFunction**。new Function 造出来的普通函数里写 await
//      是语法错误（"await is only valid in async functions"）。
//   3. **document / window 是全局**。不把它们声明成形参，函数体就找不到 mock ——
//      症状是 ReferenceError: document is not defined。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// envNames 是抠出的函数体依赖、但**不是它自己形参**的名字，必须一并声明成形参，
// 否则 ReferenceError。main.js 里 main_toggle_fullscreen 用的是**裸引用**
// main_fetch_fullscreen()（同模块作用域），不是 window.main_fetch_fullscreen ——
// 真实运行没问题（main.js 是 ES module），沙箱里必须显式喂进去。
const build = (isAsync, params, body, name, envNames) => {
  try {
    return new (isAsync ? AsyncFunction : Function)(...envNames, ...params, body);
  } catch (e) {
    console.log('FAIL  抠 ' + name + ' 失败: ' + e.message);
    return null;
  }
};
const READER_ENV = ['document', 'window'];
const MAIN_ENV = ['document', 'window', 'main_fetch_fullscreen'];
function extractClassMethod(src, name) {
  const m = new RegExp('(?:^|\\n)    (async )?' + name + '\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(src);
  if (!m) return null;
  return build(!!m[1], m[2].split(',').map(s => s.trim()).filter(Boolean), m[3], name, READER_ENV);
}
function extractModuleFn(src, name) {
  const m = new RegExp('(?:^|\\n)(async )?function ' + name + '\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n\\}').exec(src);
  if (!m) return null;
  return build(!!m[1], m[2].split(',').map(s => s.trim()).filter(Boolean), m[3], name, MAIN_ENV);
}

// 把抠出的函数绑到一份 env 上，得到签名干净的包装器（调用时不用再传 env）
const bindEnv = (fn, envValues) => new Function('__fn', '__env',
  'return function (...a) { return __fn.call(this, ...__env, ...a); }')(fn, envValues);

const RAW = {
  toggleFS: extractClassMethod(READER_SRC, '_toggle_fullscreen'),
  setVisible: extractClassMethod(READER_SRC, '_set_fullscreen_btn_visible'),
  applyState: extractClassMethod(READER_SRC, '_apply_fullscreen_state'),
  setupSync: extractClassMethod(READER_SRC, '_setup_fullscreen_state_sync'),
  readVisibility: extractClassMethod(READER_SRC, '_update_fullscreen_btn_visibility'),
  mainToggle: extractModuleFn(MAIN_SRC, 'main_toggle_fullscreen'),
  mainFetch: extractModuleFn(MAIN_SRC, 'main_fetch_fullscreen'),
};
for (const [n, f] of Object.entries(RAW)) {
  eq('抠出 ' + n + '（是函数，不是求值结果）', typeof f, 'function');
}

// ===== mock =====
// 假按钮：只实现被用到的成员，但 classList 要给足 add/remove/toggle/contains ——
// mock 太薄本身就是一种假阴性：某个变异把 toggle 换成 remove 时，报出来的是
// 「btn.classList.remove is not a function」这种崩溃，而不是「这条守卫抓到了」。
const mkBtn = (withSpan = true) => {
  const classes = new Set();
  const btn = {
    style: { display: '' },
    title: '',
    attrs: {},
    span: withSpan ? { textContent: '' } : null,
    classList: {
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      toggle: (n, on) => { if (on === undefined) { classes.has(n) ? classes.delete(n) : classes.add(n); } else if (on) classes.add(n); else classes.delete(n); },
      contains: (n) => classes.has(n),
    },
    setAttribute(k, v) { btn.attrs[k] = v; },
    querySelector(sel) { return sel === 'span' ? btn.span : null; },
  };
  return btn;
};

// 一份 env → 一个可用的阅读器替身。方法都绑到这份 env 上，彼此通过 this 互相调用，
// 与真实 class 里的调用关系一致（setupSync 内部就是 this._apply_fullscreen_state）。
const mkKit = (btn, win) => {
  const doc = { getElementById: (id) => (id === 'drBtnFullscreen' ? btn : null) };
  const env = [doc, win];
  const r = { _show_fullscreen_btn: true, _fullscreen_sync_bound: false, _fullscreen_sync_token: 0, _applied: [] };
  const k = {
    r,
    doc,
    setVisible: bindEnv(RAW.setVisible, env),
    applyState: bindEnv(RAW.applyState, env),
    setupSync: bindEnv(RAW.setupSync, env),
    toggleFS: bindEnv(RAW.toggleFS, env),
    readVisibility: bindEnv(RAW.readVisibility, env),
  };
  r._set_fullscreen_btn_visible = v => k.setVisible.call(r, v);
  r._apply_fullscreen_state = v => { r._applied.push(v); return k.applyState.call(r, v); };
  r._toggle_fullscreen = () => k.toggleFS.call(r);
  r._setup_fullscreen_state_sync = () => k.setupSync.call(r);
  r._update_fullscreen_btn_visibility = () => k.readVisibility.call(r);
  return k;
};
// main.js 的两个 helper：main_toggle_fullscreen 内部按**裸引用**调
// main_fetch_fullscreen，所以 env 里必须把 fetch 自己喂进去。
const mkMain = (win) => {
  const fetch = bindEnv(RAW.mainFetch, [null, win, null]);
  return { fetch, toggle: bindEnv(RAW.mainToggle, [null, win, fetch]) };
};

const EN = 'Enter FS', EX = 'Exit FS';
const i18n = { format_translate: (k) => (k === 'toolbar.exitFullscreen' ? EX : k === 'toolbar.fullscreen' ? EN : k) };

const run = async () => {
  // ===== 1. 缺省方向：只有严格 false 才隐藏 =====
  // 断言存进字段的**值**：getter 式的读数方向与写入方向可能一起错。
  {
    const btn = mkBtn();
    const k = mkKit(btn, { i18n });
    k.setVisible.call(k.r, undefined);
    eq('不传参（老配置缺这个键）视为显示', k.r._show_fullscreen_btn, true);
    eq('  且 DOM 上真的可见', btn.style.display, '');

    for (const v of [true, 1, 'true', {}, [], 'yes', null]) {
      const b = mkBtn();
      const kk = mkKit(b, { i18n });
      kk.setVisible.call(kk.r, v);
      eq(`非严格 false（${JSON.stringify(v)}）→ 显示`, kk.r._show_fullscreen_btn, true);
    }
    const b2 = mkBtn();
    const k2 = mkKit(b2, { i18n });
    k2.setVisible.call(k2.r, false);
    eq('false → 隐藏', k2.r._show_fullscreen_btn, false);
    eq('  且写进 DOM', b2.style.display, 'none');
    k2.setVisible.call(k2.r, true);
    eq('再打开 → 恢复', b2.style.display, '');
  }

  // ===== 2. 状态 → 图标 / 文案 =====
  {
    const btn = mkBtn();
    const k = mkKit(btn, { i18n });
    k.applyState.call(k.r, true);
    eq('全屏中：加 is-fullscreen 类', btn.classList.contains('is-fullscreen'), true);
    eq('  title 是「退出」', btn.title, EX);
    eq('  aria-label 同步', btn.attrs['aria-label'], EX);
    eq('  span 文案同步', btn.span.textContent, EX);
    k.applyState.call(k.r, false);
    eq('非全屏：移除 is-fullscreen 类', btn.classList.contains('is-fullscreen'), false);
    eq('  title 回到「进入」', btn.title, EN);
    eq('  span 文案回到「进入」', btn.span.textContent, EN);
  }
  {
    // 只有严格 true 才算全屏。isFullscreen 的 IPC 回包理论上不会带脏值，
    // 但归一化只应有一处 —— 这里确认没有第二处宽松真值判断。
    const btn = mkBtn();
    const k = mkKit(btn, { i18n });
    k.applyState.call(k.r, 1);
    eq('数值 1 不算全屏（不误加类）', btn.classList.contains('is-fullscreen'), false);
    eq('  文案按「进入」', btn.title, EN);
  }
  {
    // ⚠️ `format_translate(key) || fallback` 这个写法**接不住缺键**：缺键时它返回
    // **键本身**（非空串，真值），`||` 永不触发，title 会变成 "toolbar.exitFullscreen"。
    // 本仓库统一的兜底写法就是 `|| fb`（document_reader.js 内部 translate/t 皆如此），
    // 真正的护栏是下面第 12 组的 9 语言包检查。这条断言守的是「不空白」，
    // 别把它改成「等于中文兜底」—— 那会把一个本仓库共有的写法差异当成 bug。
    const btn = mkBtn();
    const k = mkKit(btn, { i18n: { format_translate: (key) => key } });
    k.applyState.call(k.r, true);
    eq('i18n 返回键名时 title 不为空（不空白）', btn.title.length > 0, true);
  }
  {
    const btn = mkBtn();
    const k = mkKit(btn, {});
    k.applyState.call(k.r, true);
    eq('i18n 完全缺失时用兜底文案且不抛', btn.title, '退出全屏');
  }
  {
    // 按钮还没建（工具栏未初始化）时不能抛 —— sync 在 init 早期就会跑一次
    const k = mkKit(null, { i18n });
    const res = await settle(Promise.resolve().then(() => k.applyState.call(k.r, true)));
    eq('按钮缺失时 _apply_fullscreen_state 不抛', res.e, undefined);
  }
  {
    // markup 里那个 <span> 是「工具栏文字提示」开关的作用对象；它没了也不该抛
    const btn = mkBtn(false);
    const k = mkKit(btn, { i18n });
    const res = await settle(Promise.resolve().then(() => k.applyState.call(k.r, true)));
    eq('无 span 节点时不抛', res.e, undefined);
    eq('  title 仍然写对了', btn.title, EX);
  }

  // ===== 3. 点击：UI 必须由返回值驱动，而不是乐观假设 =====
  // 这是本次最容易写错的一处。setFullscreen 在缺 core:window:allow-set-fullscreen
  // 权限时会被 ACL 拒绝（调用 reject），此时若写死 _apply_fullscreen_state(true)，
  // 窗口没进全屏而图标已经变成「退出全屏」—— 用户再点一次是「再次进入」，
  // 于是永远出不来，而控制台只有一条被 catch 掉的 warn。
  {
    const btn = mkBtn();
    const k = mkKit(btn, { i18n, main_toggle_fullscreen: async () => true });
    await settle(k.toggleFS.call(k.r));
    eq('切换成功：以返回值 true 渲染', btn.classList.contains('is-fullscreen'), true);

    const btn2 = mkBtn();
    const k2 = mkKit(btn2, { i18n, main_toggle_fullscreen: async () => false });
    await settle(k2.toggleFS.call(k2.r));
    eq('切换失败（返回 false）：不得乐观加类', btn2.classList.contains('is-fullscreen'), false);

    const btn3 = mkBtn();
    const k3 = mkKit(btn3, { i18n, main_toggle_fullscreen: async () => undefined });
    await settle(k3.toggleFS.call(k3.r));
    eq('返回 undefined（helper 缺失）：按非全屏处理', btn3.classList.contains('is-fullscreen'), false);

    const btn4 = mkBtn();
    const k4 = mkKit(btn4, {});
    const res = await settle(k4.toggleFS.call(k4.r));
    eq('helper 完全缺失时不抛', res.e, undefined);
  }

  // ===== 4. 状态同步：回包乱序不能把图标闪回旧态 =====
  // onResized 在拖窗口/缩放时高频触发，isFullscreen() 是跨进程 IPC。去掉代次令牌后，
  // 先发的慢回包会后到并覆盖新状态 —— 表现为刚进全屏图标又跳回「进入」。
  {
    const btn = mkBtn();
    const gates = [];
    const k = mkKit(btn, {
      i18n,
      __TAURI__: { window: { getCurrentWindow: () => ({ onResized: () => {}, onFocusChanged: () => {} }) } },
      main_fetch_fullscreen: () => new Promise(res => gates.push(res)),
    });
    k.setupSync.call(k.r);
    ok('同步先做了一次初始查询', gates.length === 1);
    const first = gates[0];
    k.r._sync_fullscreen_state();          // 第二轮发出，第一轮压着不回
    eq('第二次同步也发了查询', gates.length, 2);
    gates[1](true);                        // 新回包先到：全屏
    await settle(Promise.resolve());
    eq('  新回包生效：全屏', btn.classList.contains('is-fullscreen'), true);
    first(false);                          // 旧回包后到 —— 必须被丢弃
    await settle(Promise.resolve());
    eq('  过期回包被丢弃（不闪回）', btn.classList.contains('is-fullscreen'), true);
  }
  {
    // 反向：过期回包说「全屏」而最新回包说「非全屏」，同样不能被旧值覆盖
    const btn = mkBtn();
    const gates = [];
    const k = mkKit(btn, {
      i18n,
      __TAURI__: { window: { getCurrentWindow: () => ({ onResized: () => {}, onFocusChanged: () => {} }) } },
      main_fetch_fullscreen: () => new Promise(res => gates.push(res)),
    });
    k.setupSync.call(k.r);
    const first = gates[0];
    k.r._sync_fullscreen_state();
    gates[1](false);
    await settle(Promise.resolve());
    first(true);
    await settle(Promise.resolve());
    eq('过期回包说全屏也不得覆盖最新的非全屏', btn.classList.contains('is-fullscreen'), false);
  }
  {
    // 注册完整性：JS 侧 Window 没有 onFullscreenChange（只有 onCloseRequested /
    // onDragDropEvent / onFocusChanged / onMoved / onResized / onScaleChanged /
    // onThemeChanged），所以必须靠 resize + focus 两个通道。
    const seen = [];
    const btn = mkBtn();
    const k = mkKit(btn, {
      i18n,
      __TAURI__: { window: { getCurrentWindow: () => ({
        onResized: (cb) => { seen.push('resized'); cb(); return Promise.resolve(); },
        onFocusChanged: (cb) => { seen.push('focus'); cb(); return Promise.resolve(); },
      }) } },
      main_fetch_fullscreen: async () => false,
    });
    k.setupSync.call(k.r);
    await settle(Promise.resolve());
    await settle(Promise.resolve());
    ok('挂了 onResized', seen.includes('resized'));
    ok('挂了 onFocusChanged', seen.includes('focus'));
    eq('绑定标记已置位', k.r._fullscreen_sync_bound, true);

    // 重复调用不得重复注册（init 若被调两次，一次点击会切两次 → 看起来像没反应）
    const before = seen.length;
    k.setupSync.call(k.r);
    await settle(Promise.resolve());
    eq('第二次调用不重复注册', seen.length, before);
  }
  {
    // 注册抛错（无 Tauri 环境 / 权限缺失）不应阻断工具栏其余按钮的绑定
    const k = mkKit(mkBtn(), {
      i18n,
      __TAURI__: { window: { getCurrentWindow: () => ({
        onResized: () => Promise.reject(new Error('acl denied')),
        onFocusChanged: () => Promise.reject(new Error('acl denied')),
      }) } },
      main_fetch_fullscreen: async () => false,
    });
    const res = await settle(Promise.resolve().then(() => k.setupSync.call(k.r)));
    eq('onResized 拒绝时不抛', res.e, undefined);
  }
  {
    const k = mkKit(mkBtn(), { i18n });
    const res = await settle(Promise.resolve().then(() => k.setupSync.call(k.r)));
    eq('无 Tauri 时安全跳过', res.e, undefined);
    eq('  且不置绑定标记（等真有 Tauri 时再挂）', k.r._fullscreen_sync_bound, false);
  }

  // ===== 5. 开关回填 =====
  {
    const btn = mkBtn();
    const k = mkKit(btn, { i18n, __TAURI__: { core: { invoke: async () => ({ settings: {} }) } } });
    await settle(k.readVisibility.call(k.r));
    eq('配置缺键 → 显示', k.r._show_fullscreen_btn, true);

    const b2 = mkBtn();
    const k2 = mkKit(b2, { i18n, __TAURI__: { core: { invoke: async () => ({ settings: { showFullscreenButton: false } }) } } });
    await settle(k2.readVisibility.call(k2.r));
    eq('配置 false → 隐藏', b2.style.display, 'none');

    const b3 = mkBtn();
    const k3 = mkKit(b3, { i18n, __TAURI__: { core: { invoke: async () => { throw new Error('io'); } } } });
    await settle(k3.readVisibility.call(k3.r));
    eq('配置读失败 → 仍显示（不把按钮弄丢）', k3.r._show_fullscreen_btn, true);

    const k4 = mkKit(mkBtn(), { i18n });
    const res = await settle(k4.readVisibility.call(k4.r));
    eq('无 Tauri 时不抛', res.e, undefined);
  }

  // ===== 6. main_toggle_fullscreen / main_fetch_fullscreen =====
  {
    const calls = [];
    const win = {
      __TAURI__: { window: { getCurrentWindow: () => ({
        setFullscreen: async (v) => { calls.push(v); },
        isFullscreen: async () => false,
      }) } },
    };
    const m = mkMain(win);
    const r = await settle(m.toggle.call(null));
    eqArr('当前非全屏 → 请求进入', calls, [true]);
    eq('  返回切换后的状态 true', r.v, true);

    calls.length = 0;
    win.__TAURI__.window.getCurrentWindow = () => ({
      setFullscreen: async (v) => { calls.push(v); },
      isFullscreen: async () => true,
    });
    const r2 = await settle(m.toggle.call(null));
    eqArr('当前已全屏 → 请求退出（而不是无脑置 true）', calls, [false]);
    eq('  返回切换后的状态 false', r2.v, false);
  }
  {
    // 权限缺失 → setFullscreen reject。必须把**未改变**的状态原样回传，
    // 上层据此保持图标不变；抛出去或返回乐观值都会让图标说谎。
    const win = {
      __TAURI__: { window: { getCurrentWindow: () => ({
        setFullscreen: async () => { throw new Error('window.set_fullscreen not allowed'); },
        isFullscreen: async () => false,
      }) } },
    };
    // 这条场景**预期**会有一次 console.warn（代码里 catch 后 warn）。静音它，
    // 否则整份报告被栈帧刷满、真正的 FAIL 行被淹没。
    const real_warn = console.warn;
    console.warn = () => {};
    let r;
    try { r = await settle(mkMain(win).toggle.call(null)); }
    finally { console.warn = real_warn; }
    eq('setFullscreen 被拒：回传未改变的状态 false', r.v, false);
    eq('  且不抛（控制台安静）', r.e, undefined);
  }
  {
    // 最大化状态下进全屏必须先 unmaximize：否则 Windows 上任务栏那条
    // 区域会留成黑边（最大化窗口的恢复区是工作区，不是整屏）。
    const calls = [];
    const win = {
      __TAURI__: { window: { getCurrentWindow: () => ({
        setFullscreen: async (v) => { calls.push('setFullscreen:' + v); },
        isFullscreen: async () => false,
        isMaximized: async () => true,
        unmaximize: async () => { calls.push('unmaximize'); },
      }) } },
    };
    const r = await settle(mkMain(win).toggle.call(null));
    eq('最大化 → 进全屏成功', r.v, true);
    eqArr('先还原再 setFullscreen（顺序不能反）', calls, ['unmaximize', 'setFullscreen:true']);

    calls.length = 0;
    win.__TAURI__.window.getCurrentWindow = () => ({
      setFullscreen: async (v) => { calls.push('setFullscreen:' + v); },
      isFullscreen: async () => true,
      isMaximized: async () => true,
      unmaximize: async () => { calls.push('unmaximize'); },
    });
    const r2 = await settle(mkMain(win).toggle.call(null));
    eq('退出全屏仍只发 false', r2.v, false);
    eqArr('退出时不还原最大化（不动用户窗口布局）', calls, ['setFullscreen:false']);
  }
  {
    // ⚠️ 下面一律写成 `(await settle(...)).v` 而不是 `await settle(...).v` ——
    // 成员访问的优先级高于 await，`await f(x).v` 实际是 `await (f(x).v)`，
    // 于是比的是 undefined，全绿而什么都没验。
    const mk = (isFullscreen) => mkMain({ __TAURI__: { window: { getCurrentWindow: () => ({ isFullscreen }) } } });
    eq('isFullscreen true → true', (await settle(mk(async () => true).fetch.call(null))).v, true);
    eq('非布尔回包归一为 false', (await settle(mk(async () => 'yes').fetch.call(null))).v, false);
    eq('isFullscreen 抛错 → false（不炸掉同步链）', (await settle(mk(async () => { throw new Error('x'); }).fetch.call(null))).v, false);
    eq('无 Tauri → false', (await settle(mkMain({}).fetch.call(null))).v, false);
    eq('无 Tauri 时切换安全返回 false', (await settle(mkMain({}).toggle.call(null))).v, false);
  }

  // ===== 7. 权限：setFullscreen 不在 core:window:default 里 =====
  // 官方 window 命名空间文档明写：core:window:default 只放开 getter 与 is* 查询，
  // 「每一个会改变窗口的方法都需要自己的权限」。漏这条时调用被 ACL 拒绝，
  // 症状是按钮点了毫无反应、控制台只有一条被 catch 的 warn。
  {
    const cap = JSON.parse(fs.readFileSync('src-tauri/capabilities/default.json', 'utf8'));
    ok('capability 里有 core:window:allow-set-fullscreen',
      cap.permissions.includes('core:window:allow-set-fullscreen'));
    ok('capability 里显式声明 core:window:allow-is-fullscreen',
      cap.permissions.includes('core:window:allow-is-fullscreen'));
    ok('权限列在覆盖 main 窗口的 default capability 上', cap.windows.includes('main'));
  }

  // ===== 8. 素材：两个图标 × 两个主题 =====
  const THEMES = ['com.viewstage.theme.simplify', 'com.viewstage.theme.dark'];
  const svgs = {};
  for (const t of THEMES) {
    for (const n of ['fullscreen', 'fullscreen-exit']) {
      let body = null;
      try { body = fs.readFileSync(`src/themes/${t}/icons/${n}.svg`, 'utf8').trim(); } catch (_) {}
      ok(`${t} 有 ${n}.svg`, body);
      svgs[t + '/' + n] = body;
      // 取色必须跟着主题走，且**不能残留任何硬编码颜色**。
      // 断言写成「用了 currentColor」而不是「stroke=currentColor」：字形是描边还是
      // 填充与这条不变式无关（Fluent 是纯填充路径），写死某一种就等于把守卫
      // 绑在素材的当前画法上 —— 换字形库时它会以「守卫失败」的名义误报。
      // Fluent 原始素材是 fill="#212121"，直接搬进来在深色主题上几乎不可见。
      ok(`  ${n}.svg 跟随主题取色（currentColor 且无硬编码颜色）`,
        body && /currentColor/.test(body)
          && !/fill="#[0-9a-f]{3,8}"/i.test(body) && !/stroke="#[0-9a-f]{3,8}"/i.test(body));
      // 出处随文件走：MIT 要求保留许可声明，而 README / CHANGELOG 里的致谢
      // 不会跟着被替换掉的文件走 —— 换素材时最容易连注释一起删干净。
      ok(`  ${n}.svg 注明了出处与许可`, body && /Fluent System Icons/.test(body) && /MIT/.test(body));
    }
    const j = JSON.parse(fs.readFileSync(`src/themes/${t}/theme.json`, 'utf8'));
    for (const n of ['fullscreen', 'fullscreen-exit']) {
      const v = j.icons?.[n];
      ok(`${t} theme.json.icons.${n} 已登记`, typeof v === 'string' && v !== '');
      // 登记的值必须指向真实文件：写错名字时 theme_fetch_icon_path 回落到字面名，
      // <img> 拿到一条 404，图标空白且不报错
      if (typeof v === 'string') {
        let exists = false;
        try { fs.readFileSync(`src/themes/${t}/icons/${v}.svg`); exists = true; } catch (_) {}
        ok(`  ${t} 的 icons.${n} 指向的文件存在（${v}.svg）`, exists);
      }
    }
  }
  for (const n of ['fullscreen', 'fullscreen-exit']) {
    eq(`两个主题的 ${n}.svg 内容一致`, svgs[THEMES[0] + '/' + n], svgs[THEMES[1] + '/' + n]);
  }
  ok('两枚图标内容不同（进/退不能是同一张）',
    svgs[THEMES[0] + '/fullscreen'] !== svgs[THEMES[0] + '/fullscreen-exit']);

  // ===== 9. 接线：按钮 =====
  const R = stripComments(READER_SRC);
  {
    const at = R.indexOf('id="drBtnFullscreen"');
    ok('工具栏里有 drBtnFullscreen 按钮', at > 0);
    const near = R.slice(at, at + 420);
    ok('  带 data-icon="fullscreen"', near.includes('data-icon="fullscreen"'));
    ok('  带 data-icon="fullscreen-exit"', near.includes('data-icon="fullscreen-exit"'));
    ok('  两枚图标各有 tb-glyph-* 类（CSS 二选一靠它）',
      near.includes('tb-glyph-enter') && near.includes('tb-glyph-exit'));
  }
  {
    // theme_load_icons() 只在启动时扫一次 [data-icon]，而本工具栏是
    // documentReaderManager.init() 里现建的（晚于那次扫描）。不补这一次，
    // 按钮图标停在无 src 的空白 —— 尤其致命：两枚 <img> 靠 CSS 二选一，
    // 缺 src 的那枚永远画不出来，退出图标也不会在切换时出现。
    const m = /_create_toolbar\(\)\s*\{([\s\S]*?)\n    \}/.exec(R);
    ok('抠到 _create_toolbar', !!m);
    ok('_create_toolbar 里补了 theme_load_icons', m && /theme_load_icons/.test(m[1]));
  }
  {
    const m = /_setup_toolbar_events\(\)\s*\{([\s\S]*?)\n    \}/.exec(R);
    ok('抠到 _setup_toolbar_events', !!m);
    ok('绑定了 drBtnFullscreen 的 click',
      m && /getElementById\('drBtnFullscreen'\)[\s\S]{0,200}?addEventListener\('click'/.test(m[1]));
    ok('注册了全屏状态同步', m && /_setup_fullscreen_state_sync\(\)/.test(m[1]));
    ok('启动时回填开关可见性', m && /_update_fullscreen_btn_visibility\(\)/.test(m[1]));
  }
  {
    // 反向接线：main_toggle_fullscreen 必须在 window 上导出，否则 reader 里的
    // `window.main_toggle_fullscreen?.()` 静默变 undefined → 点击毫无反应
    ok('main.js 把 main_toggle_fullscreen 挂到 window',
      /window\.main_toggle_fullscreen\s*=\s*main_toggle_fullscreen/.test(MAIN_SRC));
    ok('main.js 把 main_fetch_fullscreen 挂到 window',
      /window\.main_fetch_fullscreen\s*=\s*main_fetch_fullscreen/.test(MAIN_SRC));
    eq('main_toggle_fullscreen 定义恰好一处',
      (MAIN_SRC.match(/function main_toggle_fullscreen/g) || []).length, 1);
  }

  // ===== 10. 接线：CSS 二选一 =====
  {
    const css = stripComments(fs.readFileSync('src/styles.css', 'utf8'));
    ok('默认隐藏退出图标', /#drBtnFullscreen\s+\.tb-glyph-exit\s*\{[^}]*display:\s*none/.test(css));
    ok('全屏中隐藏进入图标', /#drBtnFullscreen\.is-fullscreen\s+\.tb-glyph-enter\s*\{[^}]*display:\s*none/.test(css));
    ok('全屏中显示退出图标', /#drBtnFullscreen\.is-fullscreen\s+\.tb-glyph-exit\s*\{[^}]*display:\s*block/.test(css));
    // 少了「默认隐藏退出图标」这条，两枚图标会同时可见 → 按钮上是两个叠着的图标。
    // 同时守住「都挂在 #drBtnFullscreen 上」，避免误伤标题栏那套 .tb-glyph-max。
    eq('#drBtnFullscreen 规则恰好三条', (css.match(/#drBtnFullscreen[^{]*\{/g) || []).length, 3);
  }

  // ===== 11. 接线：设置开关 =====
  {
    const panel = fs.readFileSync('src/modules/settings/settings-panel.js', 'utf8');
    eq('settings-panel 里 fullscreenButtonToggle 恰好一处',
      (panel.match(/id="fullscreenButtonToggle"/g) || []).length, 1);
    const at = panel.indexOf('id="fullscreenButtonToggle"');
    ok('存在开关节点', at > 0);
    const before = panel.slice(Math.max(0, at - 240), at);
    ok('同一 setting-item 带 data-i18n="settings.showFullscreenButton"',
      before.includes('data-i18n="settings.showFullscreenButton"'));
    ok('开关落在 #pageApp（应用设置）页里',
      panel.indexOf('id="pageApp"') < at && at < panel.indexOf('id="pageCanvas"'));

    const s = fs.readFileSync('src/modules/settings/settings.js', 'utf8');
    ok('回填开关状态且缺省方向为显示',
      s.includes('fullscreenButtonToggle.checked = settings.showFullscreenButton !== false'));
    ok('切换时保存到配置', s.includes('settings_save_all_local({ showFullscreenButton: enabled })'));
    ok('切换时立即应用（不必重开应用）',
      s.includes('documentReaderManager?._set_fullscreen_btn_visible?.(enabled)'));

    // Rust 默认值：放进 config_fetch_default 才能吃到 config_validate_and_merge 的
    // bool 类型校验（未知键不校验），且必须为 true —— 与前端的 !== false 同向。
    // 写成 false 的话「升级前没这个键」的老配置与「用户主动关掉」无法区分。
    const rs = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
    ok('config_fetch_default 里 showFullscreenButton 为 true',
      /"showFullscreenButton"\s*:\s*true/.test(rs));
  }

  // ===== 12. 9 个语言包 =====
  const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'ru-RU'];
  // 代码里真实引用到的 i18n 键：从抠出的函数体里扫出来，而不是手抄一份。
  // 手抄的清单会随代码漂移，然后「界面显示 settings.xxx」这类症状几个月后才冒出来。
  const referenced = new Set();
  for (const m of String(RAW.applyState).matchAll(/format_translate\('([^']+)'\)/g)) referenced.add(m[1]);
  const EXPECTED = ['toolbar.fullscreen', 'toolbar.exitFullscreen'].sort();
  eq('代码引用的 toolbar.* 键正好是这两个', [...referenced].sort().join(','), EXPECTED.join(','));

  for (const loc of LOCALES) {
    const j = JSON.parse(fs.readFileSync(`src/locales/${loc}.json`, 'utf8'));
    for (const kk of EXPECTED) {
      const v = kk.split('.').reduce((o, p) => (o ? o[p] : undefined), j);
      ok(`${loc} 带 ${kk}`, typeof v === 'string' && v.trim() !== '');
      // 标签里带上 loc：否则「第 N 个语言包的值就是键名」这类变异，报告里是一行
      // 不含语言名的 FAIL，定位不到是哪个语言包。
      ok(`${loc} 的 ${kk} 值不是键名本身（否则等于没翻）`, v !== kk);
    }
    const sv = j.settings?.showFullscreenButton;
    ok(`${loc} 带 settings.showFullscreenButton`, typeof sv === 'string' && sv.trim() !== '');
    ok(`${loc} 的 settings.showFullscreenButton 值不是键名本身`, sv !== 'settings.showFullscreenButton');
  }

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) process.exitCode = 1;
};

await run();
