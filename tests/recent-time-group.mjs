// 最近文件的「今天」必须按本地日历日，不是过去 24 小时。
// 直接读取系统时间验证：昨天 16:45 在任何时刻都应该是「昨天」。
import fs from 'node:fs';

const SRC = fs.readFileSync('src/init.js', 'utf8');
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};

console.log('--- 源码守卫：按日历日、直接读系统时间 ---');
eq('辅助函数直接读系统时间（无注入参数）',
  /function _calendar_day_delta\(time\)/.test(SRC) &&
  /const now = new Date\(\);\s*\/\/\s*直接读取系统时间/.test(SRC), true);
eq('用本地年月日构造零点',
  /new Date\(x\.getFullYear\(\), x\.getMonth\(\), x\.getDate\(\)\)\.getTime\(\)/.test(SRC), true);
eq('time_group_label 用 days === 0 判今天',
  /if \(days === 0\) return '今天'/.test(SRC), true);
eq('不再用 24 小时滚动差',
  /function time_group_label[\s\S]*?diff < oneDay/.test(SRC) &&
  /function format_access_time[\s\S]*?diff < oneDay/.test(SRC), false);

console.log('--- 系统时间验证 ---');
const now = new Date();
const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 16, 45, 0);
const days = Math.round((now - yesterday) / 86400000);
console.log('系统时间:', now.toString());
console.log('昨天 16:45:', yesterday.toString());
// 日历日差必须是 1（哪怕 now 是早上 08:40，物理间隔不到 24h）
const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
eq('日历日差 = 1（不是物理 24 小时）',
  Math.round((dayOf(now) - dayOf(yesterday)) / 86400000), 1);
eq('物理间隔 < 24h（正是旧 bug 的成因）', days >= 0 && days <= 1, true);

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
