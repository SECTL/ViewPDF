// 校验 OOBE 三个选项组改用 .sp-option-* 之后的完整链路：
//   ① 类名/激活类是否全量换掉（漏一处 = 指示器不跟随）
//   ② 每个组的每个 data-active 取值是否都有对应的 ::before 位移规则
//      （漏一条 = 指示器停在第一格，选中项看起来没生效）
//   ③ 组内按钮数是否与 grid-template-columns 的列数一致
//   ④ settings.css 是否真的被 OOBE 引入；引入的路径是否存在
//   ⑤ oobe.css 里是否已无 .option-group / .option-btn 的覆盖残留
import fs from 'node:fs';

const OOBE_JS = fs.readFileSync('src/oobe.js', 'utf8');
const OOBE_HTML = fs.readFileSync('src/oobe.html', 'utf8');
const OOBE_CSS = fs.readFileSync('src/oobe.css', 'utf8');
const SP_CSS = fs.readFileSync('src/modules/settings/settings.css', 'utf8');

let pass = 0, fail = 0;
const eq = (l, got, want) => {
  const o = Object.is(got, want);
  if (o) pass++; else fail++;
  console.log((o ? 'PASS  ' : 'FAIL  ') + l + '   got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};
const ok = (l, got) => eq(l, !!got, true);

// ===== 1. 类名全量替换 =====
{
  // 必须用否定后顾：`option-btn` 是 `sp-option-btn` 的子串，直接 match 会把改好的
  // 那批一起算成残留 —— 第一版就栽在这里，报告说 16 处残留而实际是 0。
  const bare = [...OOBE_JS.matchAll(/(?<!sp-)\boption-(?:group|btn)\b/g)];
  eq('oobe.js 无未加 sp- 前缀的 option-group / option-btn 引用', bare.length, 0);
  eq('oobe.js 无残留的 .option-btn.active 查询', (OOBE_JS.match(/\.option-btn\.active/g) || []).length, 0);
  eq('sp-option-group 出现 3 次（三个组）', (OOBE_JS.match(/class="sp-option-group"/g) || []).length, 3);
  eq("sp-active 出现在 markup 的 3 处", (OOBE_JS.match(/' sp-active'/g) || []).length, 3);

  // 激活类必须限定在这三个函数体内检查：步骤导航圆点（step dots）用的是
  // classList.add('active')，那是另一个控件，不该跟着改名。
  const bodies = ['setupPerformance', 'setupDrawing', 'gatherStepData'].map(fn => {
    const i = OOBE_JS.search(new RegExp('(async )?function ' + fn + '\\s*\\('));
    if (i < 0) return '';
    const rest = OOBE_JS.slice(i);
    const end = /\n(?:async )?function |\nconst STEP_TPL/.exec(rest);
    return rest.slice(0, end ? end.index : 2000);
  });
  eq('三个函数体都定位到了', bodies.filter(Boolean).length, 3);
  const badActive = bodies.map((b, i) => [i, (b.match(/classList\.(?:add|remove|toggle)\('active'/g) || []).length])
    .filter(([, n]) => n > 0);
  eq('选项组相关函数内无裸 active 类操作', JSON.stringify(badActive), '[]');
  const badQuery = bodies.map((b, i) => [i, (b.match(/\.option-btn/g) || []).length]).filter(([, n]) => n > 0);
  eq('选项组相关函数内无 .option-btn 查询', JSON.stringify(badQuery), '[]');
}

// ===== 2. 指示器规则覆盖：每个组的每个取值都必须有 ::before 位移 =====
const GROUPS = [
  { id: 'frameRateModeGroup', values: ['low', 'adaptive', 'high'] },
  { id: 'renderPerfTierGroupOobe', values: ['low', 'balanced', 'high'] },
  { id: 'penEffectGroup', values: ['off', 'limited', 'full'] },
];
// 收集所有 .sp-option-group ... ::before 的位移规则，按 (是否 id 限定, 取值) 索引
const rules = [];
for (const m of SP_CSS.matchAll(/([^{}]*)\[data-active="([^"]+)"\]\s*::before\s*\{[^}]*transform:\s*translateX\(([^)]*)\)/g)) {
  rules.push({ selector: m[1].replace(/\s+/g, ' ').trim(), value: m[2], shift: m[3] });
}
eq('settings.css 里能解析出位移规则', rules.length > 0, true);

for (const g of GROUPS) {
  const n = (OOBE_JS.match(new RegExp('id="' + g.id + '"')) || []).length;
  eq(`markup 里有 ${g.id}`, n, 1);
  const bad = [];
  for (const v of g.values) {
    // 命中条件：通用规则（无 id 限定）或以该 id 限定的规则
    const hit = rules.some(r => r.value === v && (!/#/.test(r.selector) || r.selector.includes('#' + g.id)));
    if (!hit) bad.push(v);
  }
  eq(`${g.id} 的每个档位都有指示器位移规则`, bad.join(','), '');
  // 三档必须有 0% / 100% / 200% 三个不同位移，否则两档会指向同一格
  const shifts = new Set(g.values.map(v => {
    const r = rules.find(x => x.value === v && (!/#/.test(x.selector) || x.selector.includes('#' + g.id)));
    return r ? r.shift : null;
  }));
  eq(`${g.id} 三档位移互不相同`, shifts.size, 3);
}

// ===== 3. 按钮数与列数一致 =====
{
  const cols = /^\.sp-option-group\s*\{[^}]*grid-template-columns:\s*repeat\((\d+),\s*1fr\)/m.exec(SP_CSS);
  ok('.sp-option-group 声明了 grid-template-columns', !!cols);
  eq('列数为 3', cols && cols[1], '3');
  for (const g of GROUPS) eq(`${g.id} 是三档`, g.values.length, 3);
  // OOBE 侧按钮数：按 data-value 的 map 数组长度
  const counts = [...OOBE_JS.matchAll(/\[\s*'([a-z]+)'(?:\s*,\s*'[a-z]+')*\s*\]\.map\(v => html`\s*<button class="sp-option-btn/g)];
  eq('三个组都由数组 map 出按钮', counts.length, 3);
}

// ===== 4. settings.css 的引入 =====
{
  ok('oobe.html 引入 settings.css', /<link[^>]+href="modules\/settings\/settings\.css"/.test(OOBE_HTML));
  ok('该路径在磁盘上真实存在', fs.existsSync('src/modules/settings/settings.css'));
  // 引入顺序：settings.css 必须在 oobe.css 之后，否则 oobe.css 的覆盖会压过它
  const iOobe = OOBE_HTML.indexOf('href="oobe.css"');
  const iSp = OOBE_HTML.indexOf('href="modules/settings/settings.css"');
  ok('settings.css 排在 oobe.css 之后', iOobe >= 0 && iSp > iOobe);
}

// ===== 5. oobe.css 残留 =====
{
  const left = OOBE_CSS.match(/^\s*#app \.option-(?:group|btn)/gm) || [];
  eq('oobe.css 无 #app .option-* 残留覆盖', left.length, 0);
  ok('oobe.html 自身不引用 .option-group / .option-btn', !/option-group|option-btn/.test(OOBE_HTML));
}

// ===== 6. 变量可用性（OOBE 靠 theme.css 提供，不是 oobe.css）=====
{
  const theme = fs.readFileSync('src/themes/com.viewstage.theme.simplify/theme.css', 'utf8')
    + fs.readFileSync('src/themes/com.viewstage.theme.dark/theme.css', 'utf8');
  for (const v of ['--color-surface-strong', '--color-surface-elevated', '--color-ink', '--color-muted']) {
    ok(`两套主题都定义了 ${v}`, new RegExp(v.replace(/-/g, '\\-') + '\\s*:').test(theme));
  }
  ok('OOBE 会加载主题 CSS（ThemeManager.init → load_theme 注入 link）',
    /ThemeManager\.init\(\)/.test(OOBE_JS));
}

// ===== 7. 三个组所在的行必须都是「普通 .setting-row」=====
// .setting-row 是 flex + space-between + max-width:520px，选项组作为内容宽度的
// flex item 靠右。渲染档位那一行此前带 inline 的 column + align-items:stretch
// （为已删除的说明文字准备），stretch 会把 inline-grid 的组拉满 520px，
// repeat(3,1fr) 于是让每个按钮宽到约 170px 去装两三个字 —— 观感上就是「太宽 + 换行」。
// 这类 inline 覆盖很容易在下一次「给这行加点东西」时被加回来，所以钉死。
{
  const inlineRows = (OOBE_JS.match(/class="setting-row"\s+style=/g) || []).length;
  eq('没有 .setting-row 带 inline style 覆盖', inlineRows, 0);
  // ⚠️ 这里刻意**不**写「oobe.js 无 align-items:stretch / flex-direction:column」
  // 这种全文件断言：语言列表那行 legitimately 就是竖排居中
  // （`display:flex;flex-direction:column;align-items:center`），全局断言会误报。
  // 第一版就是这么写的，两条全文件断言把无关元素算进来，报告说 1 处残留而实际是 0。
  // 断言必须限定在选项组所在的那段 markup 上。
  for (const g of GROUPS) {
    const i = OOBE_JS.indexOf('id="' + g.id + '"');
    ok(`${g.id} 存在于 markup`, i > 0);
    const rowAt = OOBE_JS.lastIndexOf('<div class="setting-row"', i);
    ok(`${g.id} 前有 .setting-row`, rowAt >= 0);
    // 该 row 标签到组之间不得夹带 style=
    const between = OOBE_JS.slice(rowAt, i);
    ok(`  ${g.id} 所在行无 inline style`, !/style=/.test(between));
    ok(`  ${g.id} 所在行未被改成竖排`, !/flex-direction\s*:\s*column/.test(between));
  }
}

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;