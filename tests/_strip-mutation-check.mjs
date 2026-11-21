// 一次性变异自检：把共享 strip 退回旧的坏实现，确认 URL 相关守卫会红。
// 用法：node tests/_strip-mutation-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = path.join(ROOT, 'tests', 'dpr-harness.mjs');

const GOOD = ".replace(/(^|[^:])\\/\\/[^\\n]*/g, '$1');";
const BAD = ".replace(/\\/\\/[^\\n]*/g, '');";

const orig = fs.readFileSync(HARNESS, 'utf8');
if (!orig.includes(GOOD)) {
  console.error('ANCHOR MISS — strip 实现已变，先更新本脚本');
  process.exit(1);
}

// ⚠️ 绝不能在 try 里 process.exit()：那会**跳过 finally**，
// 把 harness 永久留在变异后的坏状态里（下次跑就莫名其妙红一条）。
// 正确做法：先算出结论与退出码，离开 try 之后再退出。
let failed = [];
let status = 0;
try {
  fs.writeFileSync(HARNESS, orig.replace(GOOD, BAD), 'utf8');
  const r = spawnSync(process.execPath, [HARNESS], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  failed = [...out.matchAll(/^FAIL\s+(.*)$/gm)].map((m) => m[1].trim());
} finally {
  fs.writeFileSync(HARNESS, orig, 'utf8');
}

console.log(`变异后 ${failed.length} 条 FAIL：`);
for (const f of failed) console.log('  FAIL  ' + f);
if (failed.length > 0) {
  console.log('\n✓ 守卫确实依赖 strip 的正确实现（改坏就红）');
} else {
  status = 1;
  console.log('\n✗ 全绿 —— 这些 URL 守卫其实不依赖 strip，或已失效');
}
process.exit(status);
