// 引导流程底部导航栏：断言「返回」按钮已移除，且 `.nav-left` 空占位仍在。
//
// 为什么这条值得守：删掉 `#btnBack` 本身不会报错，只是没人能返回了 —— 那是产品决定。
// 真正静默坏掉的是 **`.nav-left` 这个空 div**：`.nav-bar` 是
// `justify-content: space-between`，只剩 `.nav-right` 一个 flex item 时它会被贴到
// 左边，「下一步」整个跑到左侧、且没有任何报错。下一次「这行太空了，清一下」就会踩到。
//
// 同时反向守住 `common.back`：按钮删了键也删了，若有人把按钮加回来而键没加，
// 界面会直接显示 "common.back" 这一串标识符（format_translate 找不到键时返回键本身）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.OOBE_SRC || 'src';
const OOBE = fs.readFileSync(path.join(ROOT, 'oobe.js'), 'utf8');
const LOC_DIR = path.join(ROOT, 'locales');

let pass = 0, fail = 0;
const eq = (l, got, want) => {
  const o = Object.is(got, want);
  if (o) pass++; else fail++;
  console.log((o ? 'PASS  ' : 'FAIL  ') + l + '   got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};
const ok = (l, got) => eq(l, !!got, true);

// ===== 1. 按钮与绑定都已移除 =====
{
  eq('无 #btnBack 节点', (OOBE.match(/id="btnBack"/g) || []).length, 0);
  eq('无 btnBack 的 getElementById 查询', (OOBE.match(/getElementById\('btnBack'\)/g) || []).length, 0);
  eq('无 prevStep 定义', (OOBE.match(/function prevStep\s*\(/g) || []).length, 0);
  // prevStep 已删，导航只能前进：断言没有任何地方还按 state.step - 1 跳
  eq('无 state.step - 1 的回退跳转', (OOBE.match(/doTransition\(\s*state\.step\s*-\s*1/g) || []).length, 0);
  // isFirst 只服务于返回按钮的显示条件，随之失效
  eq('无残留的 isFirst', (OOBE.match(/\bisFirst\b/g) || []).length, 0);
  // 「下一步」必须还在 —— 删错东西的对照
  ok('「下一步」按钮仍在', /id="btnNext"/.test(OOBE));
  ok('「下一步」仍绑定 nextStep', /getElementById\('btnNext'\)[\s\S]{0,80}?nextStep/.test(OOBE));
  ok('nextStep 仍在', /function nextStep\s*\(/.test(OOBE));
}

// ===== 2. .nav-left 空占位必须留着 =====
{
  const at = OOBE.indexOf('id="btnNext"');
  ok('定位到 btnNext', at > 0);
  const navTpl = OOBE.slice(OOBE.lastIndexOf('nav.innerHTML', at), at);
  ok('nav.innerHTML 模板里有 .nav-left', /class="nav-left"/.test(navTpl));
  ok('nav.innerHTML 模板里有 .nav-right', /class="nav-right"/.test(navTpl));
  // 它必须是空的：一旦里面又长出内容，返回按钮就等于没删。
  // 切片要从开标签的 `>` 之后开始 —— 从 `class=` 开始会把那个 `>` 也算进来，
  // 于是断言恒为 `>`（第一版就栽在这里）。
  const leftOpen = navTpl.indexOf('class="nav-left"');
  const tagEnd = navTpl.indexOf('>', leftOpen);
  const leftClose = navTpl.indexOf('</div>', tagEnd);
  ok('.nav-left 的开标签闭合正常', tagEnd > leftOpen && leftClose > tagEnd);
  const inner = navTpl.slice(tagEnd + 1, leftClose);
  eq('.nav-left 是空占位（内部无内容）', inner.trim(), '');
  // 结构注释不得写在模板字符串里：stripComments 只认 /* */ 与 //，
  // 模板内的注释会让按标识符的断言命中注释而非代码
  eq('nav 模板内无 HTML 注释', (navTpl.match(/<!--/g) || []).length, 0);
}

// ===== 3. space-between 的前提：nav-bar 仍是 space-between，且 nav-left 有宽度锚点 =====
{
  const css = fs.readFileSync(path.join(ROOT, 'oobe.css'), 'utf8');
  const bar = /\.nav-bar\s*\{([^}]*)\}/.exec(css);
  ok('定位到 .nav-bar 规则', !!bar);
  ok('.nav-bar 仍是 justify-content: space-between',
    bar && /justify-content:\s*space-between/.test(bar[1]));
  ok('.nav-left 有样式规则（确认它仍被当作 flex item 使用）',
    /\.nav-left\s*\{/.test(css));
}

// ===== 4. common.back 反向守卫 =====
{
  const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'ru-RU'];
  const bad = [];
  for (const loc of LOCALES) {
    const j = JSON.parse(fs.readFileSync(path.join(LOC_DIR, loc + '.json'), 'utf8'));
    if ('back' in (j.common || {})) bad.push(loc);
    // common 段的其它在用键必须健在
    for (const k of ['next', 'confirm', 'cancel', 'close']) {
      if (!(k in (j.common || {}))) bad.push(loc + ':缺 common.' + k);
    }
  }
  eq('9 个语言包的 common.back 已清理且未伤及相邻键', bad.join(','), '');
  // 代码里也不该再引用它
  const files = [path.join(ROOT, 'oobe.js'), path.join(ROOT, 'oobe.html'),
    path.join(ROOT, 'main.js'), path.join(ROOT, 'init.js')];
  const refs = [];
  for (const f of files) {
    if (fs.readFileSync(f, 'utf8').includes('common.back')) refs.push(path.basename(f));
  }
  eq('源码无 common.back 引用', refs.join(','), '');
}

console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
