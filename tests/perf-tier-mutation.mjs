// 变异测试：逐个破坏新增的档位守卫，确认每条真的会变红。
// 每次改动前把原文存内存，测完原样写回 —— 不碰 git（这些文件尚未提交，
// git checkout 会把整轮改动一起丢掉）。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/dpr-harness.mjs';
const ALSO = ['tests/perf-tier-apply.mjs', 'tests/perf-tier-scoring.mjs',
  'tests/reader-momentum.mjs', 'tests/reader-rotation.mjs',
  'tests/reader-confirm.mjs'];
const F = {
  reader: 'src/modules/pdf/document_reader.js',
  init: 'src/init.js',
  settings: 'src/modules/settings/settings.js',
  oobe: 'src/oobe.js',
  rs: 'src-tauri/src/lib.rs',
  locale: 'src/locales/ja-JP.json',
  worker: 'src/modules/pdf/render-worker.js',
  host: 'src/modules/pdf/render-worker-host.js',
};
const orig = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, fs.readFileSync(p, 'utf8')]));
// 注意：orig 的 value 是**文件内容**，路径要从 F 取。
// （别把内容当路径传给 writeFileSync —— 会 ENAMETOOLONG。）
const restore = () => Object.keys(orig).forEach((k) => fs.writeFileSync(F[k], orig[k], 'utf8'));

// run() 既要认「打印了 FAIL」也要认「直接崩了」。
// 只看 FAIL 行会漏判：把 const name 换成 String(tier).toLowerCase() 后，
// 非法档位会走到 T['ultra'].raster_max_dev_w 抛 TypeError，脚本带着栈退出，
// 一行 FAIL 都没有 —— 但那恰恰是被抓住的表现，不是「没反应」。
const run = () => {
  let out = '';
  const crashed = [];
  for (const script of [HARNESS, ...ALSO]) {
    let code = 0, buf = '';
    try {
      buf = execFileSync('node', [script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
    } catch (e) {
      buf = String(e.stdout || '') + String(e.stderr || '');
      code = typeof e.status === 'number' ? e.status : 1;
    }
    out += buf;
    // 退出码非零但打印了 FAIL 行 → 那是「断言失败」，属正常报告；
    // 退出码非零且一行 FAIL 都没有 → 脚本自己炸了，同样算被抓住。
    if (code !== 0 && !buf.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).some((l) => l.startsWith('FAIL'))) {
      crashed.push(script.split('/').pop());
    }
  }
  out = out.replace(/\x1b\[[0-9;]*m/g, '');
  const failed = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL')).map((l) => l.trim());
  return { failed, crashed, out };
};

const MUTATIONS = [
  ['low 档漏一个参数（只剩 12 个键）',
    F.reader,
    (t) => rep(t, '        canvas_pool_max: 1,\n', ''),
    /参数集与 low 完全一致|漏掉/],
  // 原本这条变异打的是 wrapper_keep_distance（3 → 20），而 wrapper_keep_distance
  // 已改为三档统一 50、不再分档，锚点随之消失 —— 变异自己失效会报 [SKIP]，
  // 留着等于假装还在守。换成仍然分档的 image_keep_distance，保持同一类断言
  // （low 档成本参数不得比均衡档大）。
  ['low 档把图片常驻窗口配得比均衡档还大（8 → 20）',
    F.reader,
    (t) => t.replace('image_keep_distance: 8,', 'image_keep_distance: 20,'),
    /成本参数保持 low/],
  ['low 档把渲染并发配得比均衡档还高（1 → 4）',
    F.reader,
    (t) => t.replace('render_max: 1,', 'render_max: 4,'),
    /render_max 低配档不放宽/],
  ['low 档运动期降密度反而更宽松（0.5 → 0.9）',
    F.reader,
    (t) => t.replace('motion_dpr_max: 0.5,', 'motion_dpr_max: 0.9,'),
    /motion_dpr_max 低配档不放宽/],
  ['档位表加一个没人消费的新参数',
    F.reader,
    (t) => rep(t, '        render_max: 1,', '        render_max: 1,\n        never_used_param: 7,'),
    /漏掉/],
  ['high 档漏一个参数',
    F.reader,
    (t) => rep(t, '        canvas_pool_max: 3,\n', ''),
    /参数集与 low 完全一致|漏掉/],
  ['init.js 不再回放档位（启动丢失配置）',
    F.init,
    (t) => t.replace(/window\.documentReaderManager\?\.\s*apply_perf_tier\?\.\([\s\S]{0,120}?\);/, '/* 去掉启动回放 */'),
    /只被 init\.js 与 main\.js 调用/],
  ['设置面板里也直接调 apply_perf_tier（改档会执行两遍）',
    F.settings,
    (t) => t.replace('await settings_save_all_local({ renderPerfTier: tier });',
      'await settings_save_all_local({ renderPerfTier: tier });\n                window.documentReaderManager?.apply_perf_tier?.(tier);'),
    /只被 init\.js 与 main\.js 调用/],
  ['OOBE 自动探测覆盖用户手选',
    F.oobe,
    (t) => t.replace('if (_tierPickedByUser) return;', 'if (false) return;'),
    /用户点过档位后不被探测结果覆盖/],
  ['OOBE 丢掉导入配置里的档位',
    F.oobe,
    (t) => t.replace('if ([\'low\', \'balanced\', \'high\'].includes(settings.renderPerfTier)) {', 'if (false) {'),
    /沿用其 renderPerfTier/],
['OOBE 组装最终设置时不做白名单校验（非法档位可被落盘）',
    F.oobe,
    (t) => rep(t, "renderPerfTier: ['low', 'balanced', 'high'].includes(state.renderPerfTier)\n      ? state.renderPerfTier : 'balanced',", 'renderPerfTier: state.renderPerfTier,'),
    /白名单校验/],
  ['Rust 默认配置里去掉 renderPerfTier',
    F.rs,
    (t) => t.replace(/"renderPerfTier": "balanced"/, '"someOtherKey": "balanced"'),
    /Rust 默认配置含 renderPerfTier/],
  ['某个语言包漏一个档位文案',
    F.locale,
    (t) => t.replace(/\n\s*"renderPerfTierHintBalanced":\s*"[^"]*",/, ''),
    /语言包都带齐档位文案/],

  // ---- 以下针对行为测试（perf-tier-apply.mjs）：守卫看不见「赋值写错字段」 ----
  ['apply_perf_tier 把位图缓存条目数写到了错误的字段',
    F.reader,
    (t) => rep(t, 'this._bitmap_cache_max_entries = p.bitmap_cache_entries * mul;',
      'this._bitmap_cache_max_entries = p.blob_keep_distance * mul;'),
    /落到实例字段/],
  ['apply_perf_tier 不清位图缓存（降档后旧纹理仍常驻）',
    F.reader,
    (t) => rep(t, 'this._bitmap_cache_clear();\n        if (this._canvas_pool', 'if (this._canvas_pool'),
    /阅读器关闭时不触发可见性重扫|阅读器打开时按新 keep 窗口/],
  ['apply_perf_tier 不裁剪超编的 canvas 池',
    F.reader,
    (t) => rep(t, 'if (this._canvas_pool.length > p.canvas_pool_max) {\n            this._canvas_pool.length = p.canvas_pool_max;\n        }', ''),
    /canvas 池被裁到 low 档上限/],
  ['apply_perf_tier 不解除渲染线程手势限流',
    F.reader,
    (t) => rep(t, 'if (this._render_host) this._render_host.set_throttled?.(false);', ''),
    /解除渲染线程手势限流/],
  ['apply_perf_tier 忘记清零运动期降密度窗口',
    F.reader,
    (t) => rep(t, 'this._dr_motion_dpr_until = 0;\n            this._dr_arm_motion_upgrade();', 'this._dr_arm_motion_upgrade();'),
    /运动期降密度窗口被清零/],
  ['apply_perf_tier 关闭文档时也做可见性重扫（无谓的全局开销）',
    F.reader,
    (t) => rep(t, 'if (this.is_open) {\n            this._cleanup_hidden_page_gpu();', 'if (true) {\n            this._cleanup_hidden_page_gpu();'),
    /阅读器关闭时不触发可见性重扫/],
  ['apply_perf_tier 接受非法档位而不回退（LOW 会被当成 low 生效）',
    F.reader,
    (t) => rep(t, "const name = RENDER_PERF_TIER_NAMES.includes(tier) ? tier : 'balanced';", 'const name = String(tier).toLowerCase();'),
    // 这个变异的表现是**脚本崩**（T['ultra'] 为 undefined → TypeError），
    // 而不是打印 FAIL 行，所以期望值必须同时认这两种形态。
    /非法档位|TypeError/,],

  // ---- 以下针对打分测试（perf-tier-scoring.mjs）----
  // 期望值写具体机器名而不是 /passed/：断言是拿整份输出匹配的，
  // 用 /passed/ 会连「全绿」的汇总行一起命中，等于没有断言。
  ['打分把 6 核/16GB 核显机误判为 low（过度反应）',
    F.oobe,
    (t) => t.replace('  if (hasDedicated) score += 1;', '  if (hasDedicated) score += 1;\n  else if (gpu) score -= 1;'),
    /本机：Intel UHD 核显|8 代 i5 \/ 16GB/],
  ['打分把「字段缺失」当成「内存极小」（WMI 漏字段即误判 low）',
    F.oobe,
    (t) => rep(t, '  if (ramMb > 0) {\n    if (ramMb >= 24576) score += 2;', '  {\n    if (ramMb >= 24576) score += 2;'),
    /字段全缺/],
  ['打分不要求独显也敢发 high 许可证',
    F.oobe,
    (t) => rep(t, "if (score >= 2 && hasDedicated) return 'high';", "if (score >= 2) return 'high';"),
    /无独显不能白送 high/],
  ['打分不再把 5 代机判 low（用户点名要支持的机器）',
    F.oobe,
    (t) => rep(t, 'if (score <= -1) return \'low\';', ''),
    /5 代 i5/],

  // ---- 以下针对惯性滑行（reader-momentum.mjs）----
  ['惯性期几何缓存退回 16ms TTL（每次调用都读 DOM，等于没优化）',
    F.reader,
    (t) => rep(t, 'if (!this._dr_mb_dom_cache || this._dr_mb_dom_dirty ||\r\n            now - this._dr_mb_dom_time > 500) {', 'if (!this._dr_mb_dom_cache || now - this._dr_mb_dom_time > 16) {'),
    /不随回调数线性增长|远少于|脏标记失效/],
  ['几何缓存不再认脏标记（resize 后用陈旧几何钳制）',
    F.reader,
    (t) => rep(t, 'if (!this._dr_mb_dom_cache || this._dr_mb_dom_dirty ||\r\n            now - this._dr_mb_dom_time > 500) {', 'if (!this._dr_mb_dom_cache ||\r\n            now - this._dr_mb_dom_time > 500) {'),
    /脏标记失效|布局重算会置脏/],
  ['布局重算不再置脏移动边界几何（陈旧几何钳制）',
    F.reader,
    (t) => rep(t, '        this._page_positions.stale = true;\n        // 内容总高是移动边界几何的输入之一，布局重算后必须同步失效（见 _dr_update_move_bound）\n        this._dr_mb_dom_dirty = true;',
      '        this._page_positions.stale = true;'),
    /布局重算会置脏移动边界几何|布局重算/],
  ['resize 轻量通道不再置脏移动边界几何',
    F.reader,
    (t) => rep(t, '                this._dr_mb_dom_dirty = true;\n                // impulse：resize', '                // impulse：resize'),
    /reader resize 几何变更通道会置脏|容器尺寸变化/],
  ['惯性 tick 里被「顺手」加回边界重算（把高频 DOM 读带回来）',
    F.reader,
    (t) => rep(t, '        this._dr_update_canvas_position();\n\n        // 边界碰撞处理', '        this._dr_update_canvas_position();\n        this._dr_update_move_bound();\n\n        // 边界碰撞处理'),
    /惯性逐帧只钳制位置|不重算边界/],
  ['惯性开始不停预渲染泵（滑行期间抢渲染线程带宽）',
    F.reader,
    (t) => rep(t, '        this._dr_stop_prerender_pump();\n        this._dr_momentum_last_ts = null;', '        this._dr_momentum_last_ts = null;'),
    /停止预渲染泵/],
  ['惯性期不刷新可见性（滑入的页留空白，收尾再一次性补挂）',
    F.reader,
    (t) => rep(t, '            if (now - this._dr_momentum_vis_t >= 33) {\n                this._dr_momentum_vis_t = now;\n                this._check_page_visibility();\n            }', ''),
    /不留空白/],
  ['惯性期可见性刷新不限频（每帧全量扫描）',
    F.reader,
    (t) => rep(t, '            if (now - this._dr_momentum_vis_t >= 33) {', '            if (true) {'),
    /约每 2 帧一次，而非每帧/],
  ['收尾时重复全量扫一轮可见性',
    F.reader,
    (t) => rep(t, '                if (this._dr_is_zooming) this._check_page_visibility();', '                this._check_page_visibility();'),
    /不额外再扫一轮可见性/],
  ['停泵被挪到「松手前已停顿」判定之前（误停预渲染泵）',
    F.reader,
    (t) => rep(t, '    _dr_start_momentum() {\n        if (window.DRAW_CONFIG && !window.DRAW_CONFIG.momentumEnabled) return;',
      '    _dr_start_momentum() {\n        this._dr_stop_prerender_pump();\n        if (window.DRAW_CONFIG && !window.DRAW_CONFIG.momentumEnabled) return;'),
    /不误停预渲染泵/],
  ['边界钳制语义被改坏（缓存改动顺带改了算法）',
    F.reader,
    (t) => rep(t, '            mb.min_y = -(bounded_h - viewport_h);', '            mb.min_y = -(bounded_h - viewport_h) * 1.05;'),
    /边界|钳回/],

  // ---- 以下针对页面旋转（reader-rotation.mjs）----
  ['worker 的 getViewport 漏传 rotation（与主线程渲染出不同朝向）',
    F.worker,
    (t) => rep(t, 'const base = page.getViewport({ scale: 1, rotation: rot });', 'const base = page.getViewport({ scale: 1 });'),
    /旋转后的 base 推 css_scale|worker 内 getViewport 带 rotation/],
  ['worker 用未旋转的 base 宽度推 css_scale（旋转后页面被拉伸）',
    F.worker,
    (t) => rep(t, 'const viewport = page.getViewport({ scale: css_scale * dpr, rotation: rot });', 'const viewport = page.getViewport({ scale: css_scale * dpr });'),
    /worker 内 getViewport 带 rotation/],
  ['host 不再把 rotation 透传给 worker（旋转整个失效）',
    F.host,
    (t) => rep(t, '                    dpr: item.dpr,\n                    rotation: item.rotation', '                    dpr: item.dpr'),
    /透传给 worker 消息|签名新增 rotation/],
  ['主线程渲染路径漏传 rotation（与 worker 口径不一致）',
    F.reader,
    (t) => rep(t, 'const render_viewport = pdf_page.getViewport({ scale: css_scale * render_dpr, rotation: rot });', 'const render_viewport = pdf_page.getViewport({ scale: css_scale * render_dpr });'),
    /无「漏传 rotation」|三个 viewport 都带 rotation/],
  ['缩略图渲染不跟随旋转（列表与正文朝向不一致）',
    F.reader,
    (t) => rep(t, 'const res = await worker_host.render(page.page_num, css_w, 1, true, this._page_rotation);', 'const res = await worker_host.render(page.page_num, css_w, 1, true);'),
    /共 2 处|缩略图回退路径/],
  ['旋转后不作废渲染守卫（fit-width 下 css_w/dpr 不变 → 页面停在旧朝向）',
    F.reader,
    (t) => rep(t, '            pd.pdf_render_css_width = null;\n            pd.pdf_render_dpr = null;', ''),
    /作废渲染守卫/],
  ['旋转不清位图缓存（按 cache key 直接回贴旧朝向位图）',
    F.reader,
    (t) => rep(t, '        // 位图缓存里全是旧朝向的位图；留着会按 cache key 直接回贴。\n        this._bitmap_cache_clear();', ''),
    /清位图缓存/],
  ['旋转不清空批注（笔迹会按未旋转坐标系错位）',
    F.reader,
    (t) => rep(t, '            pd.stroke_history = [];', ''),
    /清空每页 stroke_history/],
  ['旋转后不立即落盘（下次打开旧笔迹会回来）',
    F.reader,
    (t) => rep(t, "        this._save_annotations_to_cache({ awaitIdle: false });\n        this._update_sidebar_rotation_ui();", '        this._update_sidebar_rotation_ui();'),
    /立即落盘/],
  ['比例翻转判定失效（90° 后页盒仍是竖向比例）',
    F.reader,
    (t) => rep(t, 'const swaps = (prev % 180 !== 0) !== (next % 180 !== 0);', 'const swaps = false;'),
    /swaps 奇偶判定/],
  ['旋转不随 tab view 存取（多标签切换串味）',
    F.reader,
    (t) => rep(t, '            pageRotation: this._page_rotation,\n', ''),
    /tab view 捕获旋转/],
  ['旋转不持久化（重开文档回到 0°）',
    F.reader,
    (t) => rep(t, '            page_rotation: include_viewport ? this._page_rotation : 0,\n', ''),
    /缓存写入 page_rotation/],
  ['open 时旋转晚于首屏渲染落位（先按 0° 栅格化一批再作废）',
    F.reader,
    (t) => rep(t, '        this._page_rotation = (((saved_state?.page_rotation | 0) % 360) + 360) % 360;\n', ''),
    /任何首屏渲染前落位旋转/],
  ['头部仍用 textContent（会连带抹掉旋转按钮）',
    F.reader,
    (t) => rep(t, "        header_title.textContent = `页面 (${current_index + 1}/${pages.length})`;", "        header.textContent = `页面 (${current_index + 1}/${pages.length})`;"),
    /保留标题节点/],
  ['侧边栏关闭时不摘除菜单的 document 监听（长会话无界增长）',
    F.reader,
    (t) => rep(t, "                document.removeEventListener('click', this._rotate_menu_close, true);", ''),
    /摘除/],
  ['动态插入侧边栏后不补 theme_load_icons（旋转按钮图标空白）',
    F.reader,
    (t) => rep(t, '        window.ThemeManager?.theme_load_icons?.();\n', ''),
    /theme_load_icons/],
  ['确认门不判角度是否变化（旋转到同角度也弹窗骚扰）',
    F.reader,
    (t) => rep(t, 'if (!skip_confirm && prev !== next && this._has_any_strokes()) {', 'if (!skip_confirm && this._has_any_strokes()) {'),
    /确认门条件完整/],
  ['确认门不判画布是否有笔迹（空白文档旋转也弹窗）',
    F.reader,
    (t) => rep(t, 'if (!skip_confirm && prev !== next && this._has_any_strokes()) {', 'if (!skip_confirm && prev !== next) {'),
    /确认门条件完整|画布是否有笔迹/],
  ['取消确认后仍然继续旋转（用户点取消却照样清空批注）',
    F.reader,
    (t) => rep(t, 'if (!ok) return prev;', 'if (!ok) { /* 取消 */ }'),
    /取消时返回原角度/],
  ['确认门放在角度赋值之后（弹窗期间画面已转，批注已错位）',
    F.reader,
    (t) => rep(t, '        this._page_rotation = next;\n        // 90/270 让宽高互换', '        this._page_rotation = next;\n        if (!skip_confirm && this._has_any_strokes()) { await this._show_reader_confirm("t", "m"); }\n        // 90/270 让宽高互换'),
    /确认前不修改任何状态/],
  ['重开确认弹窗时不结算上一个（连点两下让第一个 Promise 永久 pending）',
    F.reader,
    (t) => rep(t, '            if (this._reader_confirm_settle) {\n                this._reader_confirm_settle(false);\n            }\n', ''),
    /先结算上一个/],
  ['确认弹窗结算函数去掉 done 幂等守卫（三出口会重复 resolve）',
    F.reader,
    (t) => rep(t, '                if (done) return;      // 三个出口（取消/确定/点遮罩）只能结算一次\n', ''),
    /done 幂等守卫/],
  ['确认弹窗结算时不摘 keydown（长会话累积监听）',
    F.reader,
    (t) => rep(t, '                document.removeEventListener(\'keydown\', on_key);\n', ''),
    /摘掉 keydown/],
  ['确认弹窗文案改用 innerHTML 拼接（动态文案开口子）',
    F.reader,
    (t) => rep(t, '            h.textContent = title;', '            h.innerHTML = title;'),
    /textContent 赋值/],
  // 用改名而不是删行：rotateClearWarn 是 reader 段的最后一个键（行尾无逗号），
  // 删掉整行会让 JSON 断在两个键之间 —— 脚本解析失败崩掉，测的就不是
  // 「键缺失」而是「JSON 坏了」，等于没测到点上。
  ['旋转确认文案在某个语言包缺失',
    F.locale,
    (t) => t.replace('"rotateClearWarn":', '"rotateClearWarn_renamed":'),
    /语言包都带齐旋转确认文案/],

  // ---- 以下针对确认弹窗的**运行时**行为（reader-confirm.mjs）----
  // 这一组是补上「静态守卫的结构性盲区」：下面第一个变异曾经真的上线报过
  // TypeError（const overlay 被重复赋值），而当时全部静态正则守卫全绿。
  ['确认弹窗里 const overlay 被重复赋值（曾真实报错的 bug）',
    F.reader,
    (t) => rep(t, "            const overlay = document.createElement('div');\n            const t = (k, fb) => window.i18n?.format_translate(k) || fb;\n            overlay.id = 'drReaderConfirm';",
      "            const overlay = document.createElement('div');\n            const t = (k, fb) => window.i18n?.format_translate(k) || fb;\n            overlay = document.createElement('div');\n            overlay.id = 'drReaderConfirm';"),
    /弹窗已挂载到 body|passed/],
  ['确认弹窗不挂载到 DOM（点了没反应）',
    F.reader,
    (t) => rep(t, '            document.body.appendChild(overlay);', ''),
    /弹窗已挂载到 body/],
  ['确认弹窗去掉取消按钮的结算（点了取消永远转不完）',
    F.reader,
    (t) => rep(t, "            cancel.addEventListener('click', () => finish(false));", ''),
    /取消|passed/],
  ['确认弹窗去掉确定按钮的结算',
    F.reader,
    (t) => rep(t, "            ok.addEventListener('click', () => finish(true));", ''),
    /确定|passed/],
  ['确认弹窗点遮罩改为「确定」（误点遮罩就清空批注）',
    F.reader,
    (t) => rep(t, 'if (e.target === overlay) finish(false);', 'if (e.target === overlay) finish(true);'),
    /点遮罩/],
  ['确认弹窗不支持 Esc（键盘用户无法取消）',
    F.reader,
    (t) => rep(t, "if (e.key === 'Escape') { finish(false); return; }", ''),
    /Esc/],
  ['确认弹窗不把遮罩移出 DOM（多次旋转后弹窗堆叠）',
    F.reader,
    (t) => rep(t, '                overlay.remove();', ''),
    /从 DOM 移除|残留/],
  ['确认弹窗结算后不清空 settle 句柄（下次开弹窗会误结算上一次的 finish）',
    F.reader,
    (t) => rep(t, '                this._reader_confirm_settle = null;\n', ''),
    /结算句柄已清空|先结算上一个/],
];

let bad = 0;
const uncaught = [];
const rep = (t, find, to) => {
  // 按行切开、各自转义、再用 \r?\n 拼回。文件是 CRLF/LF 混合，
  // 直接把含真实换行的字符串丢进 RegExp 只会匹配裸 LF，遇到 \r\n 就落空。
  const re = new RegExp(find.split(/\r?\n/).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n'), 'g');
  return t.replace(re, to.split(/\r?\n/).map((s) => s.replace(/\$/g, '$$$$')).join('\r\n'));
};
for (const [label, file, mutate, expect] of MUTATIONS) {
  const before = run();
  const src = fs.readFileSync(file, 'utf8');
  const next = mutate(src);
  if (next === src) {
    console.log('SKIP  变异没生效（源码已变或模式失效）: ' + label);
    restore();
    bad++;
    uncaught.push('[SKIP] ' + label);
    continue;
  }
  fs.writeFileSync(file, next, 'utf8');
  const after = run();
  restore();
  const newFails = after.failed.length - before.failed.length;
  const newCrashes = after.crashed.filter((s) => !before.crashed.includes(s));
  const caught = (newFails > 0 || newCrashes.length > 0) && expect.test(after.out);
  if (!caught) { bad++; uncaught.push('[MISSED] ' + label); }
  const why = [
    newFails > 0 ? 'FAIL ' + after.failed.slice(-newFails).map((f) => f.split('   ')[0]).join(' | ') : '',
    newCrashes.length ? '崩了 ' + newCrashes.join(',') : '',
  ].filter(Boolean).join(' / ');
  console.log((caught ? 'CAUGHT ' : 'MISSED ') + label + (why ? '\n         -> ' + why : '\n         -> 守卫没有反应'));
}
restore();
console.log('');
console.log(bad ? bad + ' 个变异未被守卫捕获或未生效' : '全部 ' + MUTATIONS.length + ' 个变异均被守卫捕获');
// 未捕获清单单独走 stdout 且用 ASCII 前缀：控制台按 UTF-8 解码中文标签会乱码，
// 混在正常输出里既看不清也容易漏读。
if (uncaught.length) {
  console.log('');
  console.log('### UNCAUGHT ' + uncaught.length);
  uncaught.forEach((l, i) => console.log('### ' + (i + 1) + '. ' + l));
}
process.exit(bad ? 1 : 0);