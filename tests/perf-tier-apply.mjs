// 行为测试：真正执行 apply_perf_tier，验证它把参数表落到实例字段上。
// dpr-harness 的守卫只看源码形状（字符串/正则），无法发现「赋值写错字段」
// 「该 trim 的池没 trim」「关闭状态下不该做重活」这类只在运行时暴露的问题。
import fs from 'node:fs';

const src = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');

// --- 抠出参数表 ---
const tableSrc = /const RENDER_PERF_TIERS\s*=\s*\{[\s\S]*?\n\};/.exec(src);
if (!tableSrc) { console.error('FAIL  未找到 RENDER_PERF_TIERS'); process.exit(1); }
const T = new Function(tableSrc[0] + ' return RENDER_PERF_TIERS;')();
const NAMES = /const RENDER_PERF_TIER_NAMES\s*=\s*\[([^\]]+)\]/.exec(src);
const NAMES_ARR = new Function('return [' + NAMES[1] + ']')();

// --- 抠出方法体，转成可调用函数 ---
const m = /apply_perf_tier\s*\(\s*tier\s*\)\s*\{([\s\S]*?)\n    \}/.exec(src);
if (!m) { console.error('FAIL  未找到 apply_perf_tier'); process.exit(1); }
const apply = new Function('RENDER_PERF_TIERS', 'RENDER_PERF_TIER_NAMES',
  'return function (tier) {' + m[1] + '\n};')(T, NAMES_ARR);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};

// 实例字段名与参数名并不一一同名（历史包袱：_RENDER_MAX ← render_max 等），
// 这里给出权威映射，断言「每个参数确实写到了它该去的字段」。
const FIELD = {
  raster_max_dev_w: '_raster_max_dev_w',
  zoom_headroom: '_zoom_headroom',
  motion_dpr_max: '_DR_MOTION_DPR_MAX',
  bitmap_cache_bytes: '_bitmap_cache_max_bytes',
  bitmap_cache_entries: '_bitmap_cache_max_entries',
  wrapper_keep_distance: '_wrapper_keep_distance',
  image_keep_distance: '_image_keep_distance',
  blob_keep_distance: '_blob_keep_distance',
  prerender_distance: '_prerender_distance',
  prerender_urgent_span: '_prerender_urgent_span',
  render_max: '_RENDER_MAX',
  canvas_pool_max: '_canvas_pool_max',
  sidebar_thumbnail_cache_max: '_sidebar_thumbnail_cache_max',
};

const mkReader = (is_open, poolLen) => {
  const calls = [];
  return {
    is_open, _canvas_pool: new Array(poolLen).fill({}), _render_host: null,
    _bitmap_cache_max_bytes: 0, _bitmap_cache_max_entries: 0,
    _calls: calls,
    _bitmap_cache_clear: () => calls.push('cache_clear'),
    _cleanup_hidden_page_gpu: () => calls.push('cleanup'),
    _invalidate_page_positions: () => calls.push('invalidate_pos'),
    _dr_motion_dpr_until: 1,
    _dr_arm_motion_upgrade: () => calls.push('arm_upgrade'),
    _check_page_visibility: () => calls.push('visibility'),
  };
};

// --- 1. 每档都把 13 个字段写成表里的值 ---
for (const tier of NAMES_ARR) {
  const r = mkReader(true, 3);
  apply.call(r, tier);
  const wrong = Object.entries(FIELD).filter(([k, f]) => r[f] !== T[tier][k]).map(([k, f]) => k + '→' + f + '=' + r[f]);
  eq(tier + ' 档把全部 ' + Object.keys(FIELD).length + ' 个参数落到实例字段', wrong.join(','), '');
  eq(tier + ' 档镜像字段同步', r.render_perf_tier, tier);
}

// --- 2. 非法 / 缺失取值回退中档 ---
for (const bad of ['ultra', '', null, undefined, 'LOW', 0, {}]) {
  const r = mkReader(true, 3);
  const got = apply.call(r, bad);
  eq('非法档位 ' + JSON.stringify(bad) + ' 回退 balanced', got, 'balanced');
  eq('  回退后 raster 上限确为 balanced 值', r._raster_max_dev_w, T.balanced.raster_max_dev_w);
}

// --- 3. 关闭文档状态：只落字段，不做重活 ---
{
  const r = mkReader(false, 3);
  apply.call(r, 'low');
  eq('阅读器关闭时不触发可见性重扫/回收', r._calls.join(','), 'cache_clear');
}

// --- 4. 文档打开中：预算变化要立刻生效 ---
{
  const r = mkReader(true, 3);
  apply.call(r, 'low');
  eq('阅读器打开时按新 keep 窗口回收并重扫可见性',
     r._calls.join(','), 'cache_clear,cleanup,invalidate_pos,arm_upgrade,visibility');
  eq('切档后运动期降密度窗口被清零（不续期旧档位的）', r._dr_motion_dpr_until, 0);
}

// --- 5. canvas 池超编要裁到新上限（high→low 从 3 降到 1） ---
{
  const r = mkReader(true, 3);
  apply.call(r, 'low');
  eq('canvas 池被裁到 low 档上限', r._canvas_pool.length, T.low.canvas_pool_max);
  const r2 = mkReader(true, 3);
  apply.call(r2, 'high');
  eq('canvas 池上限内的档位不裁剪（不会凭空丢弃已有画布）', r2._canvas_pool.length, 3);
}

// --- 6. 渲染线程并发与手势限流同口径：切档必须解除限流 ---
{
  const r = mkReader(true, 3);
  let unthrottled = 0;
  r._render_host = { set_throttled: (v) => { if (v === false) unthrottled++; } };
  apply.call(r, 'balanced');
  eq('切档时解除渲染线程手势限流（否则降档后仍被锁在 1 并发）', unthrottled, 1);
}

// --- 7. 三档严格递增（低配档不得比均衡档更费内存） ---
{
  const keys = Object.keys(FIELD).filter((k) => k !== 'motion_dpr_max');
  const bad = keys.filter((k) => !(T.low[k] <= T.balanced[k] && T.balanced[k] <= T.high[k]));
  eq('成本参数三档单调不增', bad.join(','), '');
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);