// 页面旋转后「内容重叠」的回归测试，**真跑**。
//
// 为什么必须真跑：重叠不是某个值算错了，而是**调用约定没被履行** ——
// `_resize_page_layout(i, w, bulk=true)` 按约定把「全文档坐标重算」推给调用方
// （`_handle_reader_resize` 的步骤 ③），而 `set_page_rotation` 自己不发 resize
// 事件，于是那份重算无人执行。正则断言「调用了 _resize_page_layout」照样全绿。
//
// 而症状极其隐蔽：只有 >100 页（虚拟化生效 → 绝对定位）才重叠，短文档走 flex 流
// 天然堆叠；缩放一下又会好（缩放走 bulk=false 的那条分支，会重算）。
// 三个条件同时成立才看得见，所以只能靠「跑一遍看坐标对不对」来守。
import fs from 'node:fs';

const READER = 'src/modules/pdf/document_reader.js';
const SRC = fs.readFileSync(READER, 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const o = Object.is(got, want);
  if (o) pass++; else fail++;
  console.log((o ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);
const settle = (p, ms = 500) => Promise.race([
  Promise.resolve(p).then(v => ({ v }), e => ({ e })),
  new Promise(r => setTimeout(() => r({ timeout: true }), ms)),
]);

// 抠方法体。document_reader.js 是 class（4 空格缩进，闭合 \n    }）。
// document / window 是一律要声明的形参，否则 ReferenceError（见 AGENTS.md）。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function extract(name) {
  const m = new RegExp('(?:^|\\n)    (async )?' + name + '\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(SRC);
  if (!m) return null;
  const params = m[2].split(',').map(s => s.trim()).filter(Boolean);
  try {
    return new (m[1] ? AsyncFunction : Function)('document', 'window', ...params, m[3]);
  } catch (e) { console.log('FAIL  抠 ' + name + ' 失败: ' + e.message); return null; }
}

const computeLayout = extract('_compute_page_layout');
const applyPositions = extract('_apply_page_positions');
const resizeLayout = extract('_resize_page_layout');
const getAspect = extract('_get_page_aspect');
const setBoxSize = extract('_set_page_box_size');
for (const [n, f] of Object.entries({ _compute_page_layout: computeLayout, _apply_page_positions: applyPositions, _resize_page_layout: resizeLayout })) {
  eq('抠出 ' + n, typeof f, 'function');
}

// ===== mock：3 页 A4 竖向（1.414），容器宽 800 → 基准页宽 768 =====
const BASE = 768, GAP = 20, PAD = 0;
const mkPages = (n) => Array.from({ length: n }, (_, i) => ({
  index: i,
  aspect_ratio: 1.414,
  page_element: { style: { width: BASE + 'px', height: '', position: '', top: '' } },
  coord_width: 0, coord_height: 0,
  stroke_history: [], is_tiles_initialized: false, is_visible: false,
  _cached_top: 0, _cached_h: 0,
  pdf_render_css_width: null, pdf_render_dpr: null,
}));

const mkReader = (pages, opts = {}) => {
  const calls = { compute: 0, apply: 0, resize: [], setBox: 0 };
  const r = {
    page_manager: { pages_list: pages, get_page_count: () => pages.length },
    _page_positions: { tops: [], heights: [], stale: true },
    _layout_gap: GAP, _layout_pad: PAD,
    _zoom_wrapper: { style: {} },
    _dr_mb_dom_dirty: false,
    calls,
    _dom_virtualize: () => (opts.virtualize !== false),
    // ⚠️ 必须按 (document, window, page_data) 包一层，不能把抠出来的函数直接挂上去。
    // 直接挂的话调用方写 this._get_page_aspect(pd) → 抠出的函数把 pd 收到了
    // document 这个形参上，page_data 是 undefined → 走进兜底返回 0.707。
    // 于是「竖向」基线本身就按 0.707 算了，翻转后比例没变，重叠当然测不出来 ——
    // 症状是断言莫名其妙地不成立，而代码没问题。
    _get_page_aspect: (pd) => getAspect.call(r, null, null, pd),
    _get_page_base_width: () => BASE,
    _invalidate_page_positions() { r._page_positions.stale = true; r._dr_mb_dom_dirty = true; },
    _is_page_near_active: () => false,
    _destroy_page_tiles() {}, _init_page_tiles() {},
    _render_pdf_page_direct() {}, _update_overlay_size() {},
    _scale_page_annotations() {},
  };
  r._compute_page_layout = function () { calls.compute++; return computeLayout.call(r, null, null); };
  r._apply_page_positions = function () { calls.apply++; return applyPositions.call(r, null, null); };
  r._set_page_box_size = function (pd, w) { calls.setBox++; return setBoxSize.call(r, null, null, pd, w); };
  r._resize_page_layout = function (i, w, bulk) {
    calls.resize.push({ i, bulk: bulk === true });
    return resizeLayout.call(r, null, null, i, w, bulk);
  };
  return r;
};

// 判断是否重叠：**拿 DOM 上的实际高度**去卡缓存里的 top。
//
// 第一版这里写的是 `_cached_top + _cached_h`，结果测不出重叠 —— 因为比例翻转后
// `_cached_h` 与 `_cached_top` 是**一起过期的**，两者互相自洽，累积仍然不重叠。
// 真实的错配是：`_set_page_box_size` 已把 DOM 高度改成横向那份，而绝对定位用的
// top 还是竖向那份 —— 混着比才看得出页面互相压住。
const domHeight = (pd) => Math.round(parseFloat(pd.page_element.style.height)) || 0;
const overlapCount = (pages) => {
  let n = 0;
  for (let i = 1; i < pages.length; i++) {
    if (pages[i]._cached_top < pages[i - 1]._cached_top + domHeight(pages[i - 1])) n++;
  }
  return n;
};

const run = async () => {
  // ===== 1. 基线：重算后坐标自洽，无重叠 =====
  {
    const pages = mkPages(3);
    const r = mkReader(pages);
    r._compute_page_layout(); r._apply_page_positions();
    eq('基线：重算后无重叠', overlapCount(pages), 0);
    eq('  布局被算过一次', r.calls.compute, 1);
    eq('  第 0 页 top 为 0', pages[0]._cached_top, 0);
    ok('  第 1 页 top ≥ 第 0 页 bottom', pages[1]._cached_top >= pages[0]._cached_top + pages[0]._cached_h);
  }

  // ===== 2. bulk=true 不重算坐标（约定：推给调用方）=====
  {
    const pages = mkPages(3);
    const r = mkReader(pages);
    r._compute_page_layout();              // 先有一份正确坐标
    const before = pages.map(p => p._cached_top);
    r._resize_page_layout(0, BASE, true);  // bulk=true
    eq('bulk=true：_resize_page_layout 不自行重算坐标', r.calls.compute, 1);
    eq('  坐标未被它改动', pages.map(p => p._cached_top).join(','), before.join(','));
  }
  {
    const pages = mkPages(3);
    const r = mkReader(pages);
    r._resize_page_layout(0, BASE, false); // bulk=false（默认）
    ok('bulk=false：_resize_page_layout 自己重算坐标', r.calls.compute >= 1);
    ok('  并应用到 DOM', r.calls.apply >= 1);
  }

  // ===== 3. 复现重叠：翻转 aspect 但不重算 =====
  // 这就是修复前的 set_page_rotation 末尾状态：aspect 已取倒数、页盒高度已更新，
  // 而缓存里的 top 还是竖向那份。
  {
    const pages = mkPages(3);
    const r = mkReader(pages);
    r._compute_page_layout(); r._apply_page_positions();
    // 旋转：0° → 90°，比例取倒数（与 set_page_rotation 的 swaps 分支同式）
    for (const pd of pages) pd.aspect_ratio = 1 / pd.aspect_ratio;
    r._resize_page_layout(0, BASE, true);
    r._resize_page_layout(1, BASE, true);
    r._resize_page_layout(2, BASE, true);
    eq('复现：翻转比例 + 只用 bulk=true → 页盒高度已变', pages[0].page_element.style.height !== '', true);
    eq('复现：但坐标仍是旧值 → 出现重叠', overlapCount(pages) > 0, true);
  }

  // ===== 4. 修复后的路径：翻转后补一次重算，重叠消失 =====
  {
    const pages = mkPages(3);
    const r = mkReader(pages);
    r._compute_page_layout(); r._apply_page_positions();
    for (const pd of pages) pd.aspect_ratio = 1 / pd.aspect_ratio;
    for (let i = 0; i < pages.length; i++) r._resize_page_layout(i, BASE, true);
    // ↓↓↓ 修复新增的就是这两行 ↓↓↓
    if (r._dom_virtualize()) { r._compute_page_layout(); r._apply_page_positions(); }
    eq('修复后：坐标重算了一次', r.calls.compute, 2);
    eq('修复后：不再重叠', overlapCount(pages), 0);
    // fit-width 下容器宽固定，比例翻到 <1 后高度按 base/aspect 变大 —— 竖向
    // 页面转 90° 后铺满容器「宽度」，指的是它现在的短边，所以盒更高而不是更矮。
    eq('  缓存页高与当前比例一致', pages[0]._cached_h, Math.round(BASE * 1.414));
    ok('  且确实高于竖向时的页高', pages[0]._cached_h > Math.round(BASE / 1.414));
  }

  // ===== 5. 短文档（≤100 页、非虚拟化）不受影响 =====
  // flex 流天然堆叠，绝对定位不启用，所以这条路径本来就不该重叠 ——
  // 也正因如此，这个 bug 只在长文档上出现，看起来像"偶发"。
  {
    const pages = mkPages(3);
    const r = mkReader(pages, { virtualize: false });
    r._compute_page_layout();              // 非虚拟化下 _apply_page_positions 直接 return
    r._apply_page_positions();
    eq('非虚拟化：_apply_page_positions 不写绝对定位', pages[0].page_element.style.position, '');
  }

  // ===== 6. 源码层：约定必须被每个 bulk 调用方履行 =====
  // 这是上面行为断言的静态补充：找出所有 bulk=true 的调用点，逐个确认其所在
  // 函数里出现了 _compute_page_layout()。否则将来新增第二个 bulk 调用点又会漏。
  {
    const sites = [...SRC.matchAll(/this\._resize_page_layout\(([^)]*?),\s*true\)/g)];
    ok('找到 bulk=true 的调用点', sites.length > 0);
    const fnOf = (idx) => {
      const head = SRC.slice(0, idx);
      const ms = [...head.matchAll(/\n    (?:async )?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)];
      return ms.length ? ms[ms.length - 1][1] : '(顶层)';
    };
    const bad = [];
    for (const s of sites) {
      const fn = fnOf(s.index);
      // 取该函数体（下一个同缩进方法定义为止）
      const rest = SRC.slice(s.index);
      const end = /\n    \}\n\n    \S/.exec(rest);
      const body = end ? rest.slice(0, end.index) : rest.slice(0, 4000);
      if (!/_compute_page_layout\(\)/.test(body)) bad.push(fn + ' ← ' + s[0]);
    }
    eq('每个 bulk=true 调用点所在函数都重算了坐标', bad.join(' || '), '');
  }

  // ===== 7. 顺序：重算必须在比例翻转之后 =====
  // _compute_page_layout 的 top 是按 `base / aspect_ratio` 累加的。若重算排在
  // 翻转之前，用的仍是旧比例，重算等于白做 —— 断言只查「存在」抓不到这个。
  {
    const i = SRC.search(/    (async )?set_page_rotation\(deg,/);
    ok('定位到 set_page_rotation', i > 0);
    const rest = SRC.slice(i);
    const end = /\n    \}\n\n    \S/.exec(rest);
    const body = rest.slice(0, end ? end.index : 6000);
    const flip = body.indexOf('pd.aspect_ratio = 1 / pd.aspect_ratio');
    const bulk = body.indexOf('this._resize_page_layout(i, base_w, true)');
    const recompute = body.indexOf('this._compute_page_layout()');
    ok('函数体内三处关键调用都定位到了', flip > 0 && bulk > 0 && recompute > 0);
    ok('比例翻转早于坐标重算', flip < recompute);
    ok('坐标重算晚于最后一次页盒重排', bulk < recompute);
    ok('重算受虚拟化开关约束（短文档走 flex 流，不该被写绝对定位）',
      /if \(this\._dom_virtualize\(\)\) \{\s*\n\s*this\._compute_page_layout\(\);\s*\n\s*this\._apply_page_positions\(\);/.test(body));
  }

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) process.exitCode = 1;
};

await run();
