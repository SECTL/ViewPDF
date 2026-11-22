// 历史压缩 + 撤销栈：node:vm 沙箱里跑真实 history.js / history-compactor.js。
// history-compactor.js 的 import 行被剥掉，renderStrokesToContext 用可控 hook 注入；
// SnapshotCommand 直接用 history.js 里导出的真类，验「压缩→撤销→重做」可重建语义。
import fs from 'node:fs';
import vm from 'node:vm';

const HISTORY = 'src/modules/history.js';
const COMPACTOR = 'src/modules/canvas/history-compactor.js';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

// 带超时的 settle：Promise 永不 settle 时 Node 会空转退出 0，断言被静默跳过。
const settle = (p, ms = 2000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('TIMEOUT ' + ms)), ms);
  Promise.resolve(p).then(
    (v) => { clearTimeout(t); resolve(v); },
    (e) => { clearTimeout(t); reject(e); },
  );
});

const HISTORY_EXPORTS = [
  'MAX_HISTORY_STEPS', 'history_state', 'Command', 'DrawCommand', 'ClearCommand', 'SnapshotCommand',
  'history_init_manager', 'history_execute_command', 'history_validate_undo', 'history_validate_redo',
  'history_handle_undo', 'history_handle_redo', 'history_delete_all', 'history_fetch_undo_stack',
  'history_handle_state_change', 'history_validate_compact', 'history_fetch_commands_to_compact',
  'history_format_compact', 'history_reset_executing', 'history_trim_undo_front',
  'history_peek_undo', 'history_peek_redo',
];

function loadModule(file, extras = {}, exportsList = []) {
  let s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  s = s.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n');  // 剥 import 行
  s = s.replace(/\bexport\s+/g, '');                                   // 剥 export 关键字
  const sandbox = {
    console, Math, Date, JSON, Object, Array, Promise, Set, Map, Error,
    setTimeout, clearTimeout, queueMicrotask,
    ...extras,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const tail = exportsList.length ? '\n;globalThis.__X = {' + exportsList.join(',') + '};' : '';
  vm.runInContext(s + tail, sandbox, { filename: file });
  return { sandbox, X: sandbox.__X || {} };
}

const HX = loadModule(HISTORY, {}, HISTORY_EXPORTS);
const H = HX.X;
eq('history.js 导出 MAX_HISTORY_STEPS', typeof H.MAX_HISTORY_STEPS, 'number');
if (typeof H.MAX_HISTORY_STEPS !== 'number') process.exit(1);

// ─────────────────────────── 撤销栈 ───────────────────────────
const runHistory = async () => {
  console.log('--- H1. 常量与初始化 ---');
  eq('MAX_HISTORY_STEPS 常量 = 50', H.MAX_HISTORY_STEPS, 50);
  const changes = [];
  H.history_init_manager({ on_state_change: (s) => changes.push(s) });
  eq('init 后 undo 栈空', H.history_fetch_undo_stack().length, 0);
  eq('init 后 redo 栈空', H.history_state.redo_list.length, 0);
  eq('init 后未执行', H.history_state.is_executing, false);

  console.log('--- H2. 执行 / 撤销 / 重做闭环 ---');
  const arr = [];
  H.history_init_manager();
  const c1 = new H.DrawCommand({ stroke: 'a', strokeHistoryRef: arr });
  await settle(H.history_execute_command(c1));
  eq('execute 后 undo 栈 1 条', H.history_fetch_undo_stack().length, 1);
  eq('execute 把笔画加入 strokeHistory', arr.join(','), 'a');
  eq('validate_undo = true', H.history_validate_undo(), true);
  eq('validate_redo = false', H.history_validate_redo(), false);

  const u = await settle(H.history_handle_undo());
  eq('undo 返回被撤销的命令', u === c1, true);
  eq('undo 后 stroke 已移除', arr.join(','), '');
  eq('undo 后 redo 栈 1 条', H.history_state.redo_list.length, 1);
  eq('validate_redo = true', H.history_validate_redo(), true);
  eq('undo 后 undo 栈空', H.history_fetch_undo_stack().length, 0);

  const r = await settle(H.history_handle_redo());
  eq('redo 返回被重做的命令', r === c1, true);
  eq('redo 后 stroke 恢复', arr.join(','), 'a');
  eq('redo 后 undo 栈 1 条', H.history_fetch_undo_stack().length, 1);
  eq('redo 后 redo 栈空', H.history_state.redo_list.length, 0);

  console.log('--- H3. 空栈 / 单元素 / peek ---');
  H.history_init_manager();
  eq('空栈 undo 返回 null', await settle(H.history_handle_undo()), null);
  eq('空栈 redo 返回 null', await settle(H.history_handle_redo()), null);
  eq('空栈 validate_undo = false', H.history_validate_undo(), false);
  const arr2 = [];
  const c2 = new H.DrawCommand({ stroke: 'x', strokeHistoryRef: arr2 });
  await settle(H.history_execute_command(c2));
  eq('peek_undo 是栈顶且不移除', H.history_peek_undo() === c2, true);
  eq('peek_undo 不弹栈', H.history_fetch_undo_stack().length, 1);
  eq('peek_redo 空栈返回 undefined', H.history_peek_redo(), undefined);
  await settle(H.history_handle_undo());
  eq('undo 后 peek_redo 是栈顶', H.history_peek_redo() === c2, true);
  {
    const a = ['a', 'b', 'c'];
    await settle(new H.DrawCommand({ stroke: 'b', strokeHistoryRef: a }).undo());
    eq('DrawCommand.undo 只移除自己的笔画', a.join(','), 'a,c');
  }

  console.log('--- H4. 失败回滚 ---');
  {
    const a = [];
    H.history_init_manager();
    const bad = new H.DrawCommand({ stroke: 'b', strokeHistoryRef: a });
    bad.undo = async () => { throw new Error('boom'); };
    await settle(H.history_execute_command(bad));
    let msg = '';
    try { await settle(H.history_handle_undo()); } catch (e) { msg = e.message; }
    eq('undo 抛错向外传播', msg, 'boom');
    eq('undo 失败后命令回到 undo 栈', H.history_fetch_undo_stack().length, 1);
    eq('undo 失败后 redo 栈为空', H.history_state.redo_list.length, 0);
    eq('undo 失败后 is_executing 复位', H.history_state.is_executing, false);
  }
  {
    H.history_init_manager();
    const bad = new H.DrawCommand({ stroke: 'c', strokeHistoryRef: [] });
    bad.redo = async () => { throw new Error('redo-boom'); };
    await settle(H.history_execute_command(bad));
    await settle(H.history_handle_undo());
    let msg = '';
    try { await settle(H.history_handle_redo()); } catch (e) { msg = e.message; }
    eq('redo 抛错向外传播', msg, 'redo-boom');
    eq('redo 失败后命令回到 redo 栈', H.history_state.redo_list.length, 1);
    eq('redo 失败后 undo 栈为空', H.history_fetch_undo_stack().length, 0);
    eq('redo 失败后 is_executing 复位', H.history_state.is_executing, false);
  }

  console.log('--- H5. 双硬上限 ---');
  {
    const a = [];
    H.history_init_manager();
    for (let i = 0; i < 101; i++) {
      await settle(H.history_execute_command(new H.DrawCommand({ stroke: i, strokeHistoryRef: a })));
    }
    eq('执行 101 次后 undo 栈裁到 50', H.history_fetch_undo_stack().length, 50);
    eq('裁剪保留的是最新的 50 条', H.history_fetch_undo_stack()[0].stroke, 51);
  }
  {
    H.history_init_manager();
    // 直接种 101 条：undo 栈自己的硬上限是 100（>100 立刻裁到 50），
    // 走 execute 路径无法凑出 101 次 undo，所以这里只测 redo 侧的裁剪。
    H.history_state.undo_list = Array.from({ length: 101 }, (_, i) =>
      new H.DrawCommand({ stroke: i, strokeHistoryRef: [] }));
    for (let i = 0; i < 101; i++) await settle(H.history_handle_undo());
    eq('redo 栈硬上限 100', H.history_state.redo_list.length, 100);
    // redo 栈的队首是「第一个被 undo 的命令」（= 当时 undo 栈顶，最新执行的那条），
    // 超限时 shift 掉的就是它；最新被 undo 的（原栈底 stroke 0）留在队尾。
    eq('redo 栈超限时丢弃的是 redo 队首（第一条被撤销的）', H.history_state.redo_list.some((c) => c.stroke === 100), false);
    eq('redo 栈队首变成第二条被撤销的', H.history_state.redo_list[0].stroke, 99);
    eq('redo 栈队尾是最早的 stroke 0', H.history_state.redo_list[99].stroke, 0);
  }

  console.log('--- H6. 压缩相关纯函数 ---');
  H.history_init_manager();
  const a6 = [];
  for (let i = 0; i < 55; i++) {
    await settle(H.history_execute_command(new H.DrawCommand({ stroke: i, strokeHistoryRef: a6 })));
  }
  eq('压缩判定：55 条时需要压缩', H.history_validate_compact(), true);
  eq('待压缩条数 = 55 - 50 = 5', H.history_fetch_commands_to_compact().length, 5);
  eq('待压缩的是最旧的 5 条', H.history_fetch_commands_to_compact()[0].stroke, 0);
  {
    const snap = new H.SnapshotCommand({ beforeImageURL: 'b', afterImageURL: 'a' });
    eq('format compact 成功', H.history_format_compact(snap), true);
    // 55 条：5 条被压成 1 个快照 + 剩余 50 条 = 51。
    eq('压缩后 undo 栈 = 1 快照 + 剩余 50', H.history_fetch_undo_stack().length, 51);
    eq('快照在栈底', H.history_fetch_undo_stack()[0] === snap, true);
    eq('保留下来的第一条是第 5 条命令', H.history_fetch_undo_stack()[1].stroke, 5);
    eq('explicitCount=0 不压缩', H.history_format_compact(snap, 0), false);
    eq('explicitCount=0 后栈不变', H.history_fetch_undo_stack().length, 51);
  }
  H.history_init_manager();
  const a7 = [];
  for (let i = 0; i < 3; i++) {
    await settle(H.history_execute_command(new H.DrawCommand({ stroke: i, strokeHistoryRef: a7 })));
  }
  {
    const a = [];
    H.history_init_manager();
    for (let i = 0; i < 50; i++) {
      await settle(H.history_execute_command(new H.DrawCommand({ stroke: i, strokeHistoryRef: a })));
    }
    eq('边界：恰好 50 条时不需要压缩', H.history_validate_compact(), false);
    eq('边界：恰好 50 条时待压缩列表为空', H.history_fetch_commands_to_compact().length, 0);
  }
  H.history_init_manager();
  const a8 = [];
  for (let i = 0; i < 3; i++) {
    await settle(H.history_execute_command(new H.DrawCommand({ stroke: i, strokeHistoryRef: a8 })));
  }
  eq('压缩判定：3 条时不需要压缩', H.history_validate_compact(), false);
  eq('待压缩列表为空', H.history_fetch_commands_to_compact().length, 0);

  console.log('--- H7. 清空 / 解锁 / 裁剪 / 去重 / 队列 ---');
  {
    H.history_init_manager();
    const a = [];
    await settle(H.history_execute_command(new H.DrawCommand({ stroke: 'p', strokeHistoryRef: a })));
    await settle(H.history_handle_undo());
    H.history_delete_all();
    eq('delete_all 清空 undo 栈', H.history_fetch_undo_stack().length, 0);
    eq('delete_all 清空 redo 栈', H.history_state.redo_list.length, 0);
  }
  {
    H.history_state.is_executing = true;
    H.history_reset_executing();
    eq('reset_executing 解锁', H.history_state.is_executing, false);
  }
  {
    H.history_init_manager();
    const a = [];
    for (let i = 0; i < 5; i++) {
      await settle(H.history_execute_command(new H.DrawCommand({ stroke: i, strokeHistoryRef: a })));
    }
    H.history_trim_undo_front(2);
    eq('trim_undo_front 从队首裁剪', H.history_fetch_undo_stack().length, 2);
    eq('trim_undo_front 保留最新两条', H.history_fetch_undo_stack()[0].stroke, 3);
  }
  {
    H.history_init_manager();
    const a = [];
    const dup = new H.DrawCommand({ stroke: 'dup', strokeHistoryRef: a });
    await settle(H.history_execute_command(dup));
    await settle(dup.execute());
    eq('重复 execute 不重复入栈', a.filter((x) => x === 'dup').length, 1);
  }
  {
    H.history_init_manager();
    const a = [];
    let release;
    const slow = {
      execute: () => new Promise((res) => { release = res; }),
      undo: async () => {}, redo: async () => {},
    };
    const p1 = H.history_execute_command(slow);
    const c2 = new H.DrawCommand({ stroke: 'q', strokeHistoryRef: a });
    const p2 = H.history_execute_command(c2);
    eq('队列：锁释放前第二条命令未生效', a.length, 0);
    release();
    await settle(p1); await settle(p2);
    eq('队列：锁释放后第二条命令生效', a.join(','), 'q');
  }
  {
    const states = [];
    H.history_init_manager({ on_state_change: (s) => states.push(s) });
    const a = [];
    await settle(H.history_execute_command(new H.DrawCommand({ stroke: 's', strokeHistoryRef: a })));
    const last = states[states.length - 1];
    eq('状态回调带 can_undo / can_redo / 计数',
      [last.can_undo, last.can_redo, last.undoCount, last.redoCount].join(','), 'true,false,1,0');
  }
};

// ─────────────────────────── 历史压缩器 ───────────────────────────
let idleCb = null, idleOpts = null, cancelled = null, idleSeq = 0;
let renderHook = async () => {};

class FakeImage {
  static autoLoad = true;
  static last = null;
  constructor() { FakeImage.last = this; }
  set src(v) { this._src = v; if (FakeImage.autoLoad && this.onload) this.onload(); }
  get src() { return this._src; }
}

const win = { DRAW_CONFIG: { canvasW: 100, canvasH: 100 }, __HISTORY_ISOLATED: false, tileRenderer: null };
const CX = loadModule(COMPACTOR, {
  window: win,
  requestIdleCallback: (cb, opts) => { idleCb = cb; idleOpts = opts; return ++idleSeq; },
  cancelIdleCallback: (id) => { cancelled = id; },
  Image: FakeImage,
  renderStrokesToContext: (...args) => renderHook(...args),
}, ['createHistoryCompactor']);
const C = CX.X.createHistoryCompactor;
eq('history-compactor.js 导出 createHistoryCompactor', typeof C, 'function');
if (typeof C !== 'function') process.exit(1);

const resetIdle = () => { idleCb = null; idleOpts = null; cancelled = null; };

// 构造一次完整压缩场景：笔画 s1..s4，压缩目标是 s1/s2。
const mkScenario = (overrides = {}) => {
  const strokes = ['s1', 's2', 's3', 's4'].map((id) => ({ id }));
  const state = {
    strokeHistory: strokes,
    baseImageURL: 'before.png',
    baseImageObj: { old: true },
    baseImageLoadId: 0,
    compactSnapshotId: 0,
  };
  const seen = {
    renderStrokes: null, renderOpts: null, released: 0, drawn: null,
    formatted: null, markAll: 0, renderCalls: 0, drawnImage: null,
  };
  const offscreen = {
    ctx: { drawImage: (img, x, y, w, h) => { seen.drawn = [x, y, w, h]; seen.drawnImage = img; } },
    canvas: { toDataURL: (fmt) => { seen.toDataURLFmt = fmt; return 'after.png'; } },
  };
  win.tileRenderer = { mark_all: () => { seen.markAll++; } };
  let releaseRender = null;
  renderHook = (ctx, targetStrokes, opts) => {
    seen.renderCalls++;
    seen.renderStrokes = targetStrokes;
    seen.renderOpts = opts;
    return new Promise((res) => { releaseRender = () => res(); });
  };
  // commandIds 用 id 引用真实笔画对象（Set 去重必须按对象引用，不能按字符串）。
  const commands = overrides.commandIds !== undefined
    ? overrides.commandIds.map((id) => ({ stroke: strokes.find((s) => s.id === id) }))
    : [{ stroke: strokes[0] }, { stroke: strokes[1] }];
  let validateCalls = 0;
  const deps = {
    state,
    cloneStrokeDeep: (arr) => arr.map((s) => JSON.parse(JSON.stringify(s))),
    fetchOffscreenCanvas: () => offscreen,
    releaseOffscreenCanvas: () => { seen.released++; },
    renderAllStrokes: () => {},
    loadBaseImage: () => {},
    penManager: () => ({ pm: true }),
    historyValidateCompact: () => { validateCalls++; return overrides.validate !== false && validateCalls < (overrides.failValidateAt || Infinity); },
    historyFetchUndoStack: () => overrides.undoStack || [{ can_compact: () => true }],
    historyFetchCommandsToCompact: () => overrides.commands !== undefined ? overrides.commands : commands,
    historyFormatCompact: (cmd, n) => { seen.formatted = [cmd, n]; },
    SnapshotCommand: H.SnapshotCommand,
  };
  const c = C(deps);
  return { state, seen, c, strokes, finishRender: () => releaseRender && releaseRender(), offscreen };
};

const runCompactor = async () => {
  console.log('--- C1. initCompaction 门控 ---');
  {
    resetIdle();
    win.__HISTORY_ISOLATED = true;
    const s = mkScenario();
    s.c.initCompaction();
    eq('隔离态不排空闲回调', idleCb, null);
    win.__HISTORY_ISOLATED = false;
  }
  {
    resetIdle();
    const s = mkScenario({ validate: false });
    s.c.initCompaction();
    eq('validate=false 不排空闲回调', idleCb, null);
  }
  {
    resetIdle();
    const s = mkScenario({ undoStack: [{ can_compact: () => false }] });
    s.c.initCompaction();
    eq('存在不可压缩命令时不排空闲回调', idleCb, null);
  }
  {
    resetIdle();
    const s = mkScenario();
    s.c.initCompaction();
    ok('正常情况排了空闲回调', typeof idleCb === 'function');
    eq('空闲回调 timeout = 2000', idleOpts && idleOpts.timeout, 2000);
    ok('compactIdleId 被记录', s.c.compactIdleId !== null);
    const id = s.c.compactIdleId;
    s.c.cancelCompaction();
    eq('cancel 清空 compactIdleId', s.c.compactIdleId, null);
    eq('cancelIdleCallback 收到排到的 id', cancelled, id);
  }
  {
    // 空闲回调真正触发时：清掉 id 并执行压缩（这里只验 id 被清，压缩细节在 C2）。
    resetIdle();
    const s = mkScenario();
    s.c.initCompaction();
    const cb = idleCb;
    cb();
    eq('空闲回调触发后 compactIdleId 清空', s.c.compactIdleId, null);
    s.finishRender();   // 让回调内部发起的异步压缩落定
    await settle(new Promise((res) => setTimeout(res, 0)));
  }

  console.log('--- C2. handleCompactStrokes 可执行语义 ---');
  {
    const s = mkScenario();
    const p = s.c.handleCompactStrokes();
    s.finishRender();
    await settle(p);

    eq('render 收到将被压缩的笔画（去重后的 s1/s2）',
      s.seen.renderStrokes.map((x) => x.id).join(','), 's1,s2');
    eq('penManager 透传给 render', s.seen.renderOpts.penManager.pm, true);
    eq('压缩后 strokeHistory 只剩未压缩笔画',
      s.state.strokeHistory.map((x) => x.id).join(','), 's3,s4');
    eq('baseImageURL 更新为压缩后底图', s.state.baseImageURL, 'after.png');
    eq('底图被画到 offscreen 的 (0,0,canvasW,canvasH)', s.seen.drawn.join(','), '0,0,100,100');
    eq('toDataURL 用 image/png', s.seen.toDataURLFmt, 'image/png');
    eq('image onload 后恢复 baseImageObj', s.state.baseImageObj._src, 'after.png');
    eq('tileRenderer.mark_all 在图片加载后被触发', s.seen.markAll, 1);
    eq('offscreen 被释放', s.seen.released, 1);
    eq('historyFormatCompact 收到快照与压缩目标条数', s.seen.formatted ? s.seen.formatted[1] : 'null', 2);

    const snap = s.seen.formatted[0];
    eq('快照类型 = snapshot', snap.type, 'snapshot');
    eq('快照记录完整压缩前笔画（深拷贝）',
      snap.beforeStrokes.map((x) => x.id).join(','), 's1,s2,s3,s4');
    ok('快照 beforeStrokes 是独立深拷贝数组', snap.beforeStrokes !== s.state.strokeHistory);
    eq('快照记录压缩后剩余笔画', snap.afterStrokes.map((x) => x.id).join(','), 's3,s4');
    eq('快照 beforeImageURL = 压缩前底图', snap.beforeImageURL, 'before.png');
    eq('快照 afterImageURL = 压缩后底图', snap.afterImageURL, 'after.png');
    eq('快照不可被再次压缩', snap.can_compact(), false);

    // 可重建语义：快照 undo 回到压缩前，redo 回到压缩后。
    await settle(snap.undo());
    eq('快照 undo 恢复压缩前全部笔画',
      s.state.strokeHistory.map((x) => x.id).join(','), 's1,s2,s3,s4');
    eq('快照 undo 恢复压缩前底图', s.state.baseImageURL, 'before.png');
    await settle(snap.redo());
    eq('快照 redo 回到压缩后状态',
      s.state.strokeHistory.map((x) => x.id).join(','), 's3,s4');
    eq('快照 redo 回到压缩后底图', s.state.baseImageURL, 'after.png');
  }

  console.log('--- C3. 去重 / 边界 / 过期快照 ---');
  {
    const s = mkScenario({ commandIds: ['s1', 's2', 's1'] });
    // commands 里 s1 重复，Set 去重后仍只渲染 s1/s2，format 收到 3 条目标数。
    const p = s.c.handleCompactStrokes();
    s.finishRender();
    await settle(p);
    eq('stroke 去重后仅压缩唯一笔画', s.seen.renderStrokes.map((x) => x.id).join(','), 's1,s2');
    eq('去重后只渲染唯一笔画（命令 3 条，唯一 2 条）', s.seen.renderStrokes.length, 2);
    eq('format 收到的是命令条数（含重复）', s.seen.formatted ? s.seen.formatted[1] : 'null', 3);
  }
  {
    const s = mkScenario({ commands: [] });
    const p = s.c.handleCompactStrokes();
    s.finishRender();   // 即使提前返回也放行：否则提前返回被改坏时 Promise 永远 pending
    await settle(p);
    eq('无压缩目标时直接返回（不 render）', s.seen.renderCalls, 0);
  }
  {
    const s = mkScenario({ validate: false });
    const p = s.c.handleCompactStrokes();
    s.finishRender();
    await settle(p);
    eq('validate=false 时 handle 不 render', s.seen.renderCalls, 0);
  }
  {
    const s = mkScenario({ undoStack: [{ can_compact: () => false }] });
    const p = s.c.handleCompactStrokes();
    s.finishRender();
    await settle(p);
    eq('执行前发现不可压缩命令时取消', s.seen.renderCalls, 0);
  }
  {
    const s = mkScenario({ failValidateAt: 2 });   // 第一次 validate 过，第二次（render 前）失败
    const p = s.c.handleCompactStrokes();
    s.finishRender();
    await settle(p);
    eq('压缩期间撤销栈变化时取消（第二次 validate）', s.seen.renderCalls, 0);
  }
  {
    const s = mkScenario();
    const p = s.c.handleCompactStrokes();
    s.state.baseImageLoadId++;                      // render 期间被新的底图加载抢占
    s.finishRender();
    await settle(p);
    eq('loadId 过期时不改 strokeHistory',
      s.state.strokeHistory.map((x) => x.id).join(','), 's1,s2,s3,s4');
    eq('loadId 过期时 baseImageObj 保持原样（提前返回，没碰它）',
      !!(s.state.baseImageObj && s.state.baseImageObj.old), true);
    eq('loadId 过期时释放 offscreen', s.seen.released, 1);
  }
  {
    const s = mkScenario();
    const p = s.c.handleCompactStrokes();
    s.state.compactSnapshotId++;                    // render 期间有更新的快照
    s.finishRender();
    await settle(p);
    eq('compactSnapshotId 过期时不改 strokeHistory',
      s.state.strokeHistory.map((x) => x.id).join(','), 's1,s2,s3,s4');
    eq('compactSnapshotId 过期时释放 offscreen', s.seen.released, 1);
  }
  {
    // 图片 onload 发生在压缩提交之后：此时若 loadId 已过期，onload 不得回填底图。
    FakeImage.autoLoad = false;
    try {
      const s = mkScenario();
      const p = s.c.handleCompactStrokes();
      s.finishRender();
      await settle(p);
      eq('图片 src 指向压缩后底图', FakeImage.last.src, 'after.png');
      eq('onload 前 baseImageObj 为 null', s.state.baseImageObj, null);
      s.state.baseImageLoadId++;
      FakeImage.last.onload();
      eq('onload 遇到过期 loadId 不恢复 baseImageObj', s.state.baseImageObj, null);
      eq('过期 onload 仍释放 offscreen', s.seen.released, 1);
    } finally {
      FakeImage.autoLoad = true;
    }
  }
};

const main = async () => {
  await runHistory();
  await runCompactor();
  console.log('');
  console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
};

main().catch((e) => {
  console.log('FAIL  未捕获异常: ' + (e && e.stack || e));
  process.exit(1);
});
