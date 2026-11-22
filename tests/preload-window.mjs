// 预加载窗口的意图测试：范围必须足够大，避免「稍微滑一点就现场加载」。
// 三档仍是成本参数（low ≤ balanced ≤ high），但每档下限都要够大，
// 且滑动时的前倾/后视窗口不能退回旧的硬编码 4/1。
import fs from 'node:fs';

const SRC = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

// 抠出三档表
const tierBlock = /const RENDER_PERF_TIERS = \{([\s\S]*?)\n\};/.exec(SRC);
ok('RENDER_PERF_TIERS 存在', !!tierBlock);
const tiers = {};
if (tierBlock) {
  for (const name of ['low', 'balanced', 'high']) {
    const m = new RegExp(name + '\\s*:\\s*\\{([\\s\\S]*?)\\n\\s{4}\\}').exec(tierBlock[1]);
    if (!m) { fail++; console.log('FAIL  找不到档位 ' + name); continue; }
    const num = (k) => {
      const p = new RegExp(k + ':\\s*(\\d+)').exec(m[1]);
      return p ? Number(p[1]) : NaN;
    };
    tiers[name] = {
      image_keep_distance: num('image_keep_distance'),
      blob_keep_distance: num('blob_keep_distance'),
      prerender_distance: num('prerender_distance'),
      prerender_urgent_span: num('prerender_urgent_span'),
    };
  }
}

console.log('--- 每档范围下限（防止被改小回「滑一点就加载」）---');
for (const name of ['low', 'balanced', 'high']) {
  const t = tiers[name];
  if (!t) continue;
  ok(`${name} image_keep_distance ≥ 8`, t.image_keep_distance >= 8);
  ok(`${name} prerender_distance ≥ 6`, t.prerender_distance >= 6);
  ok(`${name} prerender_urgent_span ≥ 10`, t.prerender_urgent_span >= 10);
  ok(`${name} blob_keep_distance ≥ image_keep_distance`,
    t.blob_keep_distance >= t.image_keep_distance);
}

console.log('--- 三档单调性 ---');
for (const k of ['image_keep_distance', 'prerender_distance', 'prerender_urgent_span']) {
  ok(k + ' low ≤ balanced ≤ high',
    tiers.low?.[k] <= tiers.balanced?.[k] && tiers.balanced?.[k] <= tiers.high?.[k]);
}

console.log('--- 滑动窗口基于档位，不再硬编码 4/1 ---');
ok('滑动前倾基于档位而非固定 4',
  /ahead_screens = moving \? Math\.max\(idle_span, 12\)/.test(SRC));
ok('滑动后视保留 >= 4 屏（不再是 1）',
  /behind_screens = moving \? Math\.max\(4,/.test(SRC));
ok('idle_span 读自档位参数',
  /const idle_span = this\._prerender_distance \|\| 10/.test(SRC));

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
