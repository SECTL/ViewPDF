// 变异测试：逐个破坏 locale JSON，断言 i18n-locale-invariants.mjs 变红。
//
// 硬约束：只改 src/locales/*.json，绝不碰任何 .js 源文件。
// 手法：把 locales 复制到临时目录，在副本上打补丁，harness 用 VP_LOCALES_DIR 指向副本。
// 每个变异后 JSON 仍必须是合法 JSON（语法坏的补丁只会让 harness 崩，不能证明守卫有效）。
//
// 单独跑：node tests/i18n-locale-invariants-mutation.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REAL_LOCALES = path.join(ROOT, 'src', 'locales');
const HARNESS = path.join(ROOT, 'tests', 'i18n-locale-invariants.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viewpdf-i18n-'));
const TMP_LOCALES = path.join(TMP, 'locales');
fs.cpSync(REAL_LOCALES, TMP_LOCALES, { recursive: true });

let pass = 0, fail = 0;
function report(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   ' + detail : ''));
}

function run() {
  const r = spawnSync(process.execPath, [HARNESS], {
    cwd: ROOT,
    env: { ...process.env, VP_LOCALES_DIR: TMP_LOCALES },
    encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = [...out.matchAll(/^FAIL\s+(.*)$/gm)].map((m) => m[1].trim());
  return { code: r.status, failed, out };
}

// mutate(json, name) -> true 表示确实改了内容
const MUTATIONS = [
  ['删掉 en-US 的 common.confirm（该语言整句显示字面 key）',
    'en-US', (j) => { delete j.common.confirm; return true; }, /en-US 键集与基准完全一致/],
  ['给 de-DE 多加一个 zzz.extra（多键同样是漂移）',
    'de-DE', (j) => { j.zzz = { extra: 'x' }; return true; }, /de-DE 键集与基准完全一致/],
  ['整段删掉 zh-TW 的 memclean（31 个键一次性缺失）',
    'zh-TW', (j) => { delete j.memclean; return true; }, /zh-TW 键集与基准完全一致/],
  ['fr-FR 的 common.confirm 改成空串（按钮空白）',
    'fr-FR', (j) => { j.common.confirm = ''; return true; }, /fr-FR 所有叶子值是非空字符串/],
  ['ja-JP 的 common.confirm 改成数字（format_translate 回退 key）',
    'ja-JP', (j) => { j.common.confirm = 42; return true; }, /ja-JP 所有叶子值是非空字符串/],
  ['ru-RU 的 settings.language 改成 null',
    'ru-RU', (j) => { j.settings.language = null; return true; }, /ru-RU 所有叶子值是非空字符串/],
  ['zh-CN 的 common.confirm 改成数组',
    'zh-CN', (j) => { j.common.confirm = ['确认']; return true; }, /zh-CN 所有叶子值是非空字符串/],
  ['ko-KR 的 loading.processingPage 丢掉 {total} 占位符（参数永远填不进去）',
    'ko-KR', (j) => { j.loading.processingPage = String(j.loading.processingPage).replace('{total}', 'total'); return true; },
    /占位符在 9 个包中一致/],
  ['en-US 的 deleteThemeError 把 {error} 改成 {name}（错误详情永远不显示）',
    'en-US', (j) => { j.settings.deleteThemeError = 'Failed to delete theme: {name}'; return true; },
    /settings\.deleteThemeError 用 \{error\}|占位符在 9 个包中一致/],
];

const before = run();
report('基线：harness 在无变异时是绿的', before.code === 0, 'exit=' + before.code);
if (before.code !== 0) {
  console.log(before.out);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

const uncaught = [];
let skipped = 0;
for (const [label, name, mutate, expect] of MUTATIONS) {
  const p = path.join(TMP_LOCALES, name + '.json');
  const original = fs.readFileSync(p, 'utf8');
  const json = JSON.parse(original);
  const beforeText = JSON.stringify(json);
  const changed = mutate(json, name);
  const next = JSON.stringify(json, null, 2) + '\n';
  if (!changed || next === original || JSON.stringify(JSON.parse(next)) === beforeText) {
    console.log('SKIP  变异没生效（锚点失效）: ' + label);
    skipped++;
    uncaught.push('[SKIP] ' + label);
    continue;
  }
  // 写回去的必须是合法 JSON —— 否则测的是「解析器崩了」，不是守卫。
  JSON.parse(next);
  fs.writeFileSync(p, next, 'utf8');
  const after = run();
  fs.writeFileSync(p, original, 'utf8');   // 立刻还原，失败也不留脏文件
  const newFails = after.failed.filter((f) => !before.failed.includes(f));
  const caught = after.code !== 0 && newFails.length > 0 && expect.test(after.out);
  if (caught) pass++; else {
    fail++;
    uncaught.push('[MISSED] ' + label);
  }
  console.log((caught ? 'CAUGHT ' : 'MISSED ') + label +
    (newFails.length ? '\n         -> FAIL ' + newFails.slice(0, 3).join(' | ') : '\n         -> 守卫没有反应'));
}

// 每个语言包还原后必须重新全绿（证明没有变异彼此污染）
const restored = run();
report('还原后 harness 重新全绿', restored.code === 0 && restored.failed.length === 0, 'exit=' + restored.code);
fs.rmSync(TMP, { recursive: true, force: true });

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed, ' + skipped + ' SKIP ====');
if (uncaught.length) {
  console.log('');
  console.log('### UNCAUGHT ' + uncaught.length);
  uncaught.forEach((l, i) => console.log('### ' + (i + 1) + '. ' + l));
}
process.exit(fail || skipped ? 1 : 0);
