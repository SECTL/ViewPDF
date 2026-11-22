// 开发者模式开关必须能真正关闭开发者选项：隐藏入口、复位加载态、跳回关于页。
// 旧实现关掉后只隐藏按钮，dev_loaded 仍为 true → 再次点 logo 5 次没法重新激活。
import fs from 'node:fs';

const SET = fs.readFileSync('src/modules/settings/settings.js', 'utf8');
const DEV = fs.readFileSync('src/modules/developer/developer-options.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

console.log('--- 统一入口 ---');
ok('settings.js 暴露 developer_options_set_active',
  /window\.developer_options_set_active = \(enabled, navigate = false\)/.test(SET));
ok('开启走 activate',
  /if \(enabled\) \{\s*developer_options_activate\(navigate\);/.test(SET));
ok('关闭隐藏按钮',
  /devBtn\.style\.display = 'none'/.test(SET));
ok('关闭复位 dev_loaded（可再次激活）',
  /devBtn\.style\.display = 'none';\s*dev_loaded = false;/.test(SET));
ok('关闭时若停在开发者页则跳回关于页',
  /activeBtn\?\.id === 'btnDevOptions'[\s\S]{0,240}settings_show_page\('pageAbout'\)/.test(SET));
ok('activate 已加载时只确保按钮可见，不重复绑定',
  /if \(dev_loaded\) \{[\s\S]{0,160}devBtn\.click\(\);/.test(SET));

console.log('--- 开发者选项页开关调用统一入口 ---');
ok('toggle change 调用 window.developer_options_set_active',
  /toggle\.addEventListener\('change'[\s\S]{0,400}window\.developer_options_set_active\(enabled, false\)/.test(DEV));
ok('保存 developerMode 到后端',
  /invoke\('settings_save_all', \{ settings: \{ developerMode: enabled \} \}\)/.test(DEV));

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
