// 翻页/打开时的 X 居中：dr_canvas_x 必须是 (viewport_w - bounded_w)/2，
// 不能固定 0（页面宽于视口时会变成左对齐 → 部分 PDF 打开后偏左）。
import fs from 'node:fs';

const SRC = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

console.log('--- 源码守卫 ---');
ok('_scroll_to_page 不再固定 dr_canvas_x = 0',
  !/viewport_center_y - page_center_y \* s;\s*\n\s*\}[\s\S]{0,60}?dr_canvas_x = 0/.test(SRC));
ok('X 居中用 (viewport_w - bounded_w) / 2',
  /this\.dr_canvas_x = \(viewport_w - bounded_w\) \/ 2/.test(SRC));
ok('bounded_w 来自页面基准宽 × 缩放',
  /const bounded_w = this\._get_page_base_width\(\) \* s/.test(SRC));
ok('viewport_w 来自容器 clientWidth',
  /const viewport_w = container\.clientWidth/.test(SRC));

console.log('--- 数值验证（页面宽于/窄于视口）---');
const centerX = (vw, baseW, s) => (vw - baseW * s) / 2;
// 96 DPI A4：base 约 900，视口 1000，scale 1 → 正留白居中
eq('窄页（含留白）居中值 > 0', centerX(1000, 900, 1) > 0, true);
eq('  数值 = 50', centerX(1000, 900, 1), 50);
// 放大 2x：bounded 1800 > vw 1000 → 负值，中心对齐（不是左对齐 0）
eq('宽页居中值 < 0', centerX(1000, 900, 2) < 0, true);
eq('  数值 = -400', centerX(1000, 900, 2), -400);
// 该值落在 move_bound [min_x, max_x] 内：min=vw-bounded, max=0
const vw = 1000, bounded = 1800;
const x = centerX(vw, bounded, 1);
eq('居中值在 clamp 区间内', x >= vw - bounded && x <= 0, true);

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
