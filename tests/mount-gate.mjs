// 连续移动期的 DOM 挂载门控：行为 + 接线。
//
// 上一版实现有两个真实漏洞，本文件把它们钉住：
//   ① 泵自己的 DOM 预挂载循环不经过 _prerender_page → 门控在滑动路径上完全落空；
//   ② 续期点散落在 5 个平移输入源 → 漏一处就静默失效，且新增输入源必然是风险。
//
// 判据（_mount_allowed_offscreen）与续期（_dr_mark_render_gesture）都抠真源码执行。
import fs from 'node:fs';

const SRC = fs.readFileSync(process.env.READER_SRC || 'src/modules/pdf/document_reader.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

let NOW = 1000;
const performance = { now: () => NOW };

// 源码断言前必须剥注释。注释里只要出现了被断言的标识符，includes() 就会命中注释、
// indexOf() 量到的也是「注释 vs 代码」的先后 —— 于是「删掉它」和「把它挪个位置」
// 这两类变异全都测不出来，而报告里显示全绿。本项目里这类注释写得极详细
// （解释「为什么泵也要接一道门控」那段就点名了 _mount_allowed_offscreen），
// 所以凡是按标识符/位置断言源码的地方都得先剥。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

// 抠方法体。模块级 const 与形参一样必须在 new Function 里声明 —— 抠出来的
// 函数体若引用 MOUNT_IDLE_AFTER_MS 却不声明，运行时报 ReferenceError，症状与
// 「功能没实现」毫无关系。
function extractMethod(name, params = []) {
  const m = new RegExp('(?:^|\\n)    ' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(SRC);
  if (!m) return null;
  try {
    // 返回**函数**，不要在这里调用。
    // new Function(...) 得到的是函数本身；一旦顺手调用，返回的就是「这一次执行的
    // 结果」——`_mount_allowed_offscreen` 恰好返回 boolean，于是 `!!allowed` 断言
    // 会「通过」，而它根本不是函数，后续 mock 里一调就崩。断言要查 typeof。
    return new Function(...params, 'performance', m[1]);
  } catch (e) { console.log('FAIL  抠 ' + name + ' 失败: ' + e.message); return null; }
}

// 常量必须**从源码解析**，不能在这里自己写一份。
// 之前这里硬编码 MOUNT_IDLE_AFTER_MS = 100，于是「源码把静默期改成 2000ms」
// 这个变异一行都不会红 —— 行为断言全程在验 harness 自己的副本。
// 解析失败必须当场 FAIL：静默回落到默认值等于把守卫关掉。
const readConst = (name) => {
  const m = new RegExp('const ' + name + ' = (\\d+);').exec(SRC);
  return m ? Number(m[1]) : null;
};
const MOUNT_IDLE_AFTER_MS = readConst('MOUNT_IDLE_AFTER_MS');
const MOUNT_TAIL_EXEMPT_PAGES = readConst('MOUNT_TAIL_EXEMPT_PAGES');
const MOUNT_TAIL_KEEP_PAGES = readConst('MOUNT_TAIL_KEEP_PAGES');
const DOM_VIRTUALIZE_MIN_PAGES = readConst('DOM_VIRTUALIZE_MIN_PAGES');

const allowed = extractMethod('_mount_allowed_offscreen', ['MOUNT_TAIL_EXEMPT_PAGES', 'page_index']);
const markGesture = extractMethod('_dr_mark_render_gesture', ['MOUNT_IDLE_AFTER_MS']);

eq('抠出 _mount_allowed_offscreen（是函数，不是求值结果）', typeof allowed, 'function');
eq('抠出 _dr_mark_render_gesture（是函数，不是求值结果）', typeof markGesture, 'function');
eq('从源码解析到 MOUNT_IDLE_AFTER_MS（静默期 100ms）', MOUNT_IDLE_AFTER_MS, 100);
eq('从源码解析到 MOUNT_TAIL_EXEMPT_PAGES（末尾豁免 4 页）', MOUNT_TAIL_EXEMPT_PAGES, 4);
eq('从源码解析到 MOUNT_TAIL_KEEP_PAGES（末尾全挂 3 页）', MOUNT_TAIL_KEEP_PAGES, 3);
eq('从源码解析到 DOM_VIRTUALIZE_MIN_PAGES（阈值 100 页）', DOM_VIRTUALIZE_MIN_PAGES, 100);
if (typeof allowed !== 'function' || typeof markGesture !== 'function') process.exit(1);
if (!MOUNT_IDLE_AFTER_MS || !MOUNT_TAIL_EXEMPT_PAGES) {
  console.log('FAIL  常量解析失败，后续断言全部失去意义');
  process.exit(1);
}

const mkReader = (total = 200) => {
  const pages = new Array(total).fill(null).map((_, i) => ({ page_element: null }));
  return {
    page_manager: { pages_list: pages },
    _dr_mount_block_until: 0,
    _render_pause_until: 0,
    _render_host: { set_throttled() {} },
    _render_resume_timer: 1,
    _prerender_enabled: true,
    // 形参顺序 = new Function 的声明顺序 = [...params, 'performance']。
    // 顺序写反不会报错，只会让 performance 拿到数字，症状是 `100.now is not a function`。
    allow(i) { return allowed.call(this, MOUNT_TAIL_EXEMPT_PAGES, i, performance); },
    mark() { return markGesture.call(this, MOUNT_IDLE_AFTER_MS, performance); },
  };
};

const run = () => {
  // ===== 1. 静止：全放行 =====
  {
    const r = mkReader();
    r._dr_mount_block_until = NOW - 1;      // 已过期
    eq('静止时窗口中页放行', r.allow(100), true);
    eq('静止时末尾页放行', r.allow(199), true);
    eq('静止时首页放行', r.allow(0), true);
  }

  // ===== 2. 连续移动期：非末尾页被挡 =====
  {
    const r = mkReader();
    r._dr_mount_block_until = NOW + 100;     // 正在滑动
    eq('移动期：文档中部页被挡', r.allow(100), false);
    eq('移动期：文档开头被挡', r.allow(10), false);
  }

  // ===== 3. 连续移动期：末尾 ≤4 页豁免（否则滑到最后必白屏） =====
  {
    const r = mkReader();
    r._dr_mount_block_until = NOW + 100;
    eq('移动期：末页豁免', r.allow(199), true);
    eq('移动期：倒数第 5 页豁免', r.allow(195), true);
    eq('移动期：倒数第 6 页不再豁免', r.allow(194), false);
  }

  // ===== 4. 边界：恰好到期 =====
  {
    const r = mkReader();
    r._dr_mount_block_until = NOW;           // now >= until
    eq('恰好到期即放行（>= 而非 >）', r.allow(100), true);
  }
  {
    const r = mkReader();
    r._dr_mount_block_until = NOW + 1;       // 尚差 1ms
    eq('未到期即挡住', r.allow(100), false);
  }

  // ===== 5. 静默期长度就是 100ms =====
  {
    const r = mkReader();
    r.mark();
    eq('mark 后窗口 = now + 100', r._dr_mount_block_until, NOW + 100);
    NOW += 99;
    eq('99ms 时仍挡', r.allow(100), false);
    NOW += 1;
    eq('100ms 时放行', r.allow(100), true);
  }

  // ===== 6. mark 顺带续期渲染暂停窗口（两者同源但时长不同） =====
  {
    const r = mkReader();
    r.mark();
    eq('渲染暂停窗口 = now + 120', r._render_pause_until, NOW + 120);
    ok('挂载窗口与渲染暂停窗口不是同一个值',
      r._dr_mount_block_until !== r._render_pause_until);
  }

  // ===== 7. 接线：两条挂载路径都必须有门控 =====
  {
    const prerenderPage = SRC.slice(
      SRC.indexOf('async _prerender_page('),
      SRC.indexOf('async _prerender_page(') + 900);
    ok('_prerender_page 接入门控', prerenderPage.includes('_mount_allowed_offscreen'));
  }
  {
    // 泵自己的 DOM 预挂载循环：上一版就是漏在这里，导致滑动期门控完全落空
    const pumpAt = SRC.indexOf('DOM 预挂载（每 tick 至多 1 页');
    ok('泵的 DOM 预挂载循环还在（定位锚点）', pumpAt > 0);
    const loopAt = SRC.indexOf('for (let i = active + step; i >= plo');
    ok('泵的预挂载循环可定位', loopAt > 0);
    // 按循环闭合（12 缩进的 }）切片，不用固定字符数 —— 门控上方那段 10 行注释
    // 会把 _ensure_page_element 顶出任何拍脑袋的窗口，于是 gateAt < mountAt
    // 变成假阴性（看起来像「门控在挂载之后」，其实只是没读到）
    const loopEnd = SRC.indexOf('\n            }', loopAt);
    ok('泵的预挂载循环闭合可定位', loopEnd > loopAt);
    // 断言前必须剥注释（stripComments 见文件头），否则命中的是注释而非代码
    const loop = stripComments(SRC.slice(loopAt, loopEnd));
    ok('泵的 DOM 预挂载接入门控', loop.includes('_mount_allowed_offscreen'));
    const gateAt = loop.indexOf('_mount_allowed_offscreen');
    const mountAt = loop.indexOf('_ensure_page_element');
    ok('门控出现在挂载之前', gateAt >= 0 && mountAt >= 0 && gateAt < mountAt);
    // 单独一条：break 与 continue 的差别只在「候选被挡后还要不要看更远的页」，
    // 和「门控在不在」是两回事，合并会让 continue 变异的失败原因指错
    ok('门控用的是 break（第一个候选被挡就不退而求其次挂更远的页）',
      /if \(!this\._mount_allowed_offscreen\(i\)\) break;/.test(loop));
  }

  // ===== 8. 翻页语义路径不得被门控（误挡会表现为翻页后空白） =====
  {
    const navAt = SRC.indexOf('_prerender_for_navigation(target_index) {');
    ok('_prerender_for_navigation 可定位', navAt > 0);
    const nav = stripComments(SRC.slice(navAt, navAt + 2400));
    ok('翻页的 DOM 预挂载走的是 _ensure_page_element 直调', nav.includes('_ensure_page_element'));
    ok('翻页路径不得接挂载门控（它是单帧冲量，挡住就是翻页后空白）',
      !nav.includes('_mount_allowed_offscreen'));
  }

  // ===== 9. 续期点收敛到 _dr_mark_render_gesture 一处 =====
  {
    ok('全项目不再有 _mark_motion（5 处分散打戳已消除）',
      !/this\._mark_motion\(\)/.test(SRC) && !/_mark_motion\(\)\s*\{/.test(SRC));
    ok('不再有 _dr_last_motion_t 字段', !/_dr_last_motion_t/.test(SRC));
    const markBody = SRC.slice(SRC.indexOf('_dr_mark_render_gesture() {'), SRC.indexOf('_dr_mark_render_gesture() {') + 600);
    ok('_dr_mark_render_gesture 内续期挂载窗口', markBody.includes('_dr_mount_block_until'));
  }

  // ===== 10. 虚拟化阈值与窗口大小 =====
  {
    ok('虚拟化阈值 100 页', /DOM_VIRTUALIZE_MIN_PAGES = 100/.test(SRC));
    ok('_dom_virtualize 按页数判定', /pages_list\?\.length \|\| 0\) > DOM_VIRTUALIZE_MIN_PAGES/.test(SRC));
    ok('包裹窗口 50', /this\._wrapper_keep_distance = 50/.test(SRC));
    ok('末尾全部挂载窗口 3', /MOUNT_TAIL_KEEP_PAGES = 3/.test(SRC));
    ok('三档 wrapper_keep_distance 统一 50', (SRC.match(/wrapper_keep_distance: 50/g) || []).length === 3);
  }

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) process.exitCode = 1;
};

run();