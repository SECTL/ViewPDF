// 近邻预挂载回归守卫：活动页前后各 5 页的真实 DOM 要「直接放上去」，
// 而不是等翻到/进入视口才现场 _ensure_page_element（同步建 canvas 是卡顿源）。
import fs from 'node:fs';

const SRC = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

console.log('--- 单一来源常量 ---');
ok('PREMOUNT_NEAR_PAGES 定义为 5', /const PREMOUNT_NEAR_PAGES = 5;/.test(SRC));
ok('首屏 K 引用实例字段（可按高内存模式放大）',
  /const K = this\._premount_near_pages;/.test(SRC));

console.log('--- 首屏批量预挂 ---');
ok('首屏构建 center±PREMOUNT_NEAR_PAGES',
  /const from = virtualized \? Math\.max\(0, center - K\)/.test(SRC) &&
  /const to = virtualized \? Math\.min\(len - 1, center \+ K\)/.test(SRC));
ok('首屏仍保留「非虚拟化建全部」不变量',
  /const from = virtualized \? [^:]+ : 0/.test(SRC) &&
  /const to = virtualized \? [^:]+ : len - 1/.test(SRC));

console.log('--- 扫描中持续维护近邻预挂 ---');
ok('可见性扫描里有近邻预挂逻辑',
  /近邻预挂载/.test(SRC) && /PREMOUNT_NEAR_PAGES/.test(SRC));
ok('向前/向后两侧都覆盖',
  /for \(const step of \[1, -1\]\)/.test(SRC));
ok('遍历范围为前后实例字段（可按高内存模式放大）',
  /for \(let d = 1; d <= this\._premount_near_pages; d\+\+\)/.test(SRC));
ok('每帧限挂 2 页（摊薄成本）',
  /if \(mounted >= 2\) break;/.test(SRC));
ok('近邻预挂不受 mount gate 阻挡（直接放上去）',
  /this\._ensure_page_element\(idx\);/.test(SRC));
ok('仅虚拟化时预挂（非虚拟化已全建）',
  /if \(this\._dom_virtualize\(\) && this\._zoom_wrapper && nearest_page >= 0\)/.test(SRC));

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
