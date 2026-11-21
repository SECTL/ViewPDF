// 校验 9 个语言包都带齐 oobe 的「跳过检查」文案。
// 这条守卫的理由：i18n 缺键时 format_translate 返回的是 key 本身或空串，
// 按钮会渲染成一个空白或字面量 "oobe.updateSkipCheck" —— 不会报错，
// 只能在真机上看到，所以静态校验这一条就够了。
import fs from 'node:fs';

const KEYS = ['oobe.updateSkipCheck'];
const DIR = 'src/locales';
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};

eq('语言包共 9 个', files.length, 9);

for (const f of files) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(DIR + '/' + f, 'utf8'));
  } catch (e) {
    fail++;
    console.log('FAIL  ' + f + ' JSON 无法解析: ' + e.message);
    continue;
  }
  for (const key of KEYS) {
    const v = key.split('.')[1];
    eq(f + ' 带 ' + key, typeof json.oobe?.[v] === 'string' && json.oobe[v].length > 0, true);
  }
}

// 顺带守住「跳过检查」与「稍后再说」不是同一个键：这两个语义不同
// （前者是放弃检查，后者是放弃这次更新），复用同一个键会让翻译无从区分。
for (const f of files) {
  const json = JSON.parse(fs.readFileSync(DIR + '/' + f, 'utf8'));
  eq(f + ' 跳过检查 ≠ 稍后再说', json.oobe.updateSkipCheck !== json.oobe.updateLater, true);
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);