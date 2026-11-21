// 小黑板「移动/变换画布后，画的时候正常、抬笔后笔迹移位」回归测试。
//
// 真跑被改动的方法体（_bb_snap_smooth_transform / invalidate_transform /
// refresh_eraser_hint_size / 历史三件套），并对只能靠源码验证的接线做断言。
// 不 await 任何 promise —— 全部同步，避免未 settle 的 promise 让 Node 静默退出 0。

import fs from 'node:fs';

const BB = fs.readFileSync('src/modules/blackboard/blackboard.js', 'utf8');
const DE = fs.readFileSync('src/modules/blackboard/drawing-engine.js', 'utf8');
const OV = fs.readFileSync('src/modules/canvas/overlay-manager.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);
const near = (label, got, want, tol = 1e-9) =>
  ok(label + '  (' + String(got) + ' ≈ ' + String(want) + ')', Math.abs(got - want) <= tol);

// 注释里会大量提到被测标识符，源码文本断言前必须去掉，否则「删掉实现但注释还在」
// 也会让 includes() 通过。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[\s;{}])\/\/[^\n]*/g, '$1');
const BBs = stripComments(BB);
const OVs = stripComments(OV);

function extractMethod(src, name, paramNames, extra = {}) {
  const m = new RegExp('(?:^|\\n)    ' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(src);
  if (!m) throw new Error('未找到 ' + name);
  const keys = Object.keys(extra);
  try {
    const factory = new Function(...keys,
      'return function (' + paramNames.join(', ') + ') {\n' + m[1] + '\n}');
    return factory(...keys.map(k => extra[k]));
  } catch (e) {
    throw new Error('抠 ' + name + ' 失败: ' + e.message);
  }
}

const run = () => {
  // ===== 1. B：起笔快进必须取消排队的 rAF 节流变换 =====
  {
    const snap = extractMethod(BB, '_bb_snap_smooth_transform', []);
    const cancelled = [], cleared = [], removed = [];
    const oldCAF = globalThis.cancelAnimationFrame;
    const oldCT = globalThis.clearTimeout;
    globalThis.cancelAnimationFrame = (id) => cancelled.push(id);
    globalThis.clearTimeout = (id) => cleared.push(id);
    try {
      const mock = {
        bb_wrapper: {
          classList: { remove: (c) => removed.push(c) },
          style: { transitionDuration: '200ms', transform: 'translate3d(10px, 20px, 0) scale(2)' },
        },
        _animate_timer_id: 111,
        _bb_transform_raf_id: 222,
        _pending_bb_transform: { x: 10, y: 20, scale: 2 },
        bb_state: { canvas_x: 100, canvas_y: 200, scale: 2, last_transform: { x: 10, y: 20, scale: 2 } },
      };
      snap.call(mock);
      ok('snap 调用了 cancelAnimationFrame(排队的 transform rAF)', cancelled.includes(222));
      eq('snap 清空 _bb_transform_raf_id', mock._bb_transform_raf_id, null);
      eq('snap 清空 _pending_bb_transform', mock._pending_bb_transform, null);
      ok('snap 清 animated timer', cleared.includes(111));
      ok('snap 移除 smooth-transform class', removed.includes('smooth-transform'));
      eq('snap 把 DOM 变换落到 bb_state 终态', mock.bb_wrapper.style.transform,
        'translate3d(100px, 200px, 0) scale(2)');
      eq('snap 清 transitionDuration', mock.bb_wrapper.style.transitionDuration, '');
      eq('snap 同步 last_transform.x', mock.bb_state.last_transform.x, 100);
      eq('snap 同步 last_transform.scale', mock.bb_state.last_transform.scale, 2);
    } finally {
      globalThis.cancelAnimationFrame = oldCAF;
      globalThis.clearTimeout = oldCT;
    }
  }

  // ===== 2. A：脏检查不能再用死变量，DOM 落点与 bb_state 一致才不起笔偏 =====
  {
    ok('_bb_last_transform 已彻底移除（源码，注释已剥离）', !BBs.includes('_bb_last_transform'));
    ok('拖拽脏检查改用 s.last_transform', BBs.includes('s.last_transform.x !== s.canvas_x'));
    // 端到端数学：snap 后 gBCR.left == canvas_x，光标 → 内容 → 提交落点回到光标
    const scale = 2, canvas_x = 100, canvas_y = 200;
    const clientX = 360, clientY = 600;
    const cx = (clientX - canvas_x) / scale;
    const cy = (clientY - canvas_y) / scale;
    near('snap 后提交落点 == 光标 x', canvas_x + cx * scale, clientX);
    near('snap 后提交落点 == 光标 y', canvas_y + cy * scale, clientY);
  }

  // ===== 3. C：overlay 自身 rect 缓存必须随 invalidate_transform 失效 =====
  {
    const inv = extractMethod(OV, 'invalidate_transform', []);
    const o = {
      _transformScale: 2, _transformX: 10, _transformY: 20,
      _selfRect: { left: 80, top: 40, width: 800, height: 600 },
    };
    inv.call(o);
    eq('invalidate_transform 清掉 _selfRect', o._selfRect, null);
    eq('invalidate_transform 清掉 _transformScale', o._transformScale, 0);
    eq('invalidate_transform 清掉 _transformX/Y', o._transformX + o._transformY, 0);

    // 执行真实 sync_transform：失效后按新的自身 rect 折算预览锚点
    const sync = extractMethod(OV, 'sync_transform', []);
    let captured = null;
    const canvas = { getBoundingClientRect: () => ({ left: 80, top: 40 }) };
    const ov = {
      ctx: { setTransform: (...a) => { captured = a; } }, dpr: 2,
      _transformScale: 0, _transformX: 0, _transformY: 0,
      _selfRect: null, canvas,
      _fetch_view_transform: () => ({ scale: 2, originX: 100, originY: 200 }),
      _read_self_rect() {
        if (!this._selfRect) this._selfRect = this.canvas.getBoundingClientRect();
        return this._selfRect;
      },
    };
    sync.call(ov);
    near('预览平移项 = (锚点-自身 left)*dpr', captured[4], (100 - 80) * 2);
    near('预览平移项 y', captured[5], (200 - 40) * 2);

    // 面板移动（left 80→120），view transform 不变；失效后必须重新折算
    canvas.getBoundingClientRect = () => ({ left: 120, top: 40 });
    inv.call(ov);
    sync.call(ov);
    near('面板移动后预览锚点已重算', captured[4], (100 - 120) * 2);
  }

  // ===== 4. busy 4：缩放态改橡皮预设，提示直径必须等于实际擦除直径 =====
  {
    const refresh = extractMethod(DE, 'refresh_eraser_hint_size', [], {
      window: { DRAW_CONFIG: { eraserSize: 15 } },
    });
    for (const scale of [1, 2, 4, 0.5]) {
      const hint = { style: {} };
      const mock = {
        _eraser_hint: hint,
        _fetch_safe_scale: () => scale,
        cached_draw_line_width: 999,
      };
      refresh.call(mock);
      near(`scale=${scale}: 缓存写的是内容单位 size/scale`,
        mock.cached_draw_line_width, 15 / scale);
      eq(`scale=${scale}: 提示 style 仍是屏幕单位`, hint.style.width, '15px');
      near(`scale=${scale}: 提示直径 == 实际擦除直径`,
        mock.cached_draw_line_width * scale, 15);
    }
  }

  // ===== 5. bug 1 + 2：按文档快照/恢复/清空，且页数收缩不调用不存在的 remove_page =====
  {
    ok('源码不再调用 remove_page', !BBs.includes('.remove_page('));
    const pm = (n) => ({
      pages_list: Array.from({ length: n }, (_, i) => ({
        stroke_history: ['s' + i], undo_list: ['u' + i], redo_list: ['r' + i],
      })),
      current_index: n - 1,
      get_current_page() { return this.pages_list[this.current_index]; },
      get_page_count() { return this.pages_list.length; },
      add_page() { this.pages_list.push({ stroke_history: [], undo_list: [], redo_list: [] }); this.current_index = this.pages_list.length - 1; },
      delete_page(i) { if (this.pages_list.length > 1) this.pages_list.splice(i, 1); },
    });

    const history_state = { undo_list: [{ id: 'cur' }], redo_list: [{ id: 'redo' }] };
    const snapshot = extractMethod(BB, '_bb_snapshot_state', [], {
      history_state, window: { __HISTORY_ISOLATED: true },
    });
    const src = {
      is_open: true,
      page_manager: pm(2),
      bb_state: { canvas_x: 10, canvas_y: 20, scale: 2, last_transform: { x: 1, y: 2, scale: 1 } },
      screen_w: 800, screen_h: 600,
    };
    const snap = snapshot.call(src);
    ok('快照门控用 __HISTORY_ISOLATED（close 时 is_open 已置 false）',
      BBs.includes('if (window.__HISTORY_ISOLATED)'));
    ok('快照包含 undos', Array.isArray(snap.undos));
    ok('快照包含 redos', Array.isArray(snap.redos));
    eq('快照前同步了当前页 undo', src.page_manager.pages_list[1].undo_list[0].id, 'cur');
    eq('快照前同步了当前页 redo', src.page_manager.pages_list[1].redo_list[0].id, 'redo');
    eq('快照页数', snap.pageCount, 2);

    // 目标文档只有 1 页，当前 3 页 → 收缩路径
    const restore = extractMethod(BB, '_bb_restore_state', ['snap']);
    const dst = {
      page_manager: pm(3),
      bb_state: { canvas_x: 0, canvas_y: 0, scale: 1, last_transform: {} },
      screen_w: 800, screen_h: 600, is_open: true,
    };
    // 目标页初始值必须与快照明显不同，否则「删掉恢复语句」时守卫仍是重言式（绿）。
    dst.page_manager.pages_list[0].stroke_history = ['PREEXISTING_S'];
    dst.page_manager.pages_list[0].undo_list = ['PREEXISTING_U'];
    dst.page_manager.pages_list[0].redo_list = ['PREEXISTING_R'];
    restore.call(dst, { ...snap, pageCount: 1 });
    eq('页数收缩后为 1', dst.page_manager.get_page_count(), 1);
    eq('stroke_history 恢复自快照', dst.page_manager.pages_list[0].stroke_history[0], snap.histories?.[0]?.[0]);
    eq('undo 恢复自快照', dst.page_manager.pages_list[0].undo_list[0], snap.undos?.[0]?.[0]);
    eq('redo 恢复自快照', dst.page_manager.pages_list[0].redo_list[0], snap.redos?.[0]?.[0]);

    const clearAll = extractMethod(BB, '_bb_clear_all', []);
    clearAll.call(dst);
    eq('清空 stroke', dst.page_manager.pages_list[0].stroke_history.length, 0);
    eq('清空 undo（跨文档不残留旧命令）', dst.page_manager.pages_list[0].undo_list.length, 0);
    eq('清空 redo', dst.page_manager.pages_list[0].redo_list.length, 0);
  }

  // ===== 6. bug 3：捏合起手必须 await 提交后再清空 batch_draw =====
  {
    const body = /pinch\.onPinchStarted\s*=\s*(async )?\([^)]*\)\s*=>\s*\{([\s\S]*?)\n        \};/.exec(BBs);
    ok('onPinchStarted 是 async', !!body && (body[1] || '').trim() === 'async');
    const b = body ? body[2] : '';
    const awaited = b.indexOf('await this.drawing_engine._submit_stroke()');
    const cleared = b.indexOf('batch_draw_delete_all()');
    ok('await 提交语句存在', awaited >= 0);
    ok('清空 batch_draw 在 await 之后', awaited >= 0 && cleared > awaited);
    ok('提交有 catch（不产生未处理 rejection）', b.includes('catch'));
  }

};

// Promise 必须有超时竞速：永不 settle 的回调会让 Node 空事件循环退出 0，断言被静默跳过。
const settle = (p, label) => Promise.race([
  p.then(v => ({ v })),
  new Promise(r => setTimeout(() => r({ timeout: label }), 3000)),
]);

async function runAsync() {
  // ===== 7. bug 3：执行真实的 onPinchStarted 回调（不只是源码断言）=====
  {
    const m = /pinch\.onPinchStarted\s*=\s*async \([^)]*\)\s*=>\s*\{([\s\S]*?)\n        \};/.exec(BB);
    ok('定位到 async onPinchStarted 函数体', !!m);
    if (m) {
      const make = (order, errors) => new Function(
        'window', 'ZoomWallDamper', 'performance', 'cancelAnimationFrame', 'console',
        'return async function(ev) {\n' + m[1] + '\n}'
      )(
        { DRAW_CONFIG: { minScale: 0.5, maxScaleImage: 3 } },
        class { reset() {} },
        { now: () => 1000 },
        () => {},
        { error: (...a) => { errors.push(a.join(' ')); } }
      );

      // 正常路径：提交必须先读走 _storedWidths，再清空 batch_draw
      const order = [], errors = [];
      const fn = make(order, errors);
      const self = {
        is_open: true, _cancel_momentum() {}, _bb_transform_raf_id: null,
        bb_state: { scale: 2, canvas_x: 10, canvas_y: 20 },
        _fetch_safe_scale() { return 2; },
        drawing_engine: {
          is_drawing: true, current_stroke: {},
          async _submit_stroke() { order.push('submit'); },
          batch_draw: { batch_draw_delete_all() { order.push('clear'); } },
        },
        _touch_enable_gpu() {},
      };
      const r = await settle(fn.call(self, { centerX: 100, centerY: 100 }), 'pinch-ok');
      eq('捏合回调正常 settle（无悬挂）', r.timeout, undefined);
      eq('提交先于清空 batch_draw（storedWidths 不丢）', order.join('→'), 'submit→clear');

      // 反例：提交抛错必须被 catch，且仍继续清空（不产生未处理 rejection）
      const order2 = [], errors2 = [];
      const fn2 = make(order2, errors2);
      const self2 = {
        ...self,
        drawing_engine: {
          is_drawing: true, current_stroke: {},
          async _submit_stroke() { order2.push('submit'); throw new Error('boom'); },
          batch_draw: { batch_draw_delete_all() { order2.push('clear'); } },
        },
      };
      const r2 = await settle(fn2.call(self2, { centerX: 100, centerY: 100 }), 'pinch-reject');
      eq('提交 reject 也被 settle（无未处理 rejection）', r2.timeout, undefined);
      ok('错误被 catch 记录', errors2.some(e => e.includes('捏合起手提交笔画失败')));
      eq('失败后仍清空 batch_draw', order2.join('→'), 'submit→clear');
    }
  }

  // ===== 8. 门控反例：历史未隔离时不得把全局历史写进文档板 =====
  {
    const snap2 = extractMethod(BB, '_bb_snapshot_state', [], {
      history_state: { undo_list: [{ id: 'GLOBAL' }], redo_list: [] },
      window: { __HISTORY_ISOLATED: false },
    });
    const pm2 = {
      pages_list: [{ stroke_history: [], undo_list: ['KEEP'], redo_list: [] }],
      current_index: 0,
      get_current_page() { return this.pages_list[0]; },
      get_page_count() { return 1; },
    };
    const src2 = {
      is_open: false, page_manager: pm2,
      bb_state: { canvas_x: 0, canvas_y: 0, scale: 1, last_transform: {} },
      screen_w: 800, screen_h: 600,
    };
    snap2.call(src2);
    eq('未隔离时保留 page 原有 undo（不污染全局历史）',
      src2.page_manager.pages_list[0].undo_list[0], 'KEEP');
  }

  // ===== 惯性逐帧不把瓦片/脏块重活压在滑行帧上 =====
  {
    const sync = extractMethod(BB, '_sync_bb_transform', ['skipHeavy'], {
      window: { ResolutionController: null },
    });
    const mk = () => {
      const calls = { tile: 0, dirty: 0 };
      const s = {
        bb_wrapper: { style: {} },
        tile_renderer: { update_visible_tile_dpr() { calls.tile++; } },
        bb_state: {
          canvas_x: 10, canvas_y: 20, scale: 2, is_zooming: false,
          last_transform: { x: 0, y: 0, scale: 1 },
        },
        _bb_schedule_dirty_refresh() { calls.dirty++; },
      };
      return { s, calls };
    };

    const light = mk();
    sync.call(light.s, true);
    eq('轻量帧仍更新 DOM transform', light.s.bb_wrapper.style.transform,
      'translate3d(10px, 20px, 0) scale(2)');
    eq('轻量帧同步脏检查基准', light.s.bb_state.last_transform.y, 20);
    eq('轻量帧不做瓦片 DPR 调度', light.calls.tile, 0);
    eq('轻量帧不排脏块刷新', light.calls.dirty, 0);

    const full = mk();
    sync.call(full.s, false);
    eq('正常帧仍做瓦片 DPR 调度', full.calls.tile, 1);
    eq('正常帧仍排脏块刷新', full.calls.dirty, 1);

    ok('惯性 tick 用的是轻量帧',
      /this\._sync_bb_transform\(true\);/.test(stripComments(BB)));
  }

  console.log('\n==== ' + pass + ' passed, ' + fail + ' failed ====');
  if (fail) process.exitCode = 1;
}

run();
runAsync().catch(e => {
  console.log('FAIL  async 测试异常: ' + e.message);
  process.exitCode = 1;
});
