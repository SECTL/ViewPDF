// 变异测试：破坏 OOBE 标题栏开关的接线，断言 oobe-titlebar.mjs 变红。
//
// 这个开关的所有接错方式都不报错、只静默改掉用户偏好，所以守卫必须逐条自证有效。
// 手法：把 src/ 复制到临时目录再打补丁，绝不碰真实工作区（中途失败不留脏文件）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const HARNESS = path.join(ROOT, 'tests', 'oobe-titlebar.mjs');

let pass = 0, fail = 0;
function report(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   ' + detail : ''));
}

function fresh_copy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewpdf-oobe-'));
  fs.cpSync(SRC, path.join(dir, 'src'), { recursive: true });
  // 守卫有一条例外要读 Rust 侧默认值，必须一起复制 —— 否则断言读的是真实工作区，
  // 「两侧默认值一致」那条守卫在副本上根本不会变红，变异测试就成了摆设。
  fs.mkdirSync(path.join(dir, 'src-tauri', 'src'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), path.join(dir, 'src-tauri', 'src', 'lib.rs'));
  return dir;
}

function patch_js(src_root, pairs) {
  const p = path.join(src_root, 'src', 'oobe.js');
  let body = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (!body.includes(from)) throw new Error(`补丁锚点未命中 oobe.js: ${JSON.stringify(from.slice(0, 70))}`);
    body = body.replace(from, to);
  }
  fs.writeFileSync(p, body);
}

function patch_rust(src_root, pairs) {
  const p = path.join(src_root, 'src-tauri', 'src', 'lib.rs');
  let body = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (!body.includes(from)) throw new Error(`补丁锚点未命中 lib.rs: ${JSON.stringify(from.slice(0, 70))}`);
    body = body.replace(from, to);
  }
  fs.writeFileSync(p, body);
}

function patch_locale(src_root, [file, section, key]) {
  const p = path.join(src_root, 'src', 'locales', file);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  delete json[section][key];
  fs.writeFileSync(p, JSON.stringify(json, null, 4) + '\n', 'utf8');
}

function run(src_root) {
  const r = spawnSync(process.execPath, [HARNESS], {
    cwd: ROOT,
    env: { ...process.env, OOBE_SRC: path.join(src_root, 'src') },
    encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = [...out.matchAll(/^FAIL\s+(.*)$/gm)].map((m) => m[1].trim());
  return { code: r.status, failed, out };
}

const SW = [
  { n: '标题栏', key: 'macosTitleBar', step: 'titleBar', el: 'macosTitleBarToggle', def: 'true' },
  { n: '工具栏文字', key: 'showToolbarText', step: 'toolbarText', el: 'toolbarTextToggle', def: 'false' },
];

// 为每个开关各生成一组变异 —— 新增开关只需在 SW 里加一行。
const PER_SWITCH = [
  {
    name: (s) => `mergeSettings 漏掉 ${s.n} 的键（用户勾了，保存时静默丢弃）`,
    js: (s) => [[`    ${s.key}: state.${s.key},\n`, '']],
    expect: () => '键确实存在',
  },
  {
    name: (s) => `${s.n}：兜底方向写反（Rust 默认是 ${s.def}）`,
    js: (s) => [[
      `state.${s.key} = ${s.el === 'macosTitleBarToggle' ? 'tbToggle' : 'tbtToggle'} ? ` +
      `${s.el === 'macosTitleBarToggle' ? 'tbToggle.checked' : 'tbtToggle.checked'} : ${s.def};`,
      `state.${s.key} = ${s.el === 'macosTitleBarToggle' ? 'tbToggle' : 'tbtToggle'} ? ` +
      `${s.el === 'macosTitleBarToggle' ? 'tbToggle.checked' : 'tbtToggle.checked'} : ${s.def === 'true' ? 'false' : 'true'};`,
    ]],
    expect: () => '元素缺失',
  },
  {
    name: (s) => `gatherStepData 不读 ${s.n} 的开关（勾选框形同虚设）`,
    js: (s) => (s.el === 'macosTitleBarToggle'
      ? [[
          "    const tbToggle = document.getElementById('macosTitleBarToggle');\n" +
          "    // 兜底 true：与 Rust 默认值一致。元素不存在时若回落 false，会把没碰过这个\n" +
          "    // 开关的用户静默改成 Windows 经典样式。\n" +
          "    state.macosTitleBar = tbToggle ? tbToggle.checked : true;\n",
          '',
        ]]
      : [[
          "    const tbtToggle = document.getElementById('toolbarTextToggle');\n" +
          "    // 兜底 false：这个键的 Rust 默认值就是 false（与 macosTitleBar 相反）。\n" +
          "    state.showToolbarText = tbtToggle ? tbtToggle.checked : false;\n",
          '',
        ]]),
    expect: () => 'state 跟随',
  },
  {
    name: (s) => `${s.n}：模板不渲染复选框（界面上根本不存在）`,
    js: (s) => [[`id="${s.el}"`, 'id="_gone"']],
    expect: () => '模板里有',
  },
  {
    name: (s) => `${s.n}：change 监听不回写 state（勾了也没用）`,
    js: (s) => [[`    state.${s.key} = e.target.checked;\n  });`, '    void e;\n  });']],
    // 「后 state 跟随」只出现在 setup 派发 change 那组断言里，
    // 与 gatherStepData 的「勾选框为X → state 跟随 X」不会互相命中。
    expect: () => '后 state 跟随',
  },
  {
    name: (s) => `${s.n}：oobe 默认值与 Rust 默认值不一致（OOBE 显示与实际相反）`,
    js: (s) => [[`  ${s.key}: ${s.def},\n`, `  ${s.key}: ${s.def === 'true' ? 'false' : 'true'},\n`]],
    expect: () => 'oobe 与 Rust 默认值一致',
  },
  {
    name: (s) => `${s.n}：开关挂错步（gather 挂在别的步上）`,
    js: (s) => [[`  if (step === STEP.${s.step}) {`, '  if (step === STEP.theme) {']],
    expect: () => 'state 跟随',
  },
  {
    // ⚠️ 这一条在第一版里是**恒绿**的。
    // 原因：harness 里「接住导入值」的写法是**模拟** importConfig 的那两行
    // （if typeof === 'boolean' → 赋值），模拟代码永远是绿的，与 oobe.js 里
    // 真的 importConfig 有没有写那两行毫无关系。变异删掉 importConfig 里的
    // 接管逻辑，harness 照样通过 —— 守卫看起来在测这件事，其实什么都没测。
    // 现在改成在源码层断言 importConfig 真的接住了（harness 里对应那条
    // `importConfig 必须接住导入值`）。
    name: (s) => `${s.n}：importConfig 不接住导入的偏好（导入值被默认值静默覆盖）`,
    js: (s) => [[
      `    if (typeof settings.${s.key} === 'boolean') {\n      state.${s.key} = settings.${s.key};\n    }\n`,
      '',
    ]],
    expect: () => 'importConfig 必须接住导入值',
  },
];

const MUTATIONS = [];
for (const s of SW) {
  for (const tpl of PER_SWITCH) {
    MUTATIONS.push({ name: tpl.name(s), js: tpl.js(s), expect: tpl.expect(s) });
  }
}

// 跨切面的结构风险（与具体开关无关）
MUTATIONS.push(
  {
    name: 'Rust 默认值被改（与 oobe 单边漂移）',
    rust: [
      ['"macosTitleBar": true,', '"macosTitleBar": false,'],
      ['"showToolbarText": false,', '"showToolbarText": true,'],
    ],
    expect: 'oobe 与 Rust 默认值一致',
  },
  {
    name: '开关步被误加进导航栏隐藏名单（用户无法前进，卡死）',
    js: [[
      'const STEPS_WITHOUT_NAV = new Set([STEP.checkUpdate, STEP.complete, STEP.installing]);',
      'const STEPS_WITHOUT_NAV = new Set([STEP.checkUpdate, STEP.toolbarText, STEP.complete, STEP.installing]);',
    ]],
    expect: '不在导航栏隐藏名单里',
  },
  {
    name: 'renderStepContent 漏掉一个开关步的分派（该页永远空白）',
    js: [['  else if (stepIndex === STEP.toolbarText) setupToolbarText();\n', '']],
    expect: '有 setup 分派',
  },
  {
    name: 'STEP_TPL 少一条（末步空白）',
    js: [['\n  // 8 — Toolbar Text\n', '\n']],
    expect: 'STEP_TPL 条数与步骤数一致',
  },
  {
    name: 'STEP 表下标出现空洞（面板与下标错位）',
    js: [['  toolbarText: 8,\n  complete: 9,\n  installing: 10,', '  toolbarText: 8,\n  complete: 10,\n  installing: 10,']],
    expect: '下标连续无洞',
  },
  {
    name: 'STEPS 退回手写数组（与 STEP 表可能对不上）',
    js: [['const STEPS = Object.keys(STEP).map((id) => ({ id }));', "const STEPS = [{ id: 'language' }];"]],
    expect: 'STEPS 由 STEP 派生',
  },
  {
    name: 'doTransition 退回裸数字（下次插步会静默跳错页）',
    js: [["doTransition(STEP.titleBar, 'forward')", "doTransition(7, 'forward')"]],
    expect: 'doTransition 无裸数字目标',
  },
  {
    name: '更新检查完成后直接跳完成页（静默跳过两个开关步）',
    js: [["doTransition(STEP.titleBar, 'forward');\n    return;\n  }", "doTransition(STEP.complete, 'forward');\n    return;\n  }"]],
    expect: '不直接跳完成页',
  },
  {
    name: '某个语言包缺少 settings 标签键（界面显示字面量 key）',
    locale: ['de-DE.json', 'settings', 'toolbarText'],
    expect: '有 settings.toolbarText',
  },
);

console.log('--- 变异测试：每处接错都必红 ---');

{
  const root = fresh_copy();
  const base = run(root);
  report('基线（未变异）全绿', base.code === 0, base.code === 0 ? '' : base.failed.join(' | '));
  fs.rmSync(root, { recursive: true, force: true });
}

for (const m of MUTATIONS) {
  const root = fresh_copy();
  let thrown = null;
  try {
    if (m.js) patch_js(root, m.js);
    if (m.rust) patch_rust(root, m.rust);
    if (m.locale) patch_locale(root, m.locale);
  } catch (e) {
    thrown = e.message;
  }
  if (thrown) {
    report(m.name, false, '补丁未落地: ' + thrown);
  } else {
    const r = run(root);
    const caught = r.failed.some((f) => f.includes(m.expect));
    report(m.name, caught, caught ? '' : (r.code === 0
      ? 'harness 仍然全绿 —— 这条守卫抓不到该变异，等于没守'
      : '变红了但没命中预期标签: ' + r.failed.join(' | ')));
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
