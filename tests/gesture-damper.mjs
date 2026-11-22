/**
 * gesture-damper.mjs —— 缩放边界阻尼器的执行型守卫
 *
 * 真实 zoom-wall-damper.js 剥掉 export 后在 node:vm 里执行，直接驱动 reset/update。
 * 核心性质：贴墙不呼吸、累计量有界、自由区间同步、非法 ratio 不改状态。
 * 变异测试见 gesture-damper-mutation.mjs。
 *
 * 用法：node tests/gesture-damper.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync('src/modules/gesture/zoom-wall-damper.js', 'utf8');
const stripped = SRC.replace(/^export\s+(?=(?:const|let|var|class|function|async)\b)/gm, '');
const ctx = vm.createContext({ console });
vm.runInContext(stripped + '\nglobalThis.__G = { ZoomWallDamper };', ctx);
const { ZoomWallDamper } = ctx.__G;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const o = Object.is(got, want);
  if (o) pass++; else fail++;
  console.log((o ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
function ok(label, cond, extra = '') { eq(label + (extra ? '  ' + extra : ''), !!cond, true); }

/* ══════════ 1. reset 后 _value ∈ [min,max]，_acc 与显示值同步 ══════════ */
{
  const d = new ZoomWallDamper(0.02);
  eq('reset 高于 max 钳到 max', d.reset(50, 0.1, 10), 10);
  eq('  reset 后 _acc===_value', d._acc, d._value);
  eq('reset 低于 min 钳到 min', d.reset(-5, 0.1, 10), 0.1);
  eq('  reset 后 _acc===_value', d._acc, d._value);
  eq('reset 区间内保持原值', d.reset(2, 0.1, 10), 2);
  eq('  reset 后 _acc===_value', d._acc, d._value);
  ok('reset 返回值恒在 [min,max]',
    [50, -5, 2, 0.1, 10].every((v) => { const r = d.reset(v, 0.1, 10); return r >= 0.1 && r <= 10; }));
}

/* ══════════ 2. 每一次 update 后 _value 恒 ∈ [min,max] ══════════ */
{
  const d = new ZoomWallDamper();
  d.reset(1, 0.1, 10);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let bad = 0;
  for (let i = 0; i < 2000; i++) {
    const ratio = 0.4 + rnd() * 2.0; // 0.4 ~ 2.4，含大量撞墙帧
    const v = d.update(ratio);
    if (!(v >= 0.1 - 1e-12 && v <= 10 + 1e-12)) bad++;
  }
  eq('2000 帧随机增量后 _value 恒在 [min,max]', bad, 0);
}

/* ══════════ 3. 贴墙时 ±噪声不脱离（不呼吸） ══════════ */
{
  const d = new ZoomWallDamper(0.02);
  d.reset(10, 0.1, 10);
  for (const r of [1.01, 0.99, 1.005, 0.995, 1.0, 0.985, 1.02]) {
    eq('max 墙 + 噪声 ' + r + ' 不脱离', d.update(r), 10);
  }
}
{
  const d = new ZoomWallDamper(0.02);
  d.reset(0.1, 0.1, 10);
  for (const r of [0.99, 1.01, 0.995, 1.005, 1.0, 1.015]) {
    eq('min 墙 + 噪声 ' + r + ' 不脱离', d.update(r), 0.1);
  }
}
{
  // 持续同向累计应最终脱离（不是永久钉死）
  const d = new ZoomWallDamper(0.02);
  d.reset(10, 0.1, 10);
  d.update(0.99); d.update(0.99);
  const v = d.update(0.99);
  ok('持续反向累计足够后脱离上墙（非永久锁死）', v < 10, 'v=' + v);
}

/* ══════════ 4. _acc 被 max*(1+escape) / min*(1-escape) 钳制 ══════════ */
{
  const d = new ZoomWallDamper(0.02);
  d.reset(10, 0.1, 10);
  for (let i = 0; i < 10; i++) d.update(1.5);
  ok('_acc 被 max*(1+escape) 钳制', Math.abs(d._acc - 10 * 1.02) < 1e-9, 'acc=' + d._acc);
  eq('  显示值仍钉在 max', d._value, 10);
}
{
  const d = new ZoomWallDamper(0.02);
  d.reset(0.1, 0.1, 10);
  for (let i = 0; i < 10; i++) d.update(0.5);
  ok('_acc 被 min*(1-escape) 钳制', Math.abs(d._acc - 0.1 * 0.98) < 1e-9, 'acc=' + d._acc);
}

/* ══════════ 5. 自由区间 _acc === _value ══════════ */
{
  const d = new ZoomWallDamper(0.02);
  d.reset(1, 0.1, 10);
  d.update(1.2);
  eq('自由区间首帧 _acc===_value', d._acc, d._value);
  d.update(0.8);
  eq('自由区间连续帧 _acc===_value', d._acc, d._value);
  ok('  且确实离开了初始值', Math.abs(d._value - 0.96) < 1e-9, 'v=' + d._value);
}

/* ══════════ 6. 非法 ratio（<=0 / NaN / Infinity）不改变状态 ══════════ */
{
  const d = new ZoomWallDamper(0.02);
  d.reset(2, 0.1, 10);
  for (const r of [0, -1, NaN, Infinity, -Infinity]) {
    const beforeV = d._value, beforeA = d._acc;
    const got = d.update(r);
    eq('非法 ratio ' + String(r) + ' 返回值不变', got, beforeV);
    eq('  内部状态不变', d._value + ',' + d._acc, beforeV + ',' + beforeA);
  }
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
