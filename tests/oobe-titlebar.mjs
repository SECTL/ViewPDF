// 真跑 OOBE 里「独立成步的开关」的接线。
//
// 本轮把两个界面显示开关各自挪成了独立的一步（标题栏样式、工具栏文字提示）。
// 它们的风险完全同构，而且**每种接错方式都不报错**，只是安静地改掉用户偏好：
//   - mergeSettings 漏掉这个键        → 用户在 OOBE 勾了，保存时静默丢弃
//   - 元素缺失时兜底方向写反           → 没碰过开关的用户被静默改成另一种设置
//   - 导入配置时不接住                → 导入的偏好被默认值覆盖，界面上看不出发生过什么
//   - 步骤下标漏改                    → 静默跳错页（新步骤没出现）
//
// 所以写成数据驱动：新增开关只需在 SWITCHES 里加一行，行为与源码守卫自动覆盖。
// `default` 必须与 lib.rs settings_defaults 一致 —— 这里会真的比对两个文件。
import fs from 'node:fs';
import path from 'node:path';

// OOBE_SRC 指向 src/ 的副本时（变异测试会把 src 与 src-tauri 一起复制过去），
// 必须从副本读 —— 否则变异打在副本上、断言读的是真实工作区，变异测试就成了恒绿。
const SRC_DIR = process.env.OOBE_SRC || 'src';
const APP_ROOT = path.resolve(SRC_DIR, '..');
const SRC = fs.readFileSync(path.join(SRC_DIR, 'oobe.js'), 'utf8');

let pass = 0, fail = 0;
const str = (v) => (typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());
function eq(label, got, want) {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + str(got) + ' want=' + str(want));
}
function ok(label, got) { eq(label, !!got, true); }

// ---------- 抠出真函数体 ----------
function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`未定位到 ${name}`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    const c = SRC[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(start, j + 1); }
  }
  throw new Error(`${name} 括号未配平`);
}

// 剥注释但保留字符串字面量里的双斜杠（与 dpr-harness 的 stripSrc 同一约定）
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const body = strip(SRC);

const gatherSrc = extract('gatherStepData');
const mergeSrc = extract('mergeSettings');
const setupThemeSrc = extract('setupTheme');
// importConfig 走 Tauri 的 dialog/fs，没法在 node 里跑，只能抠出源码做结构断言。
// ⚠️ 这里必须锚在 **importConfig 的函数体内**：全文搜 `typeof settings.X === 'boolean'`
// 会被别的函数里的同名写法满足，等于没有守卫。
const importSrc = extract('importConfig');

// STEP 从**源码**解析出来注入，不在 harness 里另抄一份 —— 抄一份就会漂移，
// 而漂移的表现是「测试全绿、实际跑到别的步」。
const stepRe = /const STEP = \{([\s\S]*?)\n\};/.exec(SRC);
const STEP = stepRe
  ? Object.fromEntries([...stepRe[1].matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]))
  : {};

/**
 * OOBE 里每个「独立成步的开关」。
 *  default 必须等于 lib.rs settings_defaults 里的同名键 —— 下面会真的比对。
 */
const SWITCHES = [
  {
    name: 'macOS 样式标题栏',
    key: 'macosTitleBar',
    step: 'titleBar',
    el: 'macosTitleBarToggle',
    setup: 'setupTitleBar',
    default: true,
    labelKey: 'settings.macosTitleBar',
    hintKey: 'settings.macosTitleBarHint',
  },
  {
    name: '工具栏文字提示',
    key: 'showToolbarText',
    step: 'toolbarText',
    el: 'toolbarTextToggle',
    setup: 'setupToolbarText',
    default: false,   // 与 settings_defaults 的 showToolbarText: false 一致
    labelKey: 'settings.toolbarText',
    hintKey: 'settings.toolbarTextHint',
  },
];

for (const s of SWITCHES) {
  if (STEP[s.step] === undefined) {
    console.error(`STEP 表里没有 ${s.step}`);
    process.exit(1);
  }
}

// ---------- 极简 DOM 替身 ----------
// 只实现真正用到的东西；缺什么就返回 null，让「元素缺失」那条分支真的能被走到。
function make_doc(elStates) {
  const els = new Map(Object.entries(elStates || {}));
  const panel = {
    querySelector: (sel) => (sel.includes('card.selected') ? { dataset: { theme: 'com.viewstage.theme.dark' } } : null),
  };
  return {
    getElementById: (id) => (els.has(id) ? { checked: els.get(id) } : null),
    querySelector: (sel) => (sel.includes('data-step="1"') ? panel : null),
  };
}

const PEN_COLORS = [{ r: 1, g: 2, b: 3 }];
const $ = () => null;   // gatherStepData 里语言步才用得到

function make_state(over) {
  return Object.assign({
    step: STEP.language, language: 'zh-CN', theme: 'com.viewstage.theme.dark',
    penEffectMode: 'full', dynamicDprEnabled: true, frameRateMode: 'high',
    renderPerfTier: 'balanced', blackboardEnabled: true, restoreLastDoc: true,
    macosTitleBar: true, showToolbarText: false, importedSettings: null,
  }, over);
}

function build(state, document) {
  const factory = new Function(
    'document', 'state', 'PEN_COLORS', '$', 'STEP',
    `${gatherSrc}\n${mergeSrc}\nreturn { gatherStepData, mergeSettings };`,
  );
  return factory(document, state, PEN_COLORS, $, STEP);
}

for (const s of SWITCHES) {
  console.log(`--- gatherStepData：读「${s.name}」开关（步 ${STEP[s.step]}）---`);
  const doc = (checked) => make_doc({ [s.el]: checked });

  for (const v of [true, false]) {
    const state = make_state();
    build(state, doc(v)).gatherStepData(STEP[s.step]);
    eq(`勾选框为${v ? '开' : '关'} → state 跟随 ${v}`, state[s.key], v);
  }
  {
    // 关键兜底：元素不存在时的回落方向必须等于各自的默认值。
    // ⚠️ 必须**整个省略**该元素，不能塞一个 undefined 值 ——
    // Map.has() 对 undefined 值仍返回 true，于是 getElementById 会给出一个
    // checked===undefined 的「元素」，兜底分支根本没被走到（第一版就是这么错的）。
    const state = make_state();
    build(state, make_doc({})).gatherStepData(STEP[s.step]);
    eq(`元素缺失 → 回落 ${s.default}（等于 Rust 默认值）`, state[s.key], s.default);
  }
  {
    // 走到别的步不应被这个开关改动
    const state = make_state({ [s.key]: !s.default });
    build(state, doc(s.default)).gatherStepData(STEP.drawing);
    eq('走到别的步时不误改', state[s.key], !s.default);
  }
  {
    const state = make_state({ [s.key]: !s.default });
    const out = build(state, doc(!s.default)).mergeSettings();
    eq('状态被写入最终配置', out[s.key], !s.default);
    ok('键确实存在（不是 undefined 被静默吞掉）', s.key in out);
  }
  {
    // 导入配置：mergeSettings 里 OOBE 显式管理的键会覆盖导入值，
    // 所以 importConfig 必须把导入的偏好接进 state，否则这里写回默认值。
    //
    // ⚠️ 下面两段是**后果演示**，不是守卫 —— 它演示的是「如果没人接住导入值会
    // 怎样」，而这个演示本身恒绿，与 oobe.js 里真的 importConfig 有没有写接管
    // 逻辑毫无关系。真正的守卫在下面的源码层（`importConfig 必须接住导入值`），
    // 由 importConfig 的真实函数体判定。第一版误以为这里就能测到，变异测试
    // 删掉 importConfig 的接管逻辑后 harness 依然全绿，才暴露出来。
    const imported = !s.default;
    const uncaught = make_state({ importedSettings: { [s.key]: imported } });
    eq('后果演示：导入值但无人接住 → 被默认值覆盖',
      build(uncaught, doc(s.default)).mergeSettings()[s.key], s.default);
    const caught = make_state({ importedSettings: { [s.key]: imported } });
    if (typeof caught.importedSettings[s.key] === 'boolean') caught[s.key] = caught.importedSettings[s.key];
    eq('后果演示：有人接住 → 导入值存活', build(caught, doc(imported)).mergeSettings()[s.key], imported);
    // 导入非布尔值不应污染（老配置里可能是字符串/缺失）
    const dirty = make_state({ importedSettings: { [s.key]: 'false' } });
    if (typeof dirty.importedSettings[s.key] === 'boolean') dirty[s.key] = dirty.importedSettings[s.key];
    eq('后果演示：导入非布尔值 → 不采纳，保留默认', dirty[s.key], s.default);
  }
}

console.log('--- setup 函数：change 监听真的回写 state ---');
// 这里**不用正则**。先前那条守卫写成
//   /macosTitleBarToggle[\s\S]{0,200}state\.macosTitleBar\s*=/
// 结果 gatherStepData 里的同名赋值也满足它 —— 把监听器改成空实现，守卫照样绿。
// 是变异测试判定「抓不到该变异」才发现的。改成真跑：装一个记录监听的 DOM，
// 派发 change，断言 state 真的变了。
for (const s of SWITCHES) {
  const setupSrc = extract(s.setup);
  const run = (state, checked) => {
    const handlers = {};
    const toggle = { checked, addEventListener: (t, fn) => { handlers[t] = fn; } };
    const doc = { getElementById: (id) => (id === s.el ? toggle : null) };
    // ⚠️ 末尾的 `()` 不能省：只构造不调用的话监听器从未注册，
    // 而 `handlers.change === undefined` 会被当成「setup 有问题」——
    // 第一版就踩了这个，症状是四条断言全红却指向错误的结论。
    const fn = new Function('document', 'state', `${setupSrc}\nreturn ${s.setup};`)(doc, state);
    fn();
    return handlers;
  };
  for (const v of [true, false]) {
    const state = make_state({ [s.key]: !v });
    const handlers = run(state, v);
    ok(`${s.setup}：change 监听已注册`, typeof handlers.change === 'function');
    handlers.change?.({ target: { checked: v } });
    eq(`${s.setup}：勾选 ${v} 后 state 跟随`, state[s.key], v);
  }
}
{
  // 开关不在「外观」步 anymore —— 若监听仍留在 setupTheme，这几步就没人注册
  const grid = { addEventListener: () => {} };
  const panel = { querySelector: (sel) => (sel.includes('card-grid') ? grid : null) };
  const themeDoc = {
    querySelector: (sel) => (sel.includes('data-step="1"') ? panel : null),
    getElementById: (id) => (SWITCHES.some((s) => s.el === id) ? { addEventListener: () => {} } : null),
  };
  new Function('document', 'state', 'window', '$$', `${setupThemeSrc}\nreturn setupTheme;`)(
    themeDoc, make_state(), { ThemeManager: null }, () => [],
  )();
  eq('setupTheme 不再绑定任何开关（它们已各自独占一步）', grid.addEventListener === undefined, false);
}

console.log('--- 步骤表结构（插入步骤时最容易被漏掉的地方）---');
{
  const entries = stepRe
    ? [...stepRe[1].matchAll(/(\w+):\s*(\d+)/g)].map((m) => ({ id: m[1], i: Number(m[2]) }))
    : [];
  eq('下标连续无洞', entries.map((e) => e.i).join(','),
    entries.map((_, n) => n).join(','));
  eq('步骤数 = STEP 条目数 = STEPS 派生源', entries.length, Object.keys(STEP).length);

  // 每个开关的步骤必须排在 checkUpdate 之后、complete 之前
  for (const s of SWITCHES) {
    const i = STEP[s.step];
    ok(`${s.step} 排在 checkUpdate 之后`, i > STEP.checkUpdate);
    ok(`${s.step} 排在 complete 之前`, i < STEP.complete);
  }

  ok('STEPS 由 STEP 派生', /const STEPS = Object\.keys\(STEP\)\.map/.test(body));

  // STEP_TPL 条数必须与步骤数一致：少一条 = 末步空白，多一条 = 永远走不到。
  // ⚠️ 必须数**原文** SRC —— body 是剥掉注释的，而模板序号恰好只存在于注释里。
  eq('STEP_TPL 条数与步骤数一致', (SRC.match(/^\s*\/\/ \d+ — /gm) || []).length, entries.length);

  const dispatch = /function renderStepContent\([\s\S]*?\n\}/.exec(body);
  ok('找到 renderStepContent', !!dispatch);
  for (const e of entries) {
    ok(`步骤 ${e.id}(${e.i}) 有 setup 分派`,
      new RegExp(`stepIndex === STEP\\.${e.id}\\)\\s*setup\\w+\\(`).test(dispatch ? dispatch[0] : ''));
  }

  const noNav = /const STEPS_WITHOUT_NAV = new Set\(\[([\s\S]*?)\]\)/.exec(body);
  ok('存在 STEPS_WITHOUT_NAV', !!noNav);
  const hidden = noNav ? [...noNav[1].matchAll(/STEP\.(\w+)/g)].map((m) => m[1]) : [];
  for (const s of SWITCHES) {
    ok(`${s.step} 步不在导航栏隐藏名单里（否则用户无法前进）`, !hidden.includes(s.step));
  }
  eq('隐藏名单 = 检查更新/完成/安装', hidden.sort().join(','), 'checkUpdate,complete,installing');

  const targets = [...body.matchAll(/doTransition\(([^)]*)\)/g)].map((m) => m[1].trim());
  const bare = targets.filter((a) => !/^(state\.step [+-] 1|target|STEP\.\w+)(, 'forward')?$/.test(a));
  eq('doTransition 无裸数字目标', bare.join(' | '), '');
  ok('doTransition 调用数量未减少（防止批量替换漏掉重复项）', targets.length >= 12);

  // 「完成页只能由安装失败进入」。正常流程必须先经过这些开关步；若更新检查的某个
  // 出口直接 doTransition(STEP.complete)，用户会静默跳过新加的步骤 —— 而界面上
  // 看不出任何异常，只是那一步没出现过。
  const enclosingFn = (idx) => {
    const m = [...body.slice(0, idx).matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)];
    return m.length ? m[m.length - 1][1] : '(top-level)';
  };
  const completeCallers = [...body.matchAll(/doTransition\(STEP\.complete/g)].map((m) => enclosingFn(m.index));
  ok('存在进入完成页的调用', completeCallers.length > 0);
  eq('完成页只由 setupInstalling（安装失败重试）进入',
    [...new Set(completeCallers)].join(','), 'setupInstalling');

  for (const fn of ['showUpdateResult', 'skipUpdateCheck', '_checkForUpdate']) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\([\\s\\S]*?\\n\\}`).exec(body);
    ok(`找到 ${fn}`, !!m);
    ok(`${fn} 不直接跳完成页（会跳过开关步）`, !/doTransition\(STEP\.complete/.test(m ? m[0] : ''));
  }
}

console.log('--- 源码层守卫 ---');
{
  const libPath = path.join(APP_ROOT, 'src-tauri', 'src', 'lib.rs');
  ok('能找到 src-tauri/src/lib.rs', fs.existsSync(libPath));
  const libRs = fs.existsSync(libPath) ? fs.readFileSync(libPath, 'utf8') : '';

  for (const s of SWITCHES) {
    // 默认值必须与 Rust 侧一致 —— 不一致会让 OOBE 显示与用户实际看到的相反
    const rust = new RegExp(`"${s.key}":\\s*(true|false)`).exec(libRs);
    ok(`Rust 侧有 ${s.key} 默认值`, !!rust);
    const js = new RegExp(`${s.key}:\\s*(true|false)`).exec(body);
    ok(`oobe.js 有 ${s.key} 默认值`, !!js);
    eq(`${s.name}：oobe 与 Rust 默认值一致`, js && rust ? js[1] : null, rust ? rust[1] : null);
    eq(`${s.name}：SWITCHES 表里记的默认值也对得上`, String(s.default), rust ? rust[1] : '');

    // 模板与 i18n
    ok(`${s.name}：模板里有 ${s.el} 复选框`, body.includes(`id="${s.el}"`));
    ok(`${s.name}：模板引用了标签 ${s.labelKey}`, body.includes(`_t('${s.labelKey}')`));
    ok(`${s.name}：模板引用了说明 ${s.hintKey}`, body.includes(`_t('${s.hintKey}')`));

    // mergeSettings 让 OOBE 显式管理的键压过导入值，所以 importConfig 必须把
    // 导入的偏好先接进 state。漏了的话，用户导入的偏好被静默改回默认值 ——
    // 界面上没有任何异常，只是那条设置"莫名其妙变回去了"。
    const adopts = new RegExp(
      `if\\s*\\(\\s*typeof\\s+settings\\.${s.key}\\s*===\\s*'boolean'\\s*\\)\\s*\\{\\s*` +
      `state\\.${s.key}\\s*=\\s*settings\\.${s.key}\\s*;`,
    );
    ok(`${s.name}：importConfig 必须接住导入值`, adopts.test(importSrc));

    // 9 个语言包都得有这两个 key
    for (const f of fs.readdirSync(path.join(SRC_DIR, 'locales')).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'locales', f), 'utf8'));
      ok(`${f} 有 ${s.labelKey}`, !!j.settings?.[s.labelKey.split('.')[1]]);
      ok(`${f} 有 ${s.hintKey}`, !!j.settings?.[s.hintKey.split('.')[1]]);
    }
  }

  // ⚠️ 这里**不要**用 `/<elId>[\s\S]{0,200}state\.<key>\s*=/` 之类的正则来证明
  // 「监听器回写 state」：gatherStepData 里的同名赋值同样满足它，把监听器掏空守卫
  // 照样绿。上面那段是真跑 setup 并派发 change 事件验的。
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
