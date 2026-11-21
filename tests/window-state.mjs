// 窗口状态持久化与高缩放默认尺寸的接线测试。
// 4K + 300% 缩放下逻辑屏只有 1280×720，默认 1280×720 会压到任务栏；
// 同时用户最大化后下次启动必须保持，不能每次都重新点。
import fs from 'node:fs';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);
const read = (p) => fs.readFileSync(p, 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const rust = strip(read('src-tauri/src/lib.rs'));
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));

console.log('--- 默认尺寸：适配 4K 300% 工作区 ---');
ok('默认宽度不超过 1100', conf.app.windows[0].width <= 1100);
ok('默认高度不超过 640（给任务栏留余量）', conf.app.windows[0].height <= 640);
ok('默认窗口居中', conf.app.windows[0].center === true);

console.log('--- 状态结构 ---');
ok('状态文件独立于 config.json',
  /window-state\.json/.test(rust) && /window_state_load/.test(rust) && /window_state_save/.test(rust));
for (const f of ['maximized', 'fullscreen', 'width', 'height', 'x', 'y']) {
  ok('记录 ' + f, new RegExp('\\b' + f + ':\\s*(bool|u32|i32)').test(rust));
}
ok('serde 带 default：旧文件/坏文件不会导致全盘失败',
  /#\[serde\(default\)\]/.test(rust));

console.log('--- 退出时保存 ---');
ok('关闭请求或窗口销毁时保存',
  /CloseRequested\s*\{\s*\.\.\s*\}\s*\|\s*tauri::WindowEvent::Destroyed/.test(rust));
ok('只记录主窗口', /window\.label\(\)\s*==\s*"main"/.test(rust));
ok('保存实际最大化状态', /is_maximized\(\)\.unwrap_or\(false\)/.test(rust));
ok('保存实际全屏状态', /is_fullscreen\(\)\.unwrap_or\(false\)/.test(rust));

console.log('--- 启动时回放 ---');
ok('非首次运行分支里回放',
  /\}\s*else\s*\{[\s\S]{0,300}?window_state_restore\(/.test(rust));
ok('全屏优先于最大化',
  /if state\.fullscreen[\s\S]{0,200}?if state\.maximized/.test(rust));
ok('普通状态才恢复尺寸', /state\.width\s*>=\s*800\s*&&\s*state\.height\s*>=\s*600/.test(rust));
ok('异常坐标不恢复（缩放变化后不会跑出屏幕）',
  /state\.x\.abs\(\)\s*<\s*100_000/.test(rust));
ok('坏文件回落到默认值而不是崩溃',
  /from_str::<WindowState>\(&s\)\.ok\(\)[\s\S]{0,30}?unwrap_or_default\(\)/.test(rust));

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
