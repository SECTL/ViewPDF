import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// fileURLToPath 而非 new URL(...).pathname：后者在 Windows 上产出
// "/D:/code/..."，fs 解析时把开头的 "/" 当作当前盘根 → "D:\D:\code\..."
// ENOENT，探针在第一条用例前就崩（2026-10-02 修）。
const APP = process.env.VP_APP_SRC || fileURLToPath(new URL('../src', import.meta.url));

// ── 共享源码扫描器 ────────────────────────────────────────────────
// ⚠️ 只允许存在**一份**。此前本文件有两个各自为政的扫描块（各带一份 walk + strip），
// 修 strip 时只改到其中一份，另一份仍是旧的坏实现 —— 与「Client ID 在两个模块
// 各存一份」是同一类错误：复制出来的实现必然漂移，而且漂移是静默的。
const walkSrc = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(full, out);
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
};
const SKIP_SRC = /[\\/](JS|cmaps|locales|standards)[\\/]|\.min\./;
// 剥注释，但**不能把字符串字面量里的双斜杠当注释头**。
// 曾经的 `.replace(/\/\/[^\n]*/g,'')` 会把 'https://appwrite.sectl.cn'
// 从双斜杠处一路截断成 'https:' —— 凡是用它扫 URL 的守卫都是瞎的
// （实测：注入 api.github.com 后 harness 依然全绿）。
// 现在要求双斜杠前面不是冒号：URL 得以保留，真行注释照常剥掉。
// 连带好处：文档注释里**提到**某个字面量，不再被当成「代码里出现了它」。
const stripSrc = (t) =>
  t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const relSrc = (f) => f.replace(/\\/g, '/').slice(APP.length + 1);
const srcFiles = walkSrc(APP).filter((f) => !SKIP_SRC.test(f));
const srcBodies = new Map(srcFiles.map((f) => [f, stripSrc(fs.readFileSync(f, 'utf8'))]));
// scanRaw：未剥注释的原文。只在**故意**要扫注释时用；一般一律用 scan。
const srcRaw = new Map(srcFiles.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const scan = (re) => srcFiles.filter((f) => re.test(srcBodies.get(f))).map(relSrc).sort().join(',');
const scanRaw = (re) => srcFiles.filter((f) => re.test(srcRaw.get(f))).map(relSrc).sort().join(',');
const SRC = APP + '/modules/canvas/';
const read = f => fs.readFileSync(SRC + f, 'utf8');
const read2 = f => fs.readFileSync(path.join(APP, f), 'utf8');

const noop = () => {};
function make_ctx() {
  return {
    imageSmoothingEnabled: true,
    setTransform: noop, save: noop, restore: noop, drawImage: noop, clearRect: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
  };
}
function make_canvas() {
  return {
    width: 0, height: 0, style: {}, className: '', parentNode: null,
    getContext: () => make_ctx(),
    appendChild: noop,
    // 2026-10-02 补：OverlayManager._read_self_rect 会读覆盖层画布自身的
    // 视口矩形（set_rect_anchor 相对自身锚点折算，2026-10-01 引入）。
    // 此前 stub 缺这个方法，harness 在该用例处 TypeError 中断 —— 已确认
    // HEAD 源码同样中断，属探针陈旧而非代码回归。
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
}

const win = {
  devicePixelRatio: 2,
  DRAW_CONFIG: {
    baseDpr: 2, dprLimit: 2, dpr: 1,
    dynamicDprEnabled: true, dprMin: 1, dprMax: 4, dprStep: 0.25,
  },
};
const doc = { createElement: (tag) => (tag === 'canvas' ? make_canvas() : { style: {} }) };
const sandbox = {
  window: win, document: doc,
  performance: { now: () => 1000, memory: { usedJSHeapSize: 0 } },
  console, Math, Date, parseFloat, parseInt, Number, setTimeout, clearTimeout,
  requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('resolution-controller.js'), sandbox, { filename: 'resolution-controller.js' });
vm.runInContext(read('overlay-manager.js'), sandbox, { filename: 'overlay-manager.js' });

const RC = win.ResolutionController;
const cfg = win.DRAW_CONFIG;
const OM = win.OverlayManager;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
}
function ok(label, got) { eq(label, !!got, true); }

console.log('--- calc_tile_dpr: 动态开启 ---');
eq('scale=1', RC.calc_tile_dpr(1), 2);
eq('scale=1.5', RC.calc_tile_dpr(1.5), 3);
eq('scale=3 cap dprMax=4', RC.calc_tile_dpr(3), 4);
eq('scale=1.13 步进上取整', RC.calc_tile_dpr(1.13), 2.5);
eq('scale=0.2 落到 dprMin', RC.calc_tile_dpr(0.2), 1);
eq('role=neighbor 封顶 2', RC.calc_tile_dpr(2.5, { role: 'neighbor' }), 2);
eq('role=offscreen scale>3 ->1', RC.calc_tile_dpr(5, { role: 'offscreen' }), 1);
eq('role=offscreen scale<=3 保持全量', RC.calc_tile_dpr(1.5, { role: 'offscreen' }), 3);
eq('role=active 等同默认', RC.calc_tile_dpr(1.5, { role: 'active' }), 3);

console.log('--- 内存压力守卫 ---');
sandbox.performance.memory.usedJSHeapSize = 600 * 1024 * 1024;
eq('memoryGuard=true ->1', RC.calc_tile_dpr(2, { memoryGuard: true }), 1);
eq('memoryGuard 缺省不降级 (瓦片层)', RC.calc_tile_dpr(2), 4);
sandbox.performance.memory.usedJSHeapSize = 0;

console.log('--- 静态倍率与派生 DRAW_CONFIG.dpr ---');
eq('static_dpr = min(base2,limit2)', RC.static_dpr(), 2);
cfg.dynamicDprEnabled = false;
eq('动态关闭回落静态', RC.calc_tile_dpr(3), 2);
RC.sync_static_dpr();
eq('DRAW_CONFIG.dpr 同步为 2', cfg.dpr, 2);
cfg.dprLimit = 4;
eq('dprLimit=4 仍受 base 限制', RC.static_dpr(), 2);
// 基准 DPR 只能由显示 DPR 决定：注入点从 cfg.baseDpr 换成 devicePixelRatio
// （cfg.baseDpr 现在只是显示 DPR 的缓存，且读取时会自愈）
win.devicePixelRatio = 3;
cfg.baseDpr = 99;                       // 故意写脏，验证读取处就地修正
eq('读取即对齐显示 DPR', RC.base_dpr(), 3);
eq('脏缓存被就地修正', cfg.baseDpr, 3);
eq('baseDpr=3 后 static', RC.static_dpr(), 3);
cfg.dprLimit = 0;
eq('dprLimit=0 视为自动不限', RC.static_dpr(), 3);
win.devicePixelRatio = 2;
eq('显示 DPR 回落，基准跟随', RC.static_dpr(), 2);
cfg.dynamicDprEnabled = true; cfg.dprLimit = 2;

console.log('--- calc_overlay_dpr 屏幕空间 ---');
eq('显示 DPR 2 ->2', RC.calc_overlay_dpr(1), 2);
eq('不随缩放提升', RC.calc_overlay_dpr(3), 2);
cfg.overlayDpr = 1.5;
eq('overlayDpr 显式覆盖', RC.calc_overlay_dpr(3), 1.5);
// 绘画时 DPR 上限 6x：显式值钳制在 [0.5, 6]，异常导入值不得把覆盖层画布放大失控
cfg.overlayDpr = 6;
eq('overlayDpr 6x 允许', RC.calc_overlay_dpr(1), 6);
cfg.overlayDpr = 9;
eq('overlayDpr 超 6x 钳制', RC.calc_overlay_dpr(1), 6);
cfg.overlayDpr = 0.2;
eq('overlayDpr 低于 0.5x 钳制', RC.calc_overlay_dpr(1), 0.5);
delete cfg.overlayDpr;
cfg.dynamicDprEnabled = false;
eq('动态关闭 ->min(static,2)', RC.calc_overlay_dpr(1), 2);
cfg.dynamicDprEnabled = true;

console.log('--- calc_ui_dpr 小尺寸 UI ---');
eq('默认封顶 2', RC.calc_ui_dpr(1, 2), 2);
eq('cap=1', RC.calc_ui_dpr(1, 1), 1);

console.log('--- update_settings ---');
eq('无变化 -> 空数组', RC.update_settings({ dprLimit: 2 }).length, 0);
eq('改 dprLimit -> 1 项', RC.update_settings({ dprLimit: 3 }).join(','), 'dprLimit');
eq('dprLimit 变更后 static 跟随', RC.static_dpr(), 2);
// baseDpr 不再列在设置键里：写进去既不会被报告为变更，也会被读取处修正回去
eq('baseDpr 不是设置键', RC.update_settings({ baseDpr: 3 }).includes('baseDpr'), false);
eq('写入被读取处修正回显示 DPR', RC.static_dpr(), 2);
eq('DRAW_CONFIG.dpr 同步', cfg.dpr, 2);
cfg.dprLimit = 2; RC.sync_static_dpr();
eq('DRAW_CONFIG.dpr 落回 2', cfg.dpr, 2);

console.log('--- apply_persisted 启动回放 ---');
const changed1 = RC.apply_persisted({ dynamicDprEnabled: false, dprLimit: 4, overlayDpr: 1.5 });
eq('报告变更键', changed1.sort().join(','), 'dprLimit,dynamicDprEnabled,overlayDpr');
eq('回放后 static = min(2,4)', RC.static_dpr(), 2);
const changed2 = RC.apply_persisted({ dynamicDprEnabled: true, dprLimit: undefined, overlayDpr: 1.5 });
eq('undefined 不写入', changed2.join(','), 'dynamicDprEnabled');
cfg.baseDpr = 2; cfg.dprLimit = 2; delete cfg.overlayDpr;

console.log('--- register_context / refresh_all ---');
const seen = [];
RC.register_context({ id: 't', get_scale: () => 1.5, on_dpr_change: (s, f) => seen.push([s, f]) });
RC.refresh_all(true);
eq('上下文收到 scale', seen[0][0], 1.5);
eq('上下文收到 force', seen[0][1], true);
let threw = false;
const bad = { id: 'bad', get_scale: () => 1, on_dpr_change: () => { throw new Error('boom'); } };
RC.register_context(bad);
try { RC.refresh_all(); } catch (e) { threw = true; }
eq('单上下文异常不中断刷新', threw, false);
RC.unregister_context(bad);
seen.length = 0; RC.refresh_all();
eq('注销后不再收到', seen.length, 1);

console.log('--- 交互闸门 ---');
RC.mark_interaction();
eq('刚交互 is_interacting', RC.is_interacting, true);
eq('剩余时长 > 0', RC.interaction_remain_ms() > 0, true);

console.log('--- OverlayManager：attach 尺寸/DPR（自建入口已清理） ---');
const ov = new OM();
eq('取控制器覆盖层 DPR', ov._calc_dpr(1), 2);
eq('不再提供自建 canvas 入口 init()', typeof ov.init, 'undefined');
eq('不再提供 calc_overlay_dpr 别名', typeof ov.calc_overlay_dpr, 'undefined');

const ext = make_canvas();
const ov2 = new OM();
ov2.attach(ext, make_ctx(), 1024, 768);
eq('attach 像素宽', ov2.canvas.width, 2048);
eq('attach dpr', ov2.dpr, 2);

console.log('--- attach 自建 2D 上下文（调用方传 null） ---');
{
  const c = make_canvas();
  let asked = null;
  c.getContext = (type, attrs) => { asked = { type, attrs }; return make_ctx(); };
  const omD = new OM();
  omD.attach(c, null, 50, 50);
  eq('attach 自取上下文类型', asked && asked.type, '2d');
  eq('attach 使用默认 attributes', asked && asked.attrs.willReadFrequently, false);
  eq('attach 后 ctx 非空', omD.ctx != null, true);
}

console.log('--- 顺延机制已移除（内容快照取代它） ---');
eq('不再暴露 begin_stroke', typeof OM.prototype.begin_stroke, 'undefined');
eq('不再暴露 end_stroke', typeof OM.prototype.end_stroke, 'undefined');
eq('不再暴露 request_dpr', typeof OM.prototype.request_dpr, 'undefined');
eq('不再持有 _strokeActive', typeof new OM()._strokeActive, 'undefined');
eq('不再持有 _deferredDpr', typeof new OM()._deferredDpr, 'undefined');
eq('不再持有迟滞定时器字段', typeof new OM()._dprSettleTimerId, 'undefined');

console.log('--- 几何唯一路径：尺寸未变提前返回，不白清空 ---');
{
  const c = make_canvas();
  let draws = 0;
  const ctx = make_ctx();
  ctx.drawImage = () => { draws++; };
  const om = new OM();
  om.attach(c, ctx, 100, 100);
  draws = 0;
  const changed = om._apply_geometry(100, 100, 2);
  eq('同尺寸同 DPR 不重设画布', changed, false);
  eq('同尺寸不产生快照回写（无白清空）', draws, 0);
  // 展示尺寸变了但画布无内容时也不该崩
  eq('无内容 resize 正常改写像素宽', (() => { om.resize(200, 120); return c.width; })(), 400);
}

console.log('--- 尺寸变化：快照 → 重设 → 回写（笔迹不闪断） ---');
{
  const c = make_canvas();
  let draws = 0;
  const ctx = make_ctx();
  ctx.drawImage = () => { draws++; };
  const om = new OM();
  om.attach(c, ctx, 100, 100);
  draws = 0;
  om.resize(200, 150);
  eq('resize 后展示宽', om._displayW, 200);
  eq('resize 后展示高', om._displayH, 150);
  eq('resize 后像素宽 = 展示宽 × DPR', c.width, 400);
  eq('尺寸变化走快照回写一次', draws, 1);
}

console.log('--- 笔画进行中 resize / DPR 变更立即生效（无顺延） ---');
{
  const om = new OM();
  const c = make_canvas();
  const ctx = make_ctx();
  om.attach(c, ctx, 100, 100);
  om.resize(300, 300);            // 旧机制下会被顺延丢弃
  eq('笔画中 resize 立即改像素尺寸', c.width, 600);
  om.dpr = 1;
  om.sync_dpr_now(1);
  eq('笔迹中 sync_dpr_now 立即收敛 DPR', om.dpr, 2);
  eq('sync_dpr_now 不动展示尺寸', om._displayW, 300);
  om.destroy();
  eq('destroy 后画布像素归零', c.width, 0);
  eq('destroy 后可复用（无残留标记）', typeof om._strokeActive, 'undefined');
}

console.log('--- set_rect_anchor：统一「锚点=实时矩形」 ---');
{
  const omA = new OM();
  const calls = [];
  const ctxA = make_ctx();
  ctxA.setTransform = (...a) => calls.push(a);
  omA.attach(make_canvas(), ctxA, 100, 100);
  const dpr = omA.dpr;
  const last = () => calls[calls.length - 1];

  omA.set_rect_anchor({ get_rect: () => ({ left: 40, top: 12 }), get_scale: () => 2 });
  omA.sync_transform();
  eq('矩形 originX 参与平移', last()[4], 40 * dpr);
  eq('矩形 originY 参与平移', last()[5], 12 * dpr);
  eq('scale 参与缩放', last()[0], 2 * dpr);

  omA.set_rect_anchor({
    get_rect: () => null, get_scale: () => 1,
    fallback_origin: () => ({ x: 7, y: 9 })
  });
  omA.invalidate_transform();
  omA.sync_transform();
  eq('无矩形时用兜底 x', last()[4], 7 * dpr);
  eq('无矩形时用兜底 y', last()[5], 9 * dpr);

  omA.set_rect_anchor({ get_rect: () => null });
  omA.invalidate_transform();
  omA.sync_transform();
  eq('无矩形无兜底 -> 0', last()[4], 0);
  eq('get_scale 缺省 -> 1', last()[0], dpr);
}

console.log('--- 未注入锚点时安全降级（原 window.state 旧约定已删） ---');
{
  const omB = new OM();
  const callsB = [];
  const ctxB = make_ctx();
  ctxB.setTransform = (...a) => callsB.push(a);
  omB.attach(make_canvas(), ctxB, 10, 10);
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  omB.sync_transform();
  omB.invalidate_transform();
  omB.sync_transform();
  console.warn = origWarn;
  eq('回退单位变换 scale', callsB[callsB.length - 1][0], omB.dpr);
  eq('回退单位变换 平移=0', callsB[callsB.length - 1][4], 0);
  eq('只告警一次', warns.length, 1);
}

console.log('--- 控制器缺失：显式降级而非复刻公式 ---');
{
  const saved = win.ResolutionController;
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  win.ResolutionController = undefined;
  const omC = new OM();
  const got = omC._calc_dpr(1);
  console.error = origErr;
  win.ResolutionController = saved;
  eq('缺控制器 -> 1x', got, 1);
  eq('缺控制器有报错', errs.length, 1);
}

console.log('--- invalidate_transform / destroy ---');
const om6 = new OM();
om6.attach(make_canvas(), make_ctx(), 100, 100);
om6._transformScale = 9;
om6.invalidate_transform();
eq('清零 scale 缓存', om6._transformScale, 0);

const om7 = new OM();
const victim = make_canvas();
victim.parentNode = { removeChild: () => { victim.parentNode = null; } };
om7.attach(victim, make_ctx(), 100, 100);
om7.set_rect_anchor({ get_rect: () => ({ left: 1, top: 1 }) });
om7.destroy();
eq('destroy 清零宽', victim.width, 0);
eq('destroy 置空 canvas', om7.canvas, null);
eq('destroy 清零展示尺寸', om7._displayW, 0);
eq('destroy 释放锚点 provider', om7._transformProvider, null);

console.log('--- RealtimeBatchDrawManager 不再转售覆盖层 API ---');
vm.runInContext(read('batch-draw.js'), sandbox, { filename: 'batch-draw.js' });
{
  const bd = win.batchDrawManager;
  eq('batch-draw 已加载并自建实例', typeof bd, 'object');
  eq('不再转发 set_transform_provider', typeof bd.set_transform_provider, 'undefined');
  eq('不再转发 update_overlay_dpr', typeof bd.update_overlay_dpr, 'undefined');
  eq('不再转发 sync_overlay_dpr_now', typeof bd.sync_overlay_dpr_now, 'undefined');
  eq('不再转发 resize_overlay', typeof bd.resize_overlay, 'undefined');
  eq('不再转发 destroy_overlay', typeof bd.destroy_overlay, 'undefined');
  eq('不再转发 hide/show_overlay', typeof bd.hide_overlay + '/' + typeof bd.show_overlay, 'undefined/undefined');
  eq('不再有 _overlayCtx 代理', typeof bd._overlayCtx, 'undefined');
  eq('不再有 _overlayCanvas 代理', typeof bd._overlayCanvas, 'undefined');
  eq('不再有 _overlayDpr 代理', typeof bd._overlayDpr, 'undefined');
  eq('不再有 _overlayTransformScale 代理', typeof bd._overlayTransformScale, 'undefined');
  eq('不再有 _sync_overlay_transform 转发', typeof bd._sync_overlay_transform, 'undefined');
  eq('仍持有 overlay 实例', bd.overlay instanceof OM, true);
  eq('主画布 overlay 无 canvas', bd.overlay.canvas, null);
  let safe = true;
  try { bd.clear_overlay(); } catch (e) { safe = false; }
  eq('主画布无覆盖层时 clear_overlay 安全', safe, true);
}

console.log('--- 页面位图宽度上限 _pdf_cap_render_dpr（2026-10-02 翻页性能）---');
{
  // 从 document_reader.js 顶层切出纯函数区间（LADDER → class 之前），
  // 不加载整个模块：这几个函数零依赖，切片即可单测，且避免为探针伪造
  // pdfjs/document 桩。切不出区间 = 结构漂移，探针必须当场失败。
  const readerSrc = read2('modules/pdf/document_reader.js');
  const s = readerSrc.indexOf('const PDF_DPR_LADDER');
  const e = readerSrc.indexOf('class DocumentReaderManager');
  if (s < 0 || e < 0 || e <= s) {
    eq('能在 document_reader.js 中定位栅格化纯函数区间', false, true);
  } else {
    eq('能在 document_reader.js 中定位栅格化纯函数区间', true, true);
    const capSandbox = { Math, console, Number, Number_: Number };
    capSandbox.globalThis = capSandbox;
    vm.createContext(capSandbox);
    // 尾部追加取值表达式：vm 里顶层 `const` 不会挂到 context 对象上
    // （只有 var/function 会），必须显式导出才能断言。
    vm.runInContext(
      readerSrc.slice(s, e) +
        '\nglobalThis.__cap = { MAXW: PDF_RASTER_MAX_DEV_W_DEFAULT, LADDER: PDF_DPR_LADDER,' +
        ' HR: PDF_RASTER_ZOOM_HEADROOM, lim: _pdf_raster_limit };',
      capSandbox, { filename: 'reader-caps.mjs' });
    const cap = capSandbox._pdf_cap_render_dpr;
    const qUp = capSandbox._pdf_quantize_render_dpr;
    const qDn = capSandbox._pdf_quantize_render_dpr_floor;
    const lim = capSandbox.__cap.lim;
    const MAXW = capSandbox.__cap.MAXW;
    const HR = capSandbox.__cap.HR;

    eq('默认位图上限 = 2048 设备像素（~248 DPI A4，主流阅读器档位）', MAXW, 2048);
    eq('默认放大余量 = 2 倍基准', HR, 2);

    // —— 放大清晰度（2026-10-02 用户要求：放大后分辨率要提高）——
    // 页面盒 CSS 宽不随缩放变（缩放是 wrapper transform），固定上限会把
    // 放大后的清晰度一起钉死。位图宽上限必须随 scale 增长。
    eq('放大余量在 scale=1 时不改变上限', lim(MAXW, 1, HR), MAXW);
    eq('余量随 scale 线性增长（1x→2x 位图宽翻倍）', lim(MAXW, 2, HR), MAXW * 2);
    eq('余量在 1.5x 时为 1.5 倍基准', lim(MAXW, 1.5, HR), MAXW * 1.5);
    eq('余量封顶（scale≥2 不再增长，避免 322MB 纹理）', lim(MAXW, 4, HR), MAXW * HR);
    eq('余量为 1 时上限不随缩放变化（非活动页恒为基准档）', lim(MAXW, 4, 1), MAXW);
    eq('余量 2 时 2x 放大位图宽 = 2×css_w（1:1），邻页档（余量1）仍为 css_w',
       [Math.ceil(1888 * cap(1888, qUp(4), lim(MAXW, 2, HR))),
        Math.ceil(1888 * cap(1888, qUp(4), lim(MAXW, 2, 1)))].join('='),
       (1888 * 2) + '=' + 1888);
    eq('非法 scale / headroom 退回安全默认',
     [lim(MAXW, 0, HR), lim(MAXW, NaN, HR), lim(MAXW, 2, 0)].every(v => v > 0 && Number.isFinite(v)), true);

    // 实际效果：1920 窗口 A4，2x 放大应达到屏幕 1:1（位图宽 == css_w × scale）
    {
      const cssW = 1888;
      const d1 = cap(cssW, qUp(2), lim(MAXW, 1, HR));
      const d2 = cap(cssW, qUp(4), lim(MAXW, 2, HR));
      eq('1920窗 1x 放大位图宽 = css_w（1:1）', Math.ceil(cssW * d1), cssW);
      eq('1920窗 2x 放大位图宽 = css_w×2（1:1 锐利）', Math.ceil(cssW * d2), cssW * 2);
      eq('放大确实提升了设备像素密度', d2 > d1, true);
    }

    // 向下取整契约：阶梯区间内结果必须在阶梯上且不高于输入
    // （向上取整会突破宽度上限，这是两条量化函数必须分开的原因）
    let dnOk = true;
    for (const d of [0.5, 0.76, 1.0, 1.3, 1.63, 2.0, 2.4, 3.0, 4.0, 7.9, 20]) {
      if (!(qDn(d) <= d + 1e-6) || qDn(d) > 8 || !(qUp(d) >= d - 1e-6)) dnOk = false;
    }
    eq('向下量化恒不高于输入、向上量化恒不低于输入', dnOk, true);
    eq('低于阶梯最低档时向下量化退到最低档（不再下探）', qDn(0.1), 0.5);

    // 退化守卫：css_w 非法时不得改变控制器目标
    eq('css_w=0 原样返回', cap(0, 2), 2);
    eq('css_w=NaN 原样返回', cap(NaN, 2), 2);

    // 未超上限时逐像素保持原值 —— DPR=1 机型（现有全部调参基准）必须完全不受影响
    eq('DPR1 1920窗 scale1 不变（逐像素保持）', cap(1888, 1), 1);
    eq('DPR1 2560窗 scale1 不变（1:1 下限守住，非 HiDPI 屏不被糊）', cap(2528, 1), 1);
    eq('DPR1.5 1280窗 scale1 不变（1:1 下限）', cap(1248, 1.5), 1.5);
    eq('DPR2 1280窗 scale1 收敛', cap(1248, 2), 1.5);
    eq('占位 0.5x 永不被夹', cap(1888, 0.5), 0.5);
    eq('远页 1x 预渲染不被夹到 0.75x（1:1 下限）', cap(2528, 1), 1);
    // 已知且有意的行为变化：默认上限降到 2048 后，DPR>=1.5 机型在 1280 及以上
    // 宽窗都会被收敛到 1.0x（约 248 DPI）。此处显式断言以免日后误当回归改回去。
    eq('DPR1.5 1920窗 scale1 收敛到 1:1（~248 DPI）', cap(1888, 1.5), 1);

    // HiDPI 宽窗：必须收敛（未设上限时 1920/DPR2 scale1 = 77MB、scale≥2 = 308MB）
    eq('DPR2 1920窗 scale1 收敛', cap(1888, 2), 1);
    eq('DPR2 1920窗 scale2 收敛', cap(1888, 4), 1);
    eq('DPR2 1920窗 scale4 收敛', cap(1888, 4), 1);
    eq('DPR2 2560窗 scale1 收敛到 1:1 下限（非 0.75x）', cap(2528, 2), 1);

    // 全矩阵不变式：位图宽度既不超过像素上限，也**不低于 1:1**（每 CSS 像素
    // 至少 1 个设备像素）。故上界是 max(上限, css_w) —— 宽窗由页面自身已被
    // 拉伸来补偿，不靠继续降密度（非 HiDPI 屏上主动糊图不可接受）。
    // 1.02 容差 = 阶梯档位粒度（上限恰好落在两档之间时向下取整最多高出一档）。
    let worstRatio = 0, worstCase = '';
    let minRatio = Infinity, minCase = '';
    for (const cssW of [200, 640, 1248, 1568, 1888, 2528, 3440]) {
      for (const base of [1, 1.25, 1.5, 2, 2.25, 3]) {
        for (const scale of [0.25, 0.5, 1, 1.5, 2, 3, 4]) {
          const ctrl = qUp(Math.min(4, Math.max(1, Math.ceil(base * scale / 0.25) * 0.25)));
          // 上限随缩放增长（放大清晰度余量），故此处按同一公式取 limit
          const L = lim(MAXW, scale, HR);
          const devW = Math.ceil(cssW * cap(cssW, ctrl, L));
          const r = devW / Math.max(L, cssW);
          if (r > worstRatio) { worstRatio = r; worstCase = `cssW=${cssW} base=${base} scale=${scale} → ${devW}px`; }
          const lr = devW / cssW;
          if (lr < minRatio) { minRatio = lr; minCase = `cssW=${cssW} base=${base} scale=${scale} → ${devW}px`; }
        }
      }
    }
    eq(`全矩阵位图宽度 ≤ max(上限, css宽)（${worstCase}）`, worstRatio <= 1.02, true);
    eq(`全矩阵位图不低于 1:1（${minCase}）`, minRatio >= 0.999, true);
  }
}

console.log('--- 冲量位移豁免（impulse）不变量 ---');
{
  const body = read2('modules/pdf/document_reader.js');
  // 抽出方法体（大括号配平），用于「该函数内不得出现非冲量调用」的负向守卫
  const method = (name) => {
    const i = body.search(new RegExp('\\n    (?:async )?' + name + '\\('));
    if (i < 0) return null;
    let d = 0, started = false;
    for (let k = body.indexOf('{', i); k < body.length; k++) {
      if (body[k] === '{') { d++; started = true; }
      else if (body[k] === '}') { d--; if (started && d === 0) return body.slice(i, k + 1); }
    }
    return null;
  };
  const sync = method('_dr_sync_transform') || '';
  const apply = method('_dr_apply_scale') || '';

  eq('_dr_sync_transform 有 impulse 形参（默认 false）', /_dr_sync_transform\s*\(\s*impulse\s*=\s*false\s*\)/.test(sync), true);
  eq('_dr_sync_transform 仅在非冲量时续期渲染暂停窗口',
     /else if \(!impulse\)[\s\S]{0,120}_dr_mark_render_gesture\(\)/.test(sync), true);
  eq('_dr_sync_transform 仍保留仅缩放冻结分支',
     /if \(this\._dr_last_transform\.scale !== this\.dr_scale\)[\s\S]{0,160}mark_interaction\(\)/.test(sync), true);
  eq('_dr_apply_scale 有 impulse 形参并透传',
     /_dr_apply_scale\s*\(\s*impulse\s*=\s*false\s*\)/.test(apply) &&
     /this\._dr_sync_transform\(impulse\)/.test(apply), true);

  // 冲量路径必须显式传 true；且这些函数体内不得残留裸调用
  // （裸调用 = 又把自己当手势帧，回归到 120ms 暂停 + 线程限流的老行为）
  const IMPULSE = ['_scroll_to_page', '_handle_reader_resize', '_on_reader_geometry_changed'];
  for (const fn of IMPULSE) {
    const b = method(fn) || '';
    eq(`${fn} 存在`, b.length > 0, true);
    eq(`${fn} 内无裸 _dr_apply_scale()`, /_dr_apply_scale\(\s*\)/.test(b), false);
  }
  eq('_scroll_to_page 冲量翻页', /_dr_apply_scale\(true\)/.test(method('_scroll_to_page') || ''), true);
  eq('_handle_reader_resize 冲量 resize', /_dr_apply_scale\(true\)/.test(method('_handle_reader_resize') || ''), true);
  eq('_on_reader_geometry_changed 冲量 resize', /_dr_apply_scale\(true\)/.test(method('_on_reader_geometry_changed') || ''), true);

  // Ctrl+0 重置缩放在 _handle_keydown 内（不单独成方法）：切出该分支再断言，
// 避免用固定字符窗口跨越长注释导致脆弱
  const kd = method('_handle_keydown') || '';
  const z0 = kd.indexOf("key === '0'");
  const ctrl0 = z0 < 0 ? '' : kd.slice(z0, kd.indexOf('return;', z0));
  eq('Ctrl+0 重置缩放走冲量路径', /_dr_apply_scale\(true\)/.test(ctrl0), true);
  eq('Ctrl+0 重置前先清遗留暂停窗口', /_dr_cancel_zoom_debounce\(\)/.test(ctrl0), true);

  // 真实手势路径（拖拽惯性/滚轮/捏合）必须保持默认非冲量，否则平移流畅性回退
  const gestureFns = ['_dr_momentum_tick', '_dr_handle_wheel'];
  for (const fn of gestureFns) {
    const b = method(fn) || '';
    eq(`${fn} 存在`, b.length > 0, true);
    eq(`${fn} 内无冲量豁免（手势续期暂停必须保留）`, /_dr_apply_scale\(true\)/.test(b), false);
  }

  // 目标计算唯一入口：非占位两条分支都必须过宽度上限夹取
  const dp = method('_pdf_desired_render_params') || '';
  eq('_pdf_desired_render_params 存在', dp.length > 0, true);
  eq('_pdf_desired_render_params 非占位分支均过宽度上限',
     (dp.match(/_pdf_cap_render_dpr\(/g) || []).length >= 2, true);
  eq('_pdf_desired_render_params 仍先做向上阶梯量化',
     (dp.match(/_pdf_quantize_render_dpr\(/g) || []).length >= 2, true);
}

console.log('--- 翻页预渲染扇出上限（2026-10-02 翻页延迟）---');
{
  // 背景：一次「下一页」曾连带派发 6 次整页栅格化 / 163MB 位图 / 14 次画布
  // backing store 重分配（目标 1 次 + 邻页 5 次）。每条提交都要挤 48ms 全局
  // 节流，翻页后有 ~26 帧的提交尾巴。以下三条把扇出钉回「需求驱动最小深度」。
  const body = read2('modules/pdf/document_reader.js');
  const method = (name) => {
    const i = body.search(new RegExp('\\n    (?:async )?' + name + '\\('));
    if (i < 0) return null;
    let d = 0, started = false;
    for (let k = body.indexOf('{', i); k < body.length; k++) {
      if (body[k] === '{') { d++; started = true; }
      else if (body[k] === '}') { d--; if (started && d === 0) return body.slice(i, k + 1); }
    }
    return null;
  };

  const nav = method('_prerender_for_navigation') || '';
  eq('_prerender_for_navigation 存在', nav.length > 0, true);
  // 窗口必须是 ±1：offset 循环上下界
  eq('翻页预渲染窗口 = ±1 页（不得放宽到 ±5）',
     /for \(let offset = -1; offset <= 1; offset\+\+\)/.test(nav), true);
  // 必须以 target_index 为基准预挂载 DOM，否则远跳后邻域因「无 DOM」被
  // _schedule_prerender 全数过滤（实测远跳后邻页零预渲染）
  eq('翻页预渲染按 target_index 预挂载 DOM',
     /Math\.abs\(idx - target_index\) <= this\._wrapper_keep_distance[\s\S]{0,200}_ensure_page_element\(idx\)/.test(nav), true);
  eq('翻页预挂载受虚拟化与 wrapper 存在性守卫',
     /_dom_virtualize\(\) && !pd\.page_element && this\._zoom_wrapper/.test(nav), true);

  const pump = method('_dr_prerender_pump_tick') || '';
  const vis = method('_check_page_visibility') || '';
  eq('_dr_prerender_pump_tick 存在', pump.length > 0, true);
  eq('_check_page_visibility 存在', vis.length > 0, true);
  // 单帧冲量（程序化翻页）不得启动泵：必须连续两帧都在动。
  // 泵的启动点在 _check_page_visibility 里，不在 pump 自身方法体内。
  eq('紧急预渲染泵要求连续两帧运动（单帧翻页冲量不启动）',
     /_dr_moving_frames\s*=\s*moving\s*\?\s*\(\(this\._dr_moving_frames \|\| 0\)\s*\+\s*1\)\s*:\s*0/.test(vis) &&
     /if \(moving && this\._dr_moving_frames >= 2[\s\S]{0,90}_dr_start_prerender_pump\(\);/.test(vis), true);
  eq('紧急预渲染泵不再扫描未挂载页（避免每帧空转渲染入口）',
     /if \(!pd\.page_element\) continue;/.test(pump), true);

  // ---- 连点期的批注层错峰（2026-10-02）----
  // 背景：程序化翻页刻意不续期渲染暂停窗口（否则目标页要等 290ms），
  // 那条门控一撤，快速连点就变成「每点一次在输入事件里同步栅格化该页全部
  // 笔迹」。实测每页 120 笔时是 2×120 笔的 rebuild_all 落在按键到下一帧之间
  // （探针 reader-flip-latency.mjs：连点 8 次 = 16 次同步建瓦片 / 1920 笔）。
  const onv = method('_on_page_visible') || '';
  eq('_on_page_visible 存在', onv.length > 0, true);
  eq('批注瓦片延后条件含连点判定（_dr_flipping_rapidly）',
     /if \(\(this\._dr_renders_paused\(\) \|\| this\._dr_flipping_rapidly\(\) \|\| this\._dr_tile_init_draining\)/.test(onv), true);
  eq('_on_page_visible 不再无条件二次初始化瓦片（去重）',
     /_resize_page_layout\(page_index, this\._get_page_base_width\(\)\);[\s\S]{0,220}if \(!page_data\.is_tiles_initialized\) \{\s*this\._init_page_tiles\(page_index\);/.test(onv), true);
  eq('_on_page_visible 不得出现裸的无条件 _init_page_tiles',
     /this\._resize_page_layout\(page_index, this\._get_page_base_width\(\)\);\s*\n\s*this\._init_page_tiles\(page_index\);/.test(onv), false);

  const note = method('_dr_note_flip') || '';
  eq('_dr_note_flip 存在', note.length > 0, true);
  eq('翻页必须记录连点窗口', /_dr_flip_recent_until = performance\.now\(\) \+ this\._dr_flip_rapid_window_ms/.test(note), true);
  // 延后不等于修复：排空泵原本挂在手势恢复上，翻页不续期手势窗口 ⇒ 必须自带兜底
  eq('_dr_note_flip 必须为错峰队列武装兜底排空定时器（否则延后页批注永不出现）',
     /_dr_flip_drain_timer = setTimeout\([\s\S]{0,200}_dr_drain_tile_init_queue\(\)/.test(note), true);
  eq('_scroll_to_page 必须调用 _dr_note_flip',
     /_dr_note_flip\(\);\s*\n\s*this\._prerender_for_navigation\(page_index\);/.test(method('_scroll_to_page') || ''), true);

  eq('连点期间屏蔽紧急预渲染泵（远页深前瞻与可见页抢线程槽位）',
     /if \(moving && this\._dr_moving_frames >= 2 && !this\._dr_flipping_rapidly\(\)\)/.test(vis), true);
  eq('close 必须清理连点排空定时器（否则关闭后回调建瓦片）',
     /_dr_flip_drain_timer != null\)[\s\S]{0,120}clearTimeout\(this\._dr_flip_drain_timer\)/.test(body), true);
}

console.log('--- 诊断探针不得留在生产路径（2026-10-02 GPU 回读）---');
{
  // 背景：TileRenderer.diag_content_ratio() 逐 tile 做一次 drawImage +
  // getImageData。getImageData 是同步 GPU→CPU 回读，会 flush 管线等驱动搬纹理。
  // 网格 = ceil(css宽/512)×ceil(css高/512)，1920/DPR2 fit-width 的 A4 是 4×6=24 块
  // ⇒ 每次调用 24 次回读。它的调用点有三个，其中两个在生产热路径：
  //   _check_page_visibility 的 active 页变更分支（每次翻页一次）
  //   _render_page_strokes / _submit_stroke（每次落笔一次）
  // 而它只把结果塞进 _dr_diag 环形缓冲，非调试时无人读取。
  const tr = read2('modules/canvas/tile-renderer.js');
  const dr = read2('modules/pdf/document_reader.js');
  const method = (name) => {
    const i = dr.search(new RegExp('\\n    (?:async )?' + name + '\\('));
    if (i < 0) return null;
    let d = 0, started = false;
    for (let k = dr.indexOf('{', i); k < dr.length; k++) {
      if (dr[k] === '{') { d++; started = true; }
      else if (dr[k] === '}') { d--; if (started && d === 0) return dr.slice(i, k + 1); }
    }
    return null;
  };

  eq('TileRenderer.diag_enabled 默认关闭', /static diag_enabled = false;/.test(tr), true);
  eq('diag_content_ratio 接受 force 参数', /diag_content_ratio\(force = false\)/.test(tr), true);
  eq('diag_content_ratio 在未开启时立即返回（不做任何回读）',
     /diag_content_ratio\(force = false\) \{\s*\n\s*if \(!force && !TileRenderer\.diag_enabled\) return \{\};/.test(tr), true);
  // getImageData 必须仍在循环体内（探针本身没被掏空成假绿）
  eq('diag_content_ratio 仍真做逐 tile getImageData（否则探针是假绿）',
     /getImageData\(0, 0, 48, 48\)/.test(tr), true);

  // 三个调用点：生产路径不得传 force；功能性调用点（开页看门狗自愈）必须传。
  // 负向判据必须能识破 `diag_content_ratio(true)` 与 `diag_content_ratio?.(true)`
  // 两种写法——只匹配前者的正则会在后者出现时空转（变异测试实测踩过）。
  const FORCE_TRUE = /diag_content_ratio\??\.?\(\s*true\s*\)/;
  const visBody = method('_check_page_visibility') || '';
  eq('翻页路径的探针调用不得 force（否则又回到每次翻页 24 次回读）',
     !FORCE_TRUE.test(visBody), true);
  eq('落笔路径 _submit_stroke 的探针调用不得 force',
     !FORCE_TRUE.test(method('_submit_stroke') || ''), true);
  eq('_render_page_strokes 的探针调用不得 force',
     !FORCE_TRUE.test(method('_render_page_strokes') || ''), true);
  eq('开页看门狗的探针必须 force=true（它是功能性自愈，不是纯诊断）',
     /diag_content_ratio\(true\)/.test(method('_start_open_watchdog') || ''), true);
  eq('宿主按 drDiag 开关注入 diagEnabled（默认即关，显式传入表明意图）',
     /diagEnabled: this\._diag_verbose/.test(dr), true);
}

console.log('--- 运动期降密度 / 停止后升清（2026-10-02 用户指定策略）---');
{
  // 依据真机 trace：卡顿不在主线程（CrRendererMain 无 >=50ms 任务，29/29 卡顿帧
  // 主线程空闲），GPU 进程 >50ms 任务 100% 落在卡顿帧内、单条 GPUTask 最长 314ms。
  // 纹理量是唯一有效杠杆，故运动期把页面栅格密度压到 0.75x（45MB → 11MB）。
  const dr = read2('modules/pdf/document_reader.js');
  const ladder = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
  const method = (name) => {
    const i = dr.search(new RegExp('\\n    (?:async )?' + name + '\\('));
    if (i < 0) return null;
    let d = 0, started = false;
    for (let k = dr.indexOf('{', i); k < dr.length; k++) {
      if (dr[k] === '{') { d++; started = true; }
      else if (dr[k] === '}') { d--; if (started && d === 0) return dr.slice(i, k + 1); }
    }
    return null;
  };

  const act = method('_pdf_motion_dpr_active') || '';
  const cap = method('_pdf_motion_dpr_cap') || '';
  const dp = method('_pdf_desired_render_params') || '';
  eq('_pdf_motion_dpr_active 存在', act.length > 0, true);
  eq('运动期上限取自阶梯档（0.75），避免引入第二份量化口径',
     /this\._DR_MOTION_DPR_MAX = 0\.75;/.test(dr) && ladder.includes(0.75), true);
  eq('缩放中不降密度（捏合放大时降密度等于主动做糊）',
     /if \(this\._dr_is_zooming\) \{ this\._dr_motion_dpr_until = 0; return false; \}/.test(act), true);
  eq('运动中进入降密度并顺延 hold 长窗（长窗出，防滑动中抖动重栅格化）',
     /_dr_motion_dpr_until = now \+ this\._DR_MOTION_DPR_HOLD_MS/.test(act), true);
  eq('未超 hold 才算仍在运动（静止后自动退出降密度）',
     /return now < this\._dr_motion_dpr_until;/.test(act), true);
  eq('_pdf_motion_dpr_cap 非运动期返回 Infinity（即不设上限）',
     /if \(!this\._pdf_motion_dpr_active\(\)\) return Infinity;/.test(cap), true);

  // 占位（0.5x）必须早于运动上限返回，不被二次夹取
  const phAt = dp.indexOf('is_placeholder');
  const clampAt = dp.indexOf('clamp_motion');
  eq('滑动占位早于运动上限返回（0.5x 本身已低于上限）',
     phAt >= 0 && clampAt > phAt, true);
  // 运动上限**只**作用于「从未渲染过且非预渲染」的页。
  // 2026-10-02 用户实测「刚开始滑动时卡一下」，两档分辨率都复现，根因是：
  //   ① 已有内容的可见页被降级 → 新栅格化 + 画布 backing store 重分配
  //      （~200ms 帧饿头号成因），且降级滞回守卫拦不住（1.25 > 0.75×1.35）
  //   ② 预渲染页被降级 → 一入视口 need_sharp 立即 force 升清，每页两次渲染
  eq('运动上限不得降级已有内容的页（滑动起手卡顿的根因）',
     /if \(page_data\.pdf_render_css_width > 0 \|\| is_prerender\) return d;/.test(dp), true);
  eq('预渲染分支不经运动上限夹取（否则入视口即 force 升清，每页两次渲染）',
     /if \(is_prerender\) \{[\s\S]{0,600}?target_dpr: _pdf_cap_render_dpr\(/.test(dp), true);
  eq('运动上限仍作用于常规分支（快速翻页目标页低清起步）',
     /target_dpr: clamp_motion\(/.test(dp), true);

  // 运行时开关：用于 A/B 判定起手卡顿是否来自运动期降密度
  eq('暴露 __motionDprCap() 读运动期上限', /window\.__motionDprCap = \(\) => this\._DR_MOTION_DPR_MAX;/.test(dr), true);
  eq('暴露 __setMotionDprCap(v) 写运动期上限（0=关闭）',
     /window\.__setMotionDprCap = \(v\) => \{/.test(dr), true);
  eq('关闭运动期降密度时上限返回 Infinity', /: Infinity;/.test(cap), true);

  // 升清补扫：hold 到期后必须主动补扫，否则页面永久停在低密度档
  const arm = method('_dr_arm_motion_upgrade') || '';
  eq('_dr_arm_motion_upgrade 存在', arm.length > 0, true);
  eq('升清补扫必须按 hold 剩余时间定时（立即触发时 want 仍是低密度档，补扫无效）',
     /setTimeout\(\(\) => \{[\s\S]{0,400}\}, remain \+ 20\);/.test(arm), true);
  eq('升清补扫到期后真的补扫可见性',
     /this\._check_page_visibility\(\);/.test(arm), true);
  eq('补扫时若又在动则顺延（避免运动中升清）',
     /if \(this\._pdf_motion_dpr_active\(\)\) \{ this\._dr_arm_motion_upgrade\(\); return; \}/.test(arm), true);
  eq('手势恢复路径必须武装升清补扫',
     /_dr_arm_motion_upgrade\(\);/.test(method('_dr_on_render_resume') || ''), true);
  eq('连点路径必须武装升清补扫',
     /_dr_arm_motion_upgrade\(\);/.test(method('_dr_note_flip') || ''), true);

  // 滑动中卸载不得做 GPU→CPU 回读留档
  const rel = method('_release_pdf_page_render') || '';
  eq('_release_pdf_page_render 存在', rel.length > 0, true);
  eq('运动期跳过 createImageBitmap 留档（每页一次同步 GPU 回读）',
     /_bitmap_cache_peek\([\s\S]{0,120}!this\._pdf_motion_dpr_active\(\)\)/.test(rel), true);
  eq('close 必须清理升清补扫定时器',
     /_dr_motion_upgrade_timer != null\)[\s\S]{0,120}clearTimeout\(this\._dr_motion_upgrade_timer\)/.test(dr), true);

  // 运行时可调（真机定档）：缺了它就只能靠猜一个分辨率数字反复重新构建
  eq('暴露 __rasterCap() 读当前上限', /window\.__rasterCap = \(\) => this\._raster_max_dev_w;/.test(dr), true);
  eq('暴露 __setRasterCap(px) 写上限', /window\.__setRasterCap = \(px\) => \{/.test(dr), true);
  eq('__setRasterCap 校验下界（低于 1024 的位图承载不了正文）',
     /v < 1024[\s\S]{0,160}return this\._raster_max_dev_w;/.test(dr), true);
  eq('__setRasterCap 拒绝非有限值', /!Number\.isFinite\(v\)/.test(dr), true);
  eq('__setRasterCap 改后清位图缓存并补扫（否则参数守卫仍判达标、不重渲染）',
     /this\._bitmap_cache_clear\(\);[\s\S]{0,240}this\._check_page_visibility\(\);/.test(dr), true);
  eq('__setRasterCap 让可见页脱离运动期降密度（避免掩盖本次调参）',
     /__setRasterCap[\s\S]{0,600}this\._dr_motion_dpr_until = 0;/.test(dr), true);
  // 两条夹取通道都必须传**随缩放计算**的上限，否则放大清晰度余量对其中一条无效
  eq('两条非占位分支都传 scale 相关的 raster_limit',
     (dr.match(/raster_limit\)/g) || []).length >= 2, true);
  eq('raster_limit 由 _pdf_raster_limit(基准, scale, 余量) 算出',
     /const raster_limit = _pdf_raster_limit\(\s*this\._raster_max_dev_w, scale,\s*is_active_page \? this\._zoom_headroom : 1\)/.test(dr), true);
  // 放大余量只给活动页：核显共享内存下，全页全量放大 = 常驻纹理 ×4
  // （本机 Intel UHD：1920 窗口 2x 时 11×77MB=847MB → 只给活动页则 269MB）
  eq('放大余量只给活动页（共享内存下邻页不得跟着放大）',
     /is_active_page \? this\._zoom_headroom : 1/.test(dr), true);
  eq('暴露 __zoomHeadroom() / __setZoomHeadroom(n)（放大清晰度余量可运行时调）',
     /window\.__zoomHeadroom = \(\) => this\._zoom_headroom;/.test(dr) &&
     /window\.__setZoomHeadroom = \(n\) => \{/.test(dr), true);
  eq('__setZoomHeadroom 校验下界（<1 无意义）', /v < 1[\s\S]{0,160}return this\._zoom_headroom;/.test(dr), true);
  // 缩放中不得被运动期降密度压住（否则放大越清晰的目标被抵消）
  eq('缩放中豁免运动期降密度', /if \(this\._dr_is_zooming\) \{ this\._dr_motion_dpr_until = 0; return false; \}/.test(dr), true);
}

console.log('--- 不得存在常驻 rAF 循环（2026-10-02 trace 实证）---');
{
  // 实证：loaf-monitor 的帧间隔判别器原本是无条件自续的 rAF 循环。Chromium 每个
  // vsync 都会执行排队的 rAF 回调并产出一帧 → 应用永远无法空闲，GPU 进程持续
  // 合成。两份真机 trace 的 GpuVSyncThread 占用率 99.7% / 99.8%（满载一个核），
  // 文档静止时 Commit/Layerize/Paint 仍以 ~45 次/秒发生。它把 GPU 侧余量吃光，
  // 真实纹理工作只能排在永不停的帧流后，把卡顿放大。
  // 守卫：任何模块都不得有「函数体末尾无条件 requestAnimationFrame(自身)」
  // 或「IIFE 顶层裸调 requestAnimationFrame」的常驻循环。
  // 复用共享扫描器（见文件顶部）。此前此处另有一份 walk + strip，
  // 修 strip 时只改到另一份，两份实现就此漂移。
  const files = srcFiles;
  const src = srcBodies;
  const rel = relSrc;

  // 自续式 rAF 循环：函数体里 rAF 的参数是它自己。
  // 必须排除**有守卫**的合法形态（settings 的分帧动画、loaf-monitor 的开窗采样
  // 都是 `if (...) { rAF(自身) } else { 停 }`）。判据：rAF 调用之前紧邻的
  // 语句里没有 if/return 守卫 = 无界循环。
  const selfPerp = files.filter(f => {
    const t = src.get(f);
    return [...t.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*\{[\s\S]{0,4000}?requestAnimationFrame\(\s*\1\s*\)/g)]
      .some(m => {
        const upto = m[0];
        const at = upto.lastIndexOf('requestAnimationFrame');
        const before = upto.slice(Math.max(0, at - 300), at);
        return !/\bif\s*\(/.test(before) && !/\breturn\b/.test(before);
      });
  }).map(rel);
  eq('不存在无界的自续式 rAF 循环（requestAnimationFrame(自身) 且无 if/return 守卫）',
     selfPerp.join(','), '');
  // 守卫本身有效：确实存在带 if 守卫的自续形态（否则上面那条是空断言）
  const guardedPerp = files.filter(f => {
    const t = src.get(f);
    return [...t.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*\{[\s\S]{0,4000}?requestAnimationFrame\(\s*\1\s*\)/g)]
      .some(m => /\bif\s*\(/.test(m[0].slice(Math.max(0, m[0].lastIndexOf('requestAnimationFrame') - 300))));
  }).map(rel);
  eq('确实存在带 if 守卫的自续 rAF 形态（守卫本条有效，非空断言）',
     guardedPerp.length > 0, true);

  const loaf = files.find(f => rel(f) === 'modules/perf/loaf-monitor.js');
  const lt = loaf ? src.get(loaf) : '';
  eq('loaf-monitor 存在', lt.length > 0, true);
  // 顶层裸调一次 rAF 调度是合法的（如 rAF(() => {...})），不构成循环；
  // 自续循环必然自引用，已由上面那条覆盖。故这里只锁死采样器的发起点数量。
  eq('帧间隔采样器只有两个发起点（_raf_tick 续窗 + __raf_probe_start 开窗）',
     (lt.match(/requestAnimationFrame\(\s*_raf_tick\s*\)/g) || []).length, 2);
  eq('帧间隔判别器改为按需开窗（__raf_probe_start）',
     /window\.__raf_probe_start = function \(ms\)/.test(lt), true);
  eq('开窗采样必须自行停机（有窗口上限判断）',
     /if \(now < _raf_until\)[\s\S]{0,80}requestAnimationFrame\(_raf_tick\);[\s\S]{0,80}else \{[\s\S]{0,40}_raf_id = 0;/.test(lt), true);
  eq('提供手动停止入口', /window\.__raf_probe_stop = function/.test(lt), true);
  eq('长帧（LoAF）触发开窗采样',
     /window\.__raf_probe_start && window\.__raf_probe_start\(\)/.test(lt), true);
  eq('长任务（longtask）同样触发开窗采样',
     (lt.match(/__raf_probe_start && window\.__raf_probe_start\(\)/g) || []).length >= 2, true);

  // 必答诊断项不得挂在条件触发上（2026-10-02 教训）
  eq('GPU 探测可手动调用（__probeGpu）',
     /window\.__probeGpu = _probe_gpu;/.test(lt), true);
  eq('GPU 探测有幂等短路（重复调用不重建上下文）',
     /if \(window\.__gpu_info\) return window\.__gpu_info;/.test(lt), true);
  eq('GPU 探测后释放上下文（不为诊断长期占用 GPU 资源）',
     /WEBGL_lose_context[\s\S]{0,40}loseContext\(\)/.test(lt), true);
  eq('LoAF 可用性有留痕（区分"仪器故障"与"应用没卡"）',
     /window\.__loaf_active = true;/.test(lt) && /window\.__loaf_active = false;/.test(lt), true);
  const rdr = read2('modules/pdf/document_reader.js');
  eq('阅读器打开文档时无条件探测一次 GPU',
     /window\.__probeGpu && window\.__probeGpu\(\);/.test(rdr), true);
  // 懒触发（首条长帧时顺带探一次）可以保留 —— 探测已幂等 + 已有两条无条件路径，
  // 关键不变量是「不再只有懒触发这一条路」，由上面两条断言覆盖。
  eq('长帧里的懒触发探测被幂等保护（不会重建上下文）',
     /if \(!raw_dumped\)[\s\S]{0,200}_probe_gpu\(\);/.test(lt) &&
     /if \(window\.__gpu_info\) return window\.__gpu_info;/.test(lt), true);
}

console.log('--- 源码层不变式守卫 ---');
{
  const files = srcFiles;
  const bodies = srcBodies;
  const rel = relSrc;

  eq('裸读 devicePixelRatio 仅限控制器',
     scan(/devicePixelRatio/), 'modules/canvas/resolution-controller.js');
  eq('DRAW_CONFIG.dpr 只有控制器写入',
     scan(/(DRAW_CONFIG|cfg)\.dpr\s*=(?!=)/), 'modules/canvas/resolution-controller.js');
  eq('覆盖层变换字段只有 OverlayManager 写入',
     scan(/_transform(Scale|X|Y)\s*=(?!=)/), 'modules/canvas/overlay-manager.js');
  eq('已退役的覆盖层转发 API 无残留',
     scan(/sync_overlay_dpr_now|update_overlay_dpr|resize_overlay|destroy_overlay|hide_overlay|show_overlay|init_overlay|_calc_overlay_dpr|sync_all_overlay_dpr|_sync_overlay_transform|_overlayCachedRect|_overlay_cached_rect/), '');
  eq('分页覆盖层死字段无残留',
     scan(/page(_data)?\.overlay_canvas|page(_data)?\.overlay_ctx/), '');

  // ---- 按「笔画对象」缓存的渲染几何：原地改写必须显式作废 ----
  // 笔锋细分缓存（RealPenManager.cached_tessellated / PenTessellator._runsCache）
  // 与常量宽度 Path2D 缓存（stroke-renderer._strokePathCache）都以笔画对象标识
  // 作键，判据看不到对象内部的变化。一旦有人原地改写坐标（*= 缩放）而不作废，
  // 批注就会被画到改写前的位置，位移越出所属瓦片时整块瓦片空白。
  {
    const mainFile = files.find(f => rel(f) === 'main.js');
    const mutators = files.filter(f => /\.(fromX|toX|minX|maxX|minY|maxY)\s*\*=(?!=)/.test(bodies.get(f)));
    eq('仍存在原地缩放批注坐标的代码（守卫本身有效）', mutators.length > 0, true);
    eq('原地改写笔画几何的文件都必须调用统一作废入口',
       mutators.filter(f => !/main_invalidate_stroke_geometry_caches/.test(bodies.get(f))).map(rel).join(','),
       '');
    eq('统一作废入口同时清笔锋细分缓存与 Path2D 缓存',
       /main_invalidate_stroke_geometry_caches\s*\(\s*\)\s*\{[\s\S]{0,400}?realPenManager\.invalidate_cache\(\)[\s\S]{0,200}?invalidate_stroke_path_cache\(\)/
         .test(mainFile ? bodies.get(mainFile) : ''),
       true);
    eq('失效全局 window.realPenManager 无残留（应走统一入口）',
       scan(/window\.realPenManager/), '');
  }

  // ---- 审计修复（2026-09-19）防回归 ----
  {
    const apiFile = files.find(f => rel(f) === 'modules/telemetry/telemetry-api.js');
    const apiBody = apiFile ? bodies.get(apiFile) : '';
    // 2026-10-03：开关判据从 reportOnline 体内上移到 telemetry_post。
    // 真正的发包出口只有它一个，判据贴着发包动作才叫「出口自带开关」——
    // 原来 reportOnline 里有这层、reportVersion 没有，加接口时必漏。
    eq('遥测发包出口必须自带开关判断（telemetry_post 内查 telemetry_is_enabled）',
       /async function telemetry_post\([^)]*\)\s*\{[\s\S]{0,400}telemetry_is_enabled\(\)/.test(apiBody),
       true);
    // 判据上移了，就不能留任何绕过 telemetry_post 直接发包的旁路，否则等于白移。
    eq('telemetry_http_post 全文件只有一个调用点（开关判据无法被绕过）',
       (apiBody.match(/invoke\('telemetry_http_post'/g) || []).length,
       1);
    eq('oobe 不得直调 reportOnline（必须走 telemetryInit）',
       files.filter(f => rel(f) === 'oobe.js' && /reportOnline/.test(bodies.get(f))).map(rel).join(','),
       '');
    // ---- 分发接口接入（2026-10-03）防回归 ----
    // 更新数据源已从「客户端直连 GitHub API」切到 SECTL 分发接口。这几条守的是
    // 那个切换的结构性约束，都是「不写对也不会报错、只会静默给出错误更新」的坑。
    const updResolve = files.find(f => rel(f) === 'modules/update/update-resolve.js');
    const updApi = files.find(f => rel(f) === 'modules/update/update.js');
    const resBody = updResolve ? bodies.get(updResolve) : '';
    const apiBody2 = updApi ? bodies.get(updApi) : '';
    // 下面两条扫的是 URL 字面量 → 用 scan（strip 已能正确处理 `https://` 里的双斜杠）
    eq('客户端不得直连 api.github.com（文档要求走服务端代查）',
       scan(/api\.github\.com/) === '' ? '' : scan(/api\.github\.com/),
       '');
    // ---- SECTL 身份（2026-10-03）防回归 ----
    // 全应用只允许有一处定义 Client ID。此前平台 ID 住在 telemetry-config.js、
    // Client ID 住在 update-resolve.js，两边各自以为对，/api/stats/online 一直回
    // 400 invalid_client；而 /api/stats/version 两种 ID 都收，一路绿灯把故障掩盖了。
    eq('SECTL Client ID 全应用只有一处定义',
       scan(/6a48ced10013cdd594f8/).replace(/^modules\//, ''), 'sectl-client.js');
    eq('服务端规范的平台 ID 不得作为可发送值出现在 JS 里',
       scan(/['"`]platform_9c8003bb30f77c70['"`]/), '');
    eq('SECTL API base 只有一处定义',
       scan(/https:\/\/appwrite\.sectl\.cn/), 'modules/sectl-client.js');
    // 换 IP 归属地供应商时两处必须同步：JS 里的 URL + Rust 白名单。
    // ⚠️ 必须加 `\b`：`freeipapi.com` 里含有子串 `ipapi.co`（ipapi + .co 是 .com 的前缀），
    // 不加边界会把新供应商自己判成"还没迁走"。
    eq('地理查询供应商已从 ipapi.co 迁走（它对所有客户端返 403 挑战页）',
       scan(/\bipapi\.co\b/), '');
    eq('freeipapi 已登记进 Rust 遥测白名单',
       /TELEMETRY_ALLOWED_HOSTS[\s\S]{0,120}freeipapi\.com/.test(fs.readFileSync(path.join(APP, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8')),
       true);
    // 选包必须按 os/arch 打分，不能退化成「按数组顺序取第一个匹配扩展名的」
    eq('选包按 os/arch 打分（不得只按扩展名挑）',
       /if\s*\(want_os\s*&&\s*p_os\)[\s\S]{0,120}score\s*[+-]=/.test(resBody)
       && /if\s*\(want_arch\s*&&\s*p_arch\)[\s\S]{0,120}score\s*[+-]=/.test(resBody),
       true);
    eq('$id 必须在选包出口归一成 package_id（否则镜像候选静默消失）',
       /package_id:\s*best\.package_id\s*\?\?\s*best\.\$id/.test(resBody), true);
    eq('版本比较不得退回「解析失败即视为无更新」的静默路径',
       /if\s*\(!va\s*\|\|\s*!vb\)\s*return\s*0/.test(resBody), true);
    // 必须用 rawBodies：strip 会把 URL 从双斜杠处截断，这条守卫一度对新增端点失明。
    // 不要求路径前紧邻引号：download 那条是模板字符串，路径前面是 ` ` 字符。
    eq('接口路径字面量只在 update 模块内（新增端点须同步 resolve/api）',
       scan(/\/api\/software\//),
       'modules/update/update-resolve.js,modules/update/update.js');
    eq('update.js 不再自行比较版本（单一事实来源在 update-resolve.js）',
       /compare_versions|is_newer|parse_version/.test(apiBody2), false);
    const mdFile = files.find(f => rel(f) === 'modules/renderMarkdown.js');
    eq('markdown 链接必须过协议白名单（safeHref）',
       /safeHref[\s\S]{0,300}'https:'/.test(mdFile ? bodies.get(mdFile) : ''),
       true);
    const tessFile = files.find(f => rel(f) === 'modules/canvas/pen_tessellator.js');
    eq('笔锋缓存配额满必须作废重来（不许永久拒收新笔画）',
       /if\s*\(this\._cachedRunCount\s*\+\s*runs\.length\s*>\s*this\._MAX_CACHED_RUNS\)\s*\{\s*this\.reset_runs_cache\(\)/
         .test(tessFile ? bodies.get(tessFile) : ''),
       true);
    const mainFile2 = files.find(f => rel(f) === 'main.js');
    eq('主画布必须有 redo 入口与全局快捷键接线',
       [/async function main_handle_redo/.test(mainFile2 ? bodies.get(mainFile2) : ''),
        /main_setup_undo_keyboard/.test(mainFile2 ? bodies.get(mainFile2) : '')].every(Boolean),
       true);
    eq('死句柄 window.__documentReaderManager 无残留',
       scan(/__documentReaderManager/), '');
    eq('死字段 _visible_init_timeout 无残留',
       scan(/_visible_init_timeout/), '');
    eq('palm-eraser 死模块已删除',
       files.filter(f => /palm[-_]eraser/i.test(f)).map(rel).join(','),
       '');
  }

  // ---- 渲染性能档位（settings.renderPerfTier）----
  // 档位是这个项目里最容易「加了字段但没接上」的机制：13 个成本参数散在构造函数
  // 各处，逐处加一处漏一处，就是静默的无效开关（frameRateMode 的前车之鉴）。
  // 下面这几条把「表 ↔ 应用点 ↔ 配置 ↔ 落盘 ↔ UI」串成闭环，任一环断掉都会红。
  {
    const reader = bodies.get(files.find(f => rel(f) === 'modules/pdf/document_reader.js'));
    const tierTable = /const RENDER_PERF_TIERS\s*=\s*\{([\s\S]*?)\n\};/.exec(reader || '');
    ok('RENDER_PERF_TIERS 表存在（渲染档位的唯一参数来源）', !!tierTable);

    const parseTiers = (src) => {
      // 逐档抠出键值对：档位名 → { 参数名: 数值 }
      // 值允许 `32 * 1024 * 1024` 这种算术式（比 33554432 可读得多），
      // 但先卡字符集再求值，不把源码里任意文本丢进 Function。
      const out = {};
      const re = /^\s{4}(low|balanced|high)\s*:\s*\{([\s\S]*?)^\s{4}\},?\s*$/gm;
      let m;
      while ((m = re.exec(src))) {
        const params = {};
        for (const pm of m[2].matchAll(/^\s*([a-z_0-9]+)\s*:\s*([0-9*+\s.]+?),?\s*(?:\/\/.*)?$/gm)) {
          const expr = pm[2].trim();
          if (!/^[0-9*+\s.-]+$/.test(expr)) continue;
          params[pm[1]] = Function('"use strict";return (' + expr + ')')();
        }
        out[m[1]] = params;
      }
      return out;
    };
    const tiers = parseTiers(tierTable ? tierTable[1] : '');
    eq('三档齐全', Object.keys(tiers).sort().join(','), 'balanced,high,low');

    const names = Object.keys(tiers.low || {});
    ok('档位参数集非空', names.length > 0);
    for (const t of ['balanced', 'high']) {
      eq(t + ' 档参数集与 low 完全一致（漏字段=静默继承构造函数默认值）',
         Object.keys(tiers[t]).sort().join(','), names.slice().sort().join(','));
    }

    // 表里的每个参数都必须在 apply_perf_tier 里被消费（出现在某个赋值的右侧），
    // 否则该参数就是装饰品 —— 改了档位却没有任何效果，而且完全静默。
    // 只看右侧而不要求左右同名：实例字段名早于档位机制存在且不再改名
    // （_RENDER_MAX ← render_max、_bitmap_cache_max_bytes ← bitmap_cache_bytes 等），
    // 名字不齐是有意的历史包袱，改名会牵扯几十处读取点。
    const applyBody = /apply_perf_tier\s*\(\s*tier\s*\)\s*\{([\s\S]*?)\n    \}/.exec(reader || '');
    ok('apply_perf_tier 存在（档位的唯一运行时落点）', !!applyBody);
    const body = applyBody ? applyBody[1] : '';
    eq('档位表里没有任何参数被 apply_perf_tier 漏掉',
       names.filter(k => !new RegExp('=\\s*p\\.' + k + '\\b').test(body)).join(','),
       '');

    // 单调性：成本型参数必须 low ≤ balanced ≤ high。
    // 一次手误（例如 low 写成 wrapper_keep_distance: 20）就会让低配档比均衡档
    // 更费内存，比运行时更早暴露、更难在真机上察觉 —— 用源码断言挡住。
    const COST = {
      raster_max_dev_w: 1, zoom_headroom: 1, bitmap_cache_bytes: 1,
      bitmap_cache_entries: 1, wrapper_keep_distance: 1, image_keep_distance: 1,
      blob_keep_distance: 1, prerender_distance: 1, prerender_urgent_span: 1,
      sidebar_thumbnail_cache_max: 1,
    };
    const inversions = [];
    for (const [k] of Object.entries(COST)) {
      if (!(k in (tiers.low || {}))) { inversions.push(k + '(缺)'); continue; }
      if (!(tiers.low[k] <= tiers.balanced[k])) inversions.push('low>' + k);
      if (!(tiers.balanced[k] <= tiers.high[k])) inversions.push('balanced>' + k);
    }
    eq('成本参数保持 low ≤ balanced ≤ high（防手误把低配档配得更费内存）', inversions.join(','), '');

    // 并发类参数是「降配」而非「单调成本」，单独断言方向
    for (const k of ['render_max', 'canvas_pool_max']) {
      ok(k + ' 在三档都有值', [tiers.low, tiers.balanced, tiers.high].every(t => typeof t[k] === 'number'));
      ok(k + ' 低配档不放宽（low ≤ balanced ≤ high）',
         tiers.low[k] <= tiers.balanced[k] && tiers.balanced[k] <= tiers.high[k]);
    }
    ok('motion_dpr_max 低配档不放宽（低配档运动期应更省）',
       tiers.low.motion_dpr_max <= tiers.balanced.motion_dpr_max);

// 运行时落点唯一：只有 init（启动回放）和 main（设置变更）该调 apply_perf_tier。
  // 设置面板若也调，每次改档都会执行两遍「清位图缓存 + 按新窗口回收 + 可见页重渲染」，
  // 白烧一轮内存与 GPU。
  // 匹配的是**调用**：允许 `apply_perf_tier?.(`（可选调用），且排除定义处
  // `apply_perf_tier(tier) {`。不限制实参名 —— 否则设置面板传 `tier` 就绕过了。
  eq('apply_perf_tier 只被 init.js 与 main.js 调用',
     scan(/apply_perf_tier\??\.\s*\((?!\s*tier\s*\)\s*\{)/),
     'init.js,main.js');

    // 配置默认值必须在 Rust defaults 里，config_validate_and_merge 才会做类型校验
    // （未知键会被原样保留、不校验），否则拼错的值能一路存进 config.json
    const libRs = fs.readFileSync(path.join(APP, '../src-tauri/src/lib.rs'), 'utf8');
    eq('Rust 默认配置含 renderPerfTier',
       /"renderPerfTier"\s*:\s*"(low|balanced|high)"/.test(libRs), true);

    // OOBE 自动检测不得覆盖用户选择 / 导入的旧配置
    const oobe = bodies.get(files.find(f => rel(f) === 'oobe.js')) || '';
    ok('OOBE 探测硬件后回填档位', /_probeDevice\(\)/.test(oobe) && /_autoPerfTier\(/.test(oobe));
    ok('OOBE 用户点过档位后不被探测结果覆盖',
       /if\s*\(\s*_tierPickedByUser\s*\)\s*return/.test(oobe));
    // 导入分支必须「白名单校验 + 置锁」成对出现。只查 settings.renderPerfTier 是否
    // 出现过是不够的：把白名单去掉、只留 `state.renderPerfTier = settings.renderPerfTier`
    // 也能通过那条检查，而那正是非法档位被原样带进来的路径。
    ok('OOBE 导入旧配置时沿用其 renderPerfTier（白名单校验与置锁必须成对）',
       /\['low',\s*'balanced',\s*'high'\]\s*\.includes\(settings\.renderPerfTier\)[\s\S]{0,300}?_tierPickedByUser\s*=\s*true/.test(oobe));
    // 取值白名单必须落在 mergeSettings（组装最终 settings 的唯一出口），
  // 而不是 performFinalSave —— 后者是消费方，往那儿塞校验等于让「组装」和「保存」
  // 各写一遍取值域，改一处忘一处就会存进非法值。
  ok('OOBE 组装最终设置时对档位取值做白名单校验',
     /renderPerfTier\s*:\s*\['low',\s*'balanced',\s*'high'\]\s*\.includes\(state\.renderPerfTier\)/.test(oobe));

    // 九个 locale 必须都带齐文案，缺一个就在该语言下显示裸 key
    // 档位说明是随档位变的动态文案（JS 单一写者），所以只有 7 个静态键；
// 另加一条守卫：markup 不得给 #renderPerfTierHint 加 data-i18n，
// 否则 render_page_texts 会用一档静态文案盖掉动态文案，切语言也不跟着刷新。
const TIER_KEYS = ['renderPerfTier', 'renderPerfTierLow', 'renderPerfTierBalanced',
      'renderPerfTierHigh', 'renderPerfTierHintLow',
      'renderPerfTierHintBalanced', 'renderPerfTierHintHigh'];
    // OOBE 侧原本还有 5 个 perfTierDetecting / perfTierReason_* 键，用来渲染档位
    // 按钮下方那行「已检测到…已自动选择…」的说明。该元素已从 oobe.js 移除、键随之
    // 删除，所以这里**刻意留空**：一条断言死键存在的守卫永远为真，比没有守卫更糟 ——
    // 它让人以为这一段仍被守着。OOBE 步骤标题/描述的键由 oobe-titlebar 那套守卫覆盖。
    const OOBE_KEYS = [];
    const OOBE_DEAD_KEYS = ['perfTierDetecting', 'perfTierReason_low', 'perfTierReason_balanced',
      'perfTierReason_high', 'perfTierReasonFallback'];
    const locDir = path.join(APP, 'locales');
    const locFiles = fs.readdirSync(locDir).filter(f => f.endsWith('.json'));
    const locBad = [];
    const oobeDead = [];
    for (const f of locFiles) {
      const j = JSON.parse(fs.readFileSync(path.join(locDir, f), 'utf8'));
      const s = j.settings || {}, o = j.oobe || {};
      const missing = [...TIER_KEYS.filter(k => !(k in s)), ...OOBE_KEYS.filter(k => !(k in o))];
      if (missing.length) locBad.push(f + ':' + missing.join('+'));
      // 反向守卫：死键必须**不在**语言包里。留着就是 5 × 9 份永不显示的文案，
      // 而某天有人「顺手」给 oobe.js 加回同名引用时，也不会有人发现键曾被删过。
      const leftover = OOBE_DEAD_KEYS.filter(k => k in o);
      if (leftover.length) oobeDead.push(f + ':' + leftover.join('+'));
    }
    eq('全部 ' + locFiles.length + ' 个语言包都带齐档位文案', locBad.join(','), '');
    eq('OOBE 档位说明的死键已从语言包清干净', oobeDead.join(','), '');
    ok('语言包数量与预期一致（新增语言需一并补文案）', locFiles.length >= 9);

    // 档位说明只能有一个写者：markup 里不能出现 data-i18n="settings.renderPerfTierHint"
    const panel = bodies.get(files.find(f => rel(f) === 'modules/settings/settings-panel.js')) || '';
    ok('档位说明不由 data-i18n 静态填充（须与档位联动的动态文案）',
       !/id="renderPerfTierHint"[^>]*data-i18n/.test(panel));
    const setjs = bodies.get(files.find(f => rel(f) === 'modules/settings/settings.js')) || '';
    ok('档位说明有单一写者且切语言后会被重刷',
       /window\.settings_refresh_perf_tier_hint\s*=/.test(setjs) &&
       /settings_refresh_perf_tier_hint\?\.\(\)/.test(setjs));

  // ---- 惯性/捏合高频路径：移动边界几何的失效接线 ----
  // reader-momentum.mjs 只证明「消费端认脏标记」，证明不了「生产端会置脏」。
  // 少了任一条置脏，几何会用陈旧值钳制运动（贴边钳错、或窗口变化后滑不远），
  // 而单元测试照样全绿 —— 所以这里从源码层锁住两条失效源。
  const readerAll = bodies.get(files.find(f => rel(f) === 'modules/pdf/document_reader.js')) || '';
  ok('移动边界几何改用脏标记失效（不再依赖 16ms TTL 节流）',
     /!this\._dr_mb_dom_cache \|\| this\._dr_mb_dom_dirty/.test(readerAll));
  ok('布局重算会置脏移动边界几何',
     /_invalidate_page_positions\(\)\s*\{[\s\S]{0,200}?_dr_mb_dom_dirty\s*=\s*true/.test(readerAll));
  // 必须限定在 _on_reader_geometry_changed 的函数体内：全文件扫
  // 「stale=true 后 160 字符内有 dirty=true」会命中 open() 里那处（也置脏），
  // 于是把 resize 通道的置脏删掉照样通过 —— 守卫必须盯住它自己那一处。
  const geomFn = /_on_reader_geometry_changed\(\)\s*\{([\s\S]*?)\n    \}/.exec(readerAll);
  ok('reader resize 几何变更通道会置脏移动边界几何',
     !!geomFn && /_dr_mb_dom_dirty\s*=\s*true/.test(geomFn[1]));
  // 惯性 tick 不得重算边界：`_dr_update_canvas_position` 只钳制、不重算，
  // 几何留给 inputUp / _dr_apply_scale。加进 tick 等于把高频 DOM 读带回来。
  ok('惯性逐帧只钳制位置、不重算边界',
     !/_dr_momentum_tick[\s\S]{0,900}?_dr_update_move_bound/.test(readerAll));
  // 惯性期必须限频刷可见性，且必须先停预渲染泵
  ok('惯性期按固定间隔刷新可见性（不留空白，且不全量扫描）',
     /if \(now - this\._dr_momentum_vis_t >= \d+\)/.test(readerAll));
  }
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
