// 「这个提交自洽吗」检查：src/ 里每一个 data-icon="X" / theme_fetch_icon(…) 的引用，
// 在每个内置主题里都要有对应的 icons/X.svg。
//
// 这条检查的由来：document_reader.js 引用了 data-icon="arrow-clockwise"，而该 SVG
// 从未入库 —— 在任何一次全新 clone 上，页面旋转按钮的图标都是空白，且**不报错**
// （theme_fetch_icon_path 回落到字面名，<img> 拿到一条 404）。
//
// 单独跑：node tests/icon-refs-resolve.mjs [仓库根目录]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || '.';
const THEMES = ['com.viewstage.theme.simplify', 'com.viewstage.theme.dark'];

let pass = 0, fail = 0;
const ok = (label, got) => {
  const o = !!got;
  if (o) pass++; else fail++;
  console.log((o ? 'PASS  ' : 'FAIL  ') + label + (o ? '' : '   ← 引用存在但素材缺失'));
};

// 递归收集 src 下的 .js（跳过 pdf.min.mjs / worker，那是第三方压缩产物）
const jsFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') && !/pdf\.(min|worker)\.min?\.m?js$/.test(e.name)) jsFiles.push(p);
  }
})(path.join(ROOT, 'src'));

// 三种引用写法都算：markup 里的 data-icon、JS 里 img('x')、theme_fetch_icon('x')
const refs = new Map();   // 图标名 -> 引用它的文件
const add = (name, file) => {
  if (!name) return;
  if (!refs.has(name)) refs.set(name, new Set());
  refs.get(name).add(path.relative(ROOT, file));
};
for (const f of jsFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/data-icon="([^"]+)"/g)) add(m[1], f);
  for (const m of src.matchAll(/\bimg\('([^']+)'/g)) add(m[1], f);
  for (const m of src.matchAll(/theme_fetch_icon\(\s*'([^']+)'/g)) add(m[1], f);
}

// 各主题 theme.json 的 icons 映射：键是代码用的名字，值是文件名
const maps = {};
for (const t of THEMES) {
  const p = path.join(ROOT, 'src', 'themes', t, 'theme.json');
  maps[t] = JSON.parse(fs.readFileSync(p, 'utf8')).icons || {};
}

console.log(`扫描 ${jsFiles.length} 个 JS 文件，收集到 ${refs.size} 个图标引用\n`);

const missing = [];
for (const t of THEMES) {
  for (const [name, users] of [...refs].sort()) {
    const file = (maps[t] && maps[t][name]) || name;   // 未登记时回落到字面名
    const p = path.join(ROOT, 'src', 'themes', t, 'icons', `${file}.svg`);
    if (fs.existsSync(p)) {
      pass++;
    } else {
      fail++;
      missing.push(`  ${t}: icons/${file}.svg  ←  ${[...users].join(', ')}`);
    }
  }
}

if (missing.length) {
  console.log('\n缺失的素材：');
  for (const l of missing) console.log(l);
  console.log('\n症状：对应按钮的 <img> 拿到一条 404，图标空白且控制台无报错。');
}
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (fail) process.exitCode = 1;
