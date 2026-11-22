// 快滑热路径的性能属性测试（执行真实方法体，不是正则复刻）。
//
// 锁定两项修复：
//  1) _dr_diag_sentinel 不再每次可见性扫描都 O(N) 遍历全部页；
//  2) _ensure_container_rect 不再在 transform 变化后读 2 次 getBoundingClientRect
//     （写 transform → 读 rect 的强制布局是快滑帧的固定开销）。
import fs from 'node:fs';

const SRC = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');
let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

function extract(name, params = []) {
  const m = new RegExp('(?:^|\\n)    ' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(SRC);
  if (!m) throw new Error('未找到方法 ' + name);
  return new Function(...params, m[1]);
}

const diag = extract('_dr_diag_sentinel', ['trigger']);
const ensureRect = extract('_ensure_container_rect');

// ===== 1. diag sentinel 节流 =====
{
  let NOW = 1000;
  globalThis.performance = { now: () => NOW };
  let reads = 0;
  const pages = Array.from({ length: 400 }, () => ({
    _shrunk: false,
    get stroke_history() { reads++; return this._shrunk ? [{}] : [{}, {}]; },
  }));
  const s = {
    _diag_last_lens: new Map(),
    _diag_suppress: false,
    diag_calls: 0,
    page_manager: { pages_list: pages },
    _dr_diag_dump() { this.diag_calls++; },
  };
  const call = () => diag.call(s, 'visibility');
  call();
  eq('首次扫描建立基准', s._diag_last_lens.size, 400);
  eq('首次扫描读取了全部页', reads, 400);
  // 同一秒内重复扫描：节流命中，不再遍历任何页
  for (let i = 0; i < 30; i++) { NOW += 16.7; call(); }
  eq('1 秒内 30 次扫描只真正执行 1 次', reads, 400);
  // 1 秒后再次扫描才真正执行
  NOW += 1000;
  call();
  eq('超过节流窗口后重新扫描', reads, 800);
  // 人为制造收缩，应被抓到
  pages[0]._shrunk = true;
  NOW += 1000;
  call();
  eq('异常收缩被抓到', s.diag_calls, 1);
}

// ===== 2. _ensure_container_rect 不在 transform 变化时读 gBCR =====
{
  let crReads = 0, wrReads = 0;
  const mk = () => {
    const s = {
      dr_canvas_y: -2000,
      _cached_container_rect: null,
      _dr_transform_changed: true,
      _scroll_container: {
        getBoundingClientRect() {
          crReads++;
          return { top: 100, bottom: 900, left: 50, right: 1250 };
        },
      },
      _zoom_wrapper: {
        getBoundingClientRect() { wrReads++; return { top: 100 - 2000 }; },
      },
    };
    s._ensure_container_rect = () => ensureRect.call(s);
    return s;
  };

  const s = mk();
  s._ensure_container_rect();
  eq('首次读容器 rect', crReads, 1);
  eq('首次读 wrapper rect', wrReads, 1);
  eq('首次 wrapperTop 来自 gBCR', s._cached_container_rect.wrapperTop, -1900);
  eq('清掉 transform 脏标记', s._dr_transform_changed, false);

  // 模拟逐帧平移：transform 变了，但容器几何没变 → 0 次 gBCR
  s.dr_canvas_y = -2500;
  s._dr_transform_changed = true;
  s._ensure_container_rect();
  eq('平移帧不再读容器 rect', crReads, 1);
  eq('平移帧不再读 wrapper rect', wrReads, 1);
  eq('wrapperTop 由基准 + 当前位移推导', s._cached_container_rect.wrapperTop, -2400);
  eq('平移帧也清掉脏标记', s._dr_transform_changed, false);

  // 几何变化（resize 把缓存置 null）→ 必须重读
  s._cached_container_rect = null;
  s._ensure_container_rect();
  eq('几何失效后重读容器 rect', crReads, 2);
}

// ===== 3. 源码接线守卫 =====
ok('diag sentinel 有节流时间戳',
  /_diag_sentinel_t[\s\S]{0,200}< 1000/.test(SRC));
ok('容器缓存记录读取时的 dr_canvas_y 快照（消除时序假设）',
  /base_canvas_y: canvas_y/.test(SRC));
ok('wrapperTop 由基准 + 位移差值推导，不再每帧 gBCR',
  /base_wrapper_top\s*\n\s*\+ \(\(this\.dr_canvas_y \|\| 0\) - base\.base_canvas_y\)/.test(SRC));
ok('惯性落点标志在收尾清除',
  /_dr_momentum_active = false;[\s\S]{0,600}_dr_apply_scale\(true\)/.test(SRC));

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
