# 更新日志

## 未发布

### 修复（全仓深度审计的 25 项缺陷 · 2026-09-19）

报告：`.workbuddy/reports/2026-09-19-深度缺陷审计.md`。逐项修复，五套回归
（`dpr-harness` 117 / `resize-probe` 75 / `layer-dpr` 15 / `perf-equivalence` 9 /
`reader-deadzone` 22 = **238 条**）全绿；新增守卫均经变异测试自证会红；`cargo check` 通过。

**P0**
- 小黑板 `close()` 竞态：`is_open=false` 与 `pop_history_isolate()` 之间隔 `await` 且尾段无
  `finally` → ①`open()` 抢入会覆盖 `saved_history_state`，**主程序撤销历史被黑板栈覆盖**；
  ②上抛则 `__HISTORY_ISOLATED` 永久为 true、面板**再也关不掉**。现：加 `_closing` 重入闩、
  收尾三件事移入 `finally`、`open()` 等待关闭完成后再进。
- 主题包 Zip Slip（`theme_import_vst`）：zip 条目名未校验 `..` 且解压无体积上限 → 恶意 .vst
  可写任意路径。现：条目名逐段校验 + 单条目/总量体积上限。
- 权限收窄：`capabilities` 的 `fs:scope` 去掉 `{"path":"**"}` 全盘读写；CSP 去掉 `unsafe-eval`；
  `Cargo.toml` 不再给 release 开 `devtools` 特性。
- 主画布撤销/重做不可用：`main_handle_undo` 零引用、`redo` 无实现、快捷键未接。现补
  `main_handle_redo`（与 undo 对称：作废几何缓存 + 快照计数 + idle 压缩检查）、
  全局 `Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z`（黑板/阅读器打开时让位、输入框聚焦不劫持），
  清空画布后接入 `initCompaction()`。

**P1**
- 重做链路补全：`history.js` 新增 `history_handle_redo`（失败回滚栈）、`history_peek_redo`、
  redo 栈硬上限（50×2，防持久化单调膨胀）；阅读器新增 `handle_redo`（含跨页切换）与工具栏
  重做按钮（`drBtnRedo`）；黑板 `handle_redo` 已接，快捷键统一。
- 遥测开关是装饰品：唯一判空在零调用的 `telemetryInit` 里，`oobe` 直调 `reportOnline` →
  关开关照样上报 UUID/IP/地理。现：`reportOnline` 出口自带 `telemetry_is_enabled()` 判断
  （任何调用路径都绕不过），oobe 改走 `telemetryInit`。
- 后端补 `theme_get_preview` 命令（主题预览图从此真正显示；canonicalize 防穿越 + 4MB 上限），
  移除孤儿镜像命令 `mirror_update_state`/`mirror_fetch_state`。
- 命令层加固：`update_install_release` 只允许执行更新目录内的安装包；GitHub URL 校验补全；
  遥测 http 命令域名白名单；`file_md5` 强制 32 位十六进制 + 文件名消毒；config.json 写入加锁
  （防并发互相覆盖）。

**P2**
- 阅读器 `_page_visible_timeout_id` 由"单变量跨页取消"改为**每页存储**（快速滚动时 A 页的
  回收定时器不再被 B 页误取消）；删除只被赋 null 的死字段 `_visible_init_timeout`。
- 小黑板关闭补齐全部定时器/rAF 取消；黑板 `PinchZoomSourceV2` 补 `startDelayMs`（随批注/移动
  模式切换，与阅读器同款手掌容错——此前黑板无手掌防误触）。
- `drawing-engine.push/pop_history_isolate` 加重入保护；小黑板 keydown 处理 `_closing` 闩。
- `renderMarkdown` 链接过**协议白名单**（`javascript:` 等不可信 href 降级为 `#`，来源是
  GitHub Release body）。
- `pen_tessellator` 缓存配额满改为**整体作废重来**（此前 `_cachedRunCount` 只增不减
  —— WeakMap 无 GC 回调 —— 累计 20 万段后缓存永久停止接纳新笔画 = 性能悬崖）。
- `developer-options` 的 `window.__documentReaderManager` 死句柄改为真实的 `documentReaderManager`
  （椭圆笔刷开关此前对阅读器静默失效）。

**P3（卫生）**
- 删除零引用死代码：`palm-eraser` 整模块（162 行）、`main_update_source`/
  `main_fetch_cached_canvas_rect`/`main_render_pdf_pages_lazy`/`main_update_eraser_style`/
  `main_save_photo`/`main_update_image_rotation`/`main_load_image`（约 230 行）、
  死参数 `renderScale` 及 `_render_all_strokes` 为它做的 `state.scale` 存改还原空转、
  死依赖 `safeScaleFn`。
- 阅读器撤销/重做按钮图标修正（`undo` 图标文件不存在一直是裂图 → `reply`/`arrow-repeat`）。
- `perf-equivalence` 探针补 `Runtime.consoleAPICalled` 监听：引导期模块加载失败走
  try/catch + console.error，不产生异常事件，此前对探针完全不可见。
- 新增验证/审计工具并纳入版本库：`.workbuddy/audit/boot-check.mjs`（抓模块加载期
  被 try/catch 吞掉的引导错误）、`.workbuddy/audit/static-scan.mjs`（七族缺陷静态扫描器）、
  `.workbuddy/verify/` 五套回归探针与 README（`dpr-harness` 117 / `resize-probe` 75 /
  `layer-dpr` 15 / `perf-equivalence` 9 / `reader-deadzone` 22）。

### 修复（阅读器里的批注会「画到旧位置」而整片消失）

- **改了窗口大小 / 页内缩放之后，批注被画到改动前的坐标上，位移一超过一块瓦片就整块空白；
  再滑回来也不恢复。** 根因不在瓦片、不在四叉树、也不在笔画数据，而在**渲染几何缓存的失效判据**：
  `_scale_page_annotations()` 是**原地改写** `stroke.points`（`p.fromX *= sx` 之类），
  而三处按「笔画对象」缓存的渲染几何都只认**对象标识**，看不到对象内部变化——
  `RealPenManager.cached_tessellated`（WeakMap，无版本判据）、
  `PenTessellator._runsCache`（键为细分对象，随上者一起陈旧）、
  `stroke-renderer._strokePathCache`（判据是「点数组长度 + 首尾点对象标识」，而原地改值两者都不变）。
  于是重绘沿用旧坐标落笔。
  - **失效的对称性**：块被「它按新坐标命中它的瓦片」重绘 —— 但画的是旧位置。旧位置若落在
    别处，那一块就得到 0 像素（空白），而真正覆盖旧位置的瓦片又不再命中这条笔画，也不画。
    实测一次 `1280 → 960 → 1280` 后：**16 块里 10 块可见却空白**，像素仅覆盖
    `x 37..895 / y 85..470`（= 缩放前基准），而数据已正确放大到 `x 54..1194 / y 94..1494`。
  - **定因方式（关键）**：把 `penEffectMode` 临时切成 `off` 绕开笔锋缓存、改走另一条**冷启动**的
    渲染分支再全量重绘 —— 数据、四叉树、瓦片几何全都没动，唯一变量是「几何取自哪条缓存」：
    16/16 块立刻有内容；切回 `full` 再重绘，空白**立刻回来**。这排除了
    「四叉树陈旧」「笔画数据错」「落笔解锁」三个候选，坐实缓存陈旧。
  - **修法**：新增唯一作废入口 `window.main_invalidate_stroke_geometry_caches()`
    （清 `cached_tessellated` + tessellator 的 `_runsCache` 与体积配额计数 + `_strokePathCache`），
    由 `_scale_page_annotations()` 在重建瓦片前调用。`RealPenManager.reset()` 同步改为走该入口。
  - 顺带修掉一处**静默空操作**：`settings.js` 两处换笔锋模式后调
    `window.realPenManager.invalidate_cache()`，而 `window.realPenManager` **从未被赋值**
    —— 该分支永远不成立，换模式不生效。现改用统一入口。
  - 新增守卫：`dpr-harness.mjs` 4 条源码层不变式 ——「原地改写笔画几何的文件必须调用统一作废入口」
    （已用变异测试确认会红并指名到文件）、「入口必须同时清两类缓存」、「失效全局零残留」、
    以及一条「守卫本身有效」自检（原地缩放代码仍存在）。`reader-deadzone-probe.mjs`
    新增 S5b/S6 端到端断言（真实 Chromium，DSF=1.25）：窗口尺寸反复变化、Ctrl+滚轮缩放后
    16 块瓦片必须全部有内容，无可见空白块。

### 修复（窗口调整大小的手感）

- **拖拽调整窗口时，画布内容整个纹丝不动**：`main_handle_resize()` 把**连几何对齐一起**
  防抖了 150ms，于是连续拖拽期间一个 resize 回调都不执行 —— 窗口边框在动、内容僵住。
  实测「容器宽 − 已应用屏幕宽」在整个拖拽期间单调涨到 **420px**（0 = 逐帧跟随）。
  现改为 **拖拽期间逐帧（rAF 合并）做轻量几何对齐**（只对齐几何基准，不动瓦片网格），
  **完整重建仍旧防抖 150ms**：该差值降到 **11px**，拖拽全程保持 60fps，
  且防抖重建照常发生（网格确实按新尺寸重建）。
  - **必须配套一个闩**：轻量对齐写的就是 `DRAW_CONFIG.screenW/H`（几何的唯一写入者），
    防抖到点时原入口 `main_sync_screen_size()` 会据此判定「尺寸没变」而直接 return ——
    **瓦片网格再也不会按新尺寸重建**，而几何看上去完全正常。故重建入口改看新增的
    `_resize_needs_rebuild` 闩（`main_flush_resize_rebuild()`）。这个失败模式是先写
    探针量出来才发现的（候选场景输出：`lag=0`、帧率完美，但**画布重分配 0 次**）。
  - 新增回归守卫：`resize-probe.mjs` 断言**网格尺寸**（`get_tile_dimensions()` ==
    `ceil(canvasW/4) × ceil(canvasH/4)`）与首块瓦片画布尺寸，而不只是几何尺寸 ——
    上面那个坑只有网格会露馅，`screen == container` 之类是照不出来的。
- **调整大小结束后仍有一记冻结**（本轮定位、未修）：300 条笔迹 ~110ms / 3000 条 ~850ms。
  逐项拆解实测：底图（16 块缓存画布 + 12.6M px 大块贴图）只占 **36ms**，
  **笔迹重新光栅化占 739ms**，且这笔开销发生在画布刷新/合成阶段、**不在应用 JS 里**
  （应用侧挂钟只占 ~30ms，所以 `ctx.stroke` 只是记进显示列表，真正光栅化在函数之外）。
  已验证「只重建可见块」无效（重建块数 16 → 9，冻结只缩 12%），故**未采用**该改法。
  要真正消掉它需把瓦片网格从「尺寸随画布推导的 4×4」改成「固定内容尺寸、随画布增删边缘块」，
  属架构级重构，未在本轮实施。

### 优化（性能：渲染热路径）

> 前提：**行为零变更**。改动只涉及「同一份几何算几遍」，不改变任何像素输出 ——
> 由新增的 `perf-equivalence.mjs` 用「从 git HEAD 提取的改造前实现」与现实现做
> 逐字节比对来证明。全部改动只落在三处重复计算上。

- **笔锋渲染：同一笔画的折线被「每块相交瓦片 × 每次重建」重复走了一遍**
  实测一次全量重绘（3000 条笔迹）发出 **stroke 28715 次、lineTo 1,569,960 次** ——
  而笔迹只有 3000 条。原因：`tessellator_render_stroke` 每次调用都重新做
  「每段 8 次贝塞尔求值 + 宽度插值」并逐点 `lineTo` 进上下文的当前路径，而一条
  笔迹会因相交多块瓦片、且每次瓦片重建都要重画而被反复走。这些几何只由
  `segments` 与 `scaleRatio` 决定（调用方恒传 1），与瓦片、DPR、视图变换全都无关。
  现改为按「细分笔画对象」缓存 **宽度分段 → Path2D** 列表（`_runs` / `_build_runs`），
  渲染退化为每段一次 `ctx.stroke(path)`：**lineTo 157 万 → 0**。
  确定性微基准（1200 条笔画 × 30 段，同进程同画布各 5 轮均值）**21.2ms → 1.7ms**。
  缓存按「段」设总量上限（20 万段）封住病态输入（逐点跳变宽度）的原生内存；
  超限后不入缓存，**渲染仍走同一条代码路径**，结果不变，只是退回旧代价。
- **四叉树：包围盒在每个节点上被重复归一化**
  `intersects()` 每次判相交都要做四个 `bounds.minX != null ? … : …` 的形态判定，
  而它在一次插入中被调用 `5^depth` 次（每层 1 次父判定 + 4 个子判定）。现把归一化
  提到 `StrokeQuadTree._normalize()`，在 `insert` / `query` 的**入口只做一次**，
  判定退化为纯数值比较；节点的右/下边界也在构造时预先算好（`_bx/_br/_by/_bb`）。
  构建耗时 **36.8ms → 25.2ms**（3000 条笔迹）。
- **常量宽度笔画的 Path2D 被每块瓦片每次重建重新构建**
  `stroke-renderer.js` 的常量宽度分支对每条相交笔画 `new Path2D()` 后逐点 `lineTo`。
  Path2D 的几何以**内容坐标**书写（瓦片偏移与 DPR 由 ctx 变换承担），与瓦片无关，
  故改为按笔画缓存（`_get_stroke_path`），并以「点数组长度 + 首尾点对象标识」作
  失效判据 —— 笔画被追加点或原地替换端点时自动失效，不会画出过期笔迹。
  （该分支在 `penEffectMode` 关闭时生效；开启时走上面的笔锋路径。）

**同机同条件的 A/B 实测**（`perf-probe.mjs --pre-r7` 提供「改动前」源码视图，
两侧各重复 3 轮取最优）：

| 场景 | 应用侧 JS | Task 总时长 |
| --- | --- | --- |
| 全量重绘（撤销 / 切源） | 102.2ms → 34.4ms（**-66%**） | 255.6ms → 131.6ms（**-49%**） |
| 瓦片网格重建（窗口尺寸变化） | 99.4ms → 37.5ms（**-62%**） | 301.3ms → 171.6ms（**-43%**） |
| 缩放结算重建 | 24.0ms → 6.5ms（**-73%**） | 854.0ms → 824.1ms（-3.5%） |
| 静止后显存回收 | 0 → 0 | 141.5ms → 90.9ms（**-36%**） |
| 连续平移（不触发重建，对照项） | 0 → 0 | +5%（噪声底） |

### 修复

- **批注层的动态分辨率与图片（图像层）不同步**：三处口径分叉，均已收口
  - **瓦片内的底图缓存恒按 1x 存储**：`_update_base_cache()` 按内容尺寸（1x）分配缓存画布，
    再由 `rebuild_tile` 在 dpr 变换下贴回瓦片 —— 底图被放大 dpr 倍，而笔迹是矢量按 dpr 重绘，
    **同一张瓦片里「图片」与「批注」的有效分辨率差 dpr 倍**，缩放越高差得越远。且底图源本身
    可能已带 dpr 级细节（压缩快照就是按 `calc_tile_dpr` 渲染出来的），按 1x 缓存等于先丢掉
    这些细节再放大，是纯画质损失、换不来显存收益。现按**逐块 `info.dpr`** 分配
    （`_build_base_cache_entry`），并在 `rebuild_tile` 内经 `_ensure_base_cache` 行内补齐
    dpr 不一致的块——渐进重建队列是先改 `info.dpr` 再调 `rebuild_tile`，而批量刷新发生在
    改之前，中间那一帧会读到旧 dpr 的缓存。实测 scale=1/2/4 下 16 块缓存全部与瓦片同 dpr
    （4× 时 1 → 4），4× 同区域裁剪对照图可见底图细节明显更实
  - **基准 DPR 会被事件漏派发卡在旧显示密度**：`baseDpr` 是内容空间的 1x 起点、语义上恒等于
    当前显示 DPR，但此前只由 matchMedia change / 窗口几何两条事件路径刷新，而该查询在部分
    环境不派发 change（实测无头环境不派发）。一旦漏派发，瓦片层会按旧密度栅格化，而覆盖层
    （`calc_overlay_dpr`）与图像层（`<img>` 的呈现密度）都是实时读 `devicePixelRatio` ——
    **批注层糊、图片层清，且永不自愈**。现改为 `sync_base_dpr()` 在**读取处对齐**，
    `base_dpr()` 经它返回；事件路径保留（额外负责广播 `refresh_all`）。实测高分屏下
    批注层背衬密度 0.50 → 1.00
  - **图像层盒尺寸被几何函数盲写**：`main_apply_canvas_geometry()` 直接把 `#imageElement`
    的盒写成 `canvasW×canvasH`，而它的正确值是「按屏幕尺寸等比放入画布再居中」的派生量。
    后果是几何变化后图像被拉伸 2 倍并丢掉居中（`left/top` 仍是旧值），而同时刻批注层瓦片是
    按新几何正常重建的 —— 两层几何不同步（此前只有完整重建路径末尾补调一次图像层布局遮掩了它）。
    现改为有图时转调 `main_render_image_centered()`，无图时保持满画布空盒
- `baseDpr` 从 `update_settings` 的设置键中移除：它是显示 DPR 的派生缓存、不是设置项。
  留在键里会出现「设置返回已变更、值随即被读取处修正回去」的假成功

### 优化

- **动态分辨率与覆盖层重写**：新增 `ResolutionController`（瓦片层 / 覆盖层 DPR 计算的唯一来源 + 设置写入 + 上下文订阅）与 `OverlayManager`（覆盖层画布、展示尺寸与 DPR 的唯一几何路径、视图变换、局部清除）。`RealtimeBatchDrawManager` 不再转售覆盖层 API，主画布 / 阅读器 / 小黑板三处共用同一套逻辑
- 移除 `sync_all_overlay_dpr` 中逐处手写三份 overlay 尺寸赋值的补丁式同步，改为由控制器向已注册上下文统一分发
- **DPR 计算全部收口到 `ResolutionController`**：新增 `static_dpr()`（静态倍率 = 基准 DPR 受「画面精度」约束，全应用唯一实现）、`base_dpr()`、`calc_ui_dpr()`（缩略图等小尺寸 UI）、`apply_persisted()`（启动期回放持久化画质设置）、`watch_display_dpr()`（跟随显示器 DPR 变化）；`calc_tile_dpr()` 支持 `role` 分级（活动页 / 半可见邻页 / 离屏页）与统一的内存压力守卫。瓦片层、覆盖层、阅读器页面栅格化、主画布离屏合成不再各自维护公式
- `DRAW_CONFIG.dpr` 改为**派生值**：只由 `ResolutionController.sync_static_dpr()` 写入，外部一律不得赋值，杜绝「设置改了但派生值陈旧」
- 阅读器删除自带的 `_calculate_adaptive_dpr` 算法体（base×scale→ceil→cap4 的第二份 DPR 实现），改为只把「活动页 / 半可见邻页 / 离屏页」的页面语义翻译成控制器 `role` 参数
- 小黑板移除与 `OverlayManager.sync_transform` 逐项重复的 `_sync_overlay_transform` 覆盖实现，变换锚点统一由 `set_transform_provider` 注入；resize 改走 `overlay.resize()`，恢复「resize 保留内容快照」的既有能力
- 覆盖层内部字段不再被外部直写：新增 `OverlayManager.invalidate_transform()` 取代各处 `overlay._transformScale = 0`；`destroy()` 统一负责清零像素尺寸释放显存
- 阅读器已废弃的分页 overlay 残留代码清理完毕（相关字段只写不读，两处死分支移除）
- 主画布离屏合成画布改用瓦片档 DPR（与瓦片同为内容空间），此前用静态倍率，放大状态下合成分辨率不足

- **动态分辨率切换无感化**：
  - 手势冻结：缩放/平移进行中不重建瓦片（由 `ResolutionController.mark_interaction()` 在三个上下文的 transform 入口打时间戳），手势结束后按最终缩放一次到位。此前缩放过程中每跨一个 DPR 步进就全量重建一次，是缩放掉帧的主因
  - 只升不降：降级没有任何视觉收益却必然带来一次"变糊"，现统一交给静止后的 idle 回收处理；回收时降到"当前目标 DPR"在视觉上无损（目标本就等于 缩放 × 显示 DPR，刚好铺满物理像素）
  - 分帧原子重建：瓦片的「realloc → 精确重绘」在同一帧内完成，未轮到的瓦片保持原分辨率原内容，消除"先变糊再变清"；可见瓦片按距视口中心排序优先处理，非可见瓦片只预升级紧邻可见区的一圈
  - 迟滞改为按 DPR 步进判定（此前按缩放差值，且在可见瓦片变化时完全失效）
  - 快照画布池化，且原子重建路径跳过快照绘制
- **缩小后及时降级 + 不可见块零处理**：
  - 缩小跨过一个 DPR 步进后，可见瓦片随目标降低及时降级回收（原子重建无闪烁），节省显存与合成带宽，不再等待 2s 静止回收
  - 不可见瓦片完全退出交互路径：不预升级、不排队、不重建；其显存回收仅由静止 2s 后的 idle-shrink 一次性完成（降级时保留占位内容，此后进入视野不空白）
  - 移除按步进量化的 DPR 迟滞（量化后相邻目标差恒 ≥ 1 步进，迟滞形同虚设）；防抖由手势冻结承担；目标未变的纯平移路径放行，保证平移后新进入视野的瓦片及时补齐分辨率（主画布平移现在也做轻量 DPR 检查，与阅读器/黑板对齐）
- **可见块可见性保障（防误判为不可见）**：
  - 手势冻结仅针对缩放（目标 DPR 每帧都在变才有冻结意义）：主画布/阅读器/黑板改为仅在 scale 变化时标记交互，纯平移期间新进入视野的瓦片按可见块立即补齐分辨率，不再整段平移发糊。阅读器平移 rAF 中补上了此前缺失的瓦片 DPR 检查
  - 渐进重建泵每帧以最新可见性过滤队列：建队后滚出视野的瓦片跳过重建（显存交给 idle 回收），仍可见的照常处理；期间目标 DPR 漂移（新缩放开始）则中止本轮，由调度路径按新目标重排
  - idle 显存回收避让一切视图活动：近期有变换检查（含平移）600ms 内顺延，触发时以最新可见性为准——只回收真正不可见的瓦片，可见块（哪怕刚进入视野）绝不被按不可见块降级
- **覆盖层 DPR 变更不再清空内容**：改像素尺寸一律先存快照、改完立刻回写；尺寸与 DPR 都没变时提前返回，不做无谓的全屏重分配（此前 force 场景会白清空一次）
- **`RealtimeBatchDrawManager` 不再转售覆盖层 API**：删除 `set_transform_provider` / `update_overlay_dpr` / `sync_overlay_dpr_now` / `resize_overlay` / `destroy_overlay` / `hide_overlay` / `show_overlay` 七个纯转发方法，以及 `_overlayCanvas` / `_overlayCtx` / `_overlayDpr` / `_overlayTransformScale|X|Y` 六组兼容字段代理。覆盖层访问统一为 `batch_draw.overlay.*`，与类内既有写法一致；`clear_overlay()` 因还负责重置批处理自身的 dirty 边界而保留
- **`OverlayManager` 收窄为覆盖层唯一所有者**：新增 `set_rect_anchor({get_rect, get_scale, fallback_origin})`，把「变换锚点 = 锚点元素的实时 `getBoundingClientRect()`」固化为唯一写法，阅读器与小黑板两处几乎逐行重复的 provider 闭包随之收口。`destroy()` 明确为「像素释放 + DOM 摘除」的唯一入口，外部不再自行 `removeChild` / 置 `width=0`
- 覆盖层的 2D 上下文创建权收归 `attach()`：调用方只交出画布，上下文按 `_contextAttributes` 在管理器内创建，避免「该带哪些 attributes」两处走散
- 小黑板不再持有覆盖层画布引用（原 `this.overlay_canvas` / `this.overlay_ctx`），消除同一张画布的双所有者
- **覆盖层「笔画期顺延 DPR 调整」机制整体移除**：`begin_stroke()` / `end_stroke()` / `request_dpr()` 与 300ms 迟滞定时器一并删除（`batch-draw.js` 三处调用点同步清理）。该机制的存在理由是「避免改像素尺寸清空内容导致未提交笔迹闪断」，而 `_apply_geometry()` 的内容快照已独立保证这一点；保留它反而会把笔画进行中的真实尺寸变化**无声丢弃**（`end_stroke(false)` 还会主动丢弃）。现在笔画进行中调用 `resize()` / `sync_dpr_now()` 立即生效，未提交的预览由快照续上
- **`OverlayManager` 的展示尺寸与 DPR 收敛为唯一几何路径**：`resize()` 原先自己实现一份尺寸写入（丢了内容快照：绘制中改变窗口时未提交的笔迹预览直接消失，只有 DPR 路径做到了快照），现与 `_apply_dpr()` 一并委托 `_apply_geometry(displayW, displayH, newDpr, force)` —— 全类唯一改写 `canvas.width/height` 的地方，尺寸与 DPR 均无变化时提前返回
- 主画布几何缓存加版本号 `main_geometry_version`：可见域与平移边界缓存此前只按 scale / canvasX 做键，窗口尺寸变化后键不变、命中即返回旧值。现把几何版本并入缓存键
- `ResolutionController` 抽出 `refresh_display_dpr()`：显示器 DPR 变化时「更新基准 DPR → 重算派生静态倍率 → 刷新全部上下文」三步收在一处，matchMedia 与 resize 两条触发路径共用

### 修复

- **覆盖层动态分辨率从未生效**：覆盖层 DPR 计算在动态 DPR 开启时恒返回 1，高分屏与放大状态下实时预览发虚；现以显示 DPR 为上限参与计算（显式 `overlayDpr` 仍优先）
- **外部注入 overlay 画布时 DPR 调整会把画布缩成 1px**：覆盖层管理器补记展示尺寸（黑板/阅读器路径），并从 CSS/布局尺寸兜底推断
- **「画面精度」重启后不生效**：`dprLimit` 从未列入 `settings-changed` 的处理键，也未在启动时回放，导致设置面板提示的「建议重启应用以确保完全生效」实际不成立——重启后一律回落默认值。现纳入控制器统一写入，并在 `init.js` 首帧渲染前回放全部持久化 DPR 设置
- **设置面板直写 `DRAW_CONFIG.overlayDpr`**：绕过控制器，与上下文刷新、静态倍率重算脱节；现统一经 `update_settings()` 写入
- **小黑板覆盖层倍率与展示尺寸失真**：`attach()` 之后又手写一遍 `width/height`，白清空一次画布并把展示尺寸记错；resize 路径同样绕过快照逻辑，表现为调整窗口时预览笔迹闪断
- **阅读器完全不响应「动态分辨率」开关**：其自适应 DPR 走私有开关 `_adaptive_dpr_enabled`（恒为 `true`），关闭动态分辨率对阅读器页面栅格化没有任何影响；收归控制器后由 `dynamicDprEnabled` 统一决定
- **主画布三处空转的覆盖层调用**：`main_update_canvas_size` / `main_update_canvas_transform` / `main_delete_draw_canvas` 里的 `resize_overlay` / `update_overlay_dpr` / `clear_overlay` 对主画布而言恒为空操作（覆盖层无 canvas）。其中平移路径那句会给每次平移白排一个 300ms 的 DPR 迟滞定时器；且覆盖层 DPR 与缩放无关，该调用在任何实现下都无意义。已删除，并就地注明「主画布无覆盖层、将来若接入应在何处补」
- **覆盖层变换锚点不再有「主画布专属旧约定」兜底**：未注入 provider 时原先回退到 `window.state.canvasX/canvasY`，而该分支只在主画布有覆盖层时才可能到达——既不会执行，又会在将来接入时静默算错。改为回退单位变换并告警一次
- **`main.js` 的 `baseDpr` 初值改经控制器取**（`ResolutionController.display_dpr()`）：`devicePixelRatio` 的裸读此前还散落在 `main.js`、阅读器页面栅格化与缩略图三处，现全应用只允许出现在控制器内
- **主画布完全不响应窗口缩放**：`main_handle_resize()` 自首次提交起就没有任何调用者（其唯一调用者 `main_update_canvas_size()` 同样无人调用），`DRAW_CONFIG.screenW/screenH` 因此恒为 0；而 `.canvas-wrapper` 上的 `contain: layout style paint` 会把 0×0 盒子的全部子元素裁掉 —— 表现为调整窗口后主画布尺寸不跟随、瓦片不再铺满。现补齐 resize 订阅（`window.resize` + Tauri `onResized`），几何写入收敛为唯一实现 `main_apply_canvas_geometry(w, h)`
- **瓦片渲染器 `_destroyed` 闩锁**：`destroy()` 置 `true` 后 `init_tiles()` 从不复位，于是 `destroy_all() → init_tiles()` 的复用路径让 DPR 调度与 idle 显存回收永久失效（瓦片停在旧分辨率）。`init_tiles()` 现复位该标志
- **`baseDpr` 不跟随显示器 DPR**：`matchMedia` 的 change 处理只重算了静态倍率、没有更新基准 DPR —— 真实浏览器探针实测 `devicePixelRatio=2` 而 `baseDpr` 仍为 1。抽出 `refresh_display_dpr()` 统一更新，并在窗口 resize 处理器里补调一次（覆盖 matchMedia 不派发的环境）
- **主画布重建缺可重入保护**：resize 防抖期间反复触发会并发走「销毁瓦片 → 重建瓦片 → 初始化」流程。现以 `_canvas_size_rebuilding` / `_canvas_size_pending` 串行化，并把 `main_update_canvas_size()` 拆出纯重建分支 `main_rebuild_canvas_for_size()`，去掉「存旧 scale/canvasX → 重建 → 再写回」的反模式

### 清理

- 移除主画布**实时预览覆盖层**留下的整套死代码。主画布笔迹直接落瓦片层，`main_start_stroke` / `main_save_stroke_point` 全仓无调用者且未导出（因此 `state.currentStroke` 恒为 `null`）。连带删除：`state.currentStroke` 字段、`RealtimeBatchDrawManager.init_overlay()` 与 `calc_overlay_dpr()` / `_calc_overlay_dpr()`、`OverlayManager.init()` 与 `calc_overlay_dpr()`、`.draw-overlay` 样式。覆盖层创建路径收敛为「调用方创建 → `attach()` 注入」，与阅读器 / 小黑板的实际用法一致
- `main_submit_stroke()` 收敛为实际会执行的形态（`batch_draw_handle_end()` + `batch_draw_delete_all()`）：原函数体的提交分支以 `state.currentStroke` 为条件，而该字段的唯一写入者 `main_start_stroke` 无人调用，该分支从未执行。阅读器与小黑板调用它，实际目的是收尾共享的 `batchDrawManager`
- 删除 `main_init_compact()`（其唯一调用者同样位于被删分支内），并清理两处引用已删符号的过时注释
- ⚠️ **顺带发现、未改动**：`historyCompactor.initCompaction()` 全仓无调用者 —— 历史后台压缩从未启动过；而 `cancelCompaction()` / `handleCompactStrokes()` 仍在正常链路上，疑似漏接线而非有意停用。因涉及历史 / 撤销行为，未擅自接上，待确认
- 删除 `window.sync_all_overlay_dpr` 全局别名（只剩一行转发到 `ResolutionController.refresh_all`），调用点改为直接调控制器
- **三处 DPR 兜底公式复刻清理**：`OverlayManager._calc_dpr`、`TileRenderer._calc_target_dpr`、阅读器页面栅格化与缩略图此前各自带一份「控制器未就绪时」的公式副本。副本会与控制器的口径静默漂移，正是「改了设置只生效一半」的温床。现统一改为报错 + 安全降级（1x），不再保留第二份实现
- 阅读器分页 overlay 的遗留数据字段清理：`document_reader_page.js` 的 `overlay_canvas` / `overlay_ctx`（只被写成 `null`，从未承载画布）与 `_destroy_page_tiles` 中对应的兜底清理代码一并删除
- `batch-draw.js` 中 `reset_state()` / `batch_draw_init_start()` / `batch_draw_handle_end()` 三处 `overlay.begin_stroke()` / `end_stroke()` 调用随顺延机制一并删除（其中 `end_stroke(false)` 是有害的：它会主动丢弃本应生效的尺寸变更）


## v0.2.5（2026-09-06）

### 新增

- **macOS 样式标题栏开关（默认开启）**：设置 → 应用设置中可选窗口控件样式。开启为 macOS 红绿灯（左置圆形，悬停显示符号）；关闭为 Windows 经典样式（右置 ─ ▢ ✕，最大化后自动切换还原图标，悬停高亮为图标周围的小圆角方框）。两套控件样式完全独立，窗口拖拽热区覆盖整个标题栏空白区域
- **工具栏文字提示开关（默认关闭）**：设置 → 应用设置中控制主工具栏与小黑板工具栏的文字标签显隐，切换即时生效；用户设置优先于主题包内置配置，主题切换、黑板打开时自动跟随
- **小黑板滚轮缩放**：滚轮直接以光标为锚点缩放板面（原先仅 Ctrl+滚轮缩放、普通滚轮平移），缩放精确跟随光标位置，带平滑过渡
- **启动自动清理历史更新安装包**：updates 目录只保留最新一个安装包，历史包随应用启动自动删除并记录释放空间

### 修复

- **钢笔效果设置重启后失效**：在初始设置或设置面板中关闭钢笔效果，重启后仍按完整笔锋生效、且设置界面显示为已关闭；现启动时正确应用保存的模式（off/limited/full）
- **设置中取色器弹窗点击任意区域即被关闭**：遮罩层层叠上下文错误导致弹窗内部点击被透明遮罩截获；修复后弹窗内操作正常，并增加半透明模糊背景，点击弹窗以外区域不再关闭
- **小黑板打开时位置在角落**：重写打开几何逻辑，打开时板面始终定位在屏幕正中央（按文档记忆的笔画、页数、缩放不受影响）
- **小黑板首次打开无滑入动画**：等待样式表就绪后再触发过渡动画
- **"自动清除缓存"设置从未实际生效**：按设置的间隔在启动时触发缓存与 Word 转换缓存清理（含超过 15 天未打开的文档状态记录清理）

### 优化

- 小黑板鼠标逻辑与阅读器完全分离：在黑板上切换工具或关闭黑板，不再改变阅读器的鼠标模式，阅读器保持打开黑板前的状态
- 仓库文本文件换行符统一为 LF，杜绝编辑器/脚本造成的整文件行尾差异噪音

## v0.2.1（2026-08-30）

### 修复

- 窗口 resize 卡死：重布局过程中集合边删边加导致的死循环冻结
- 页面宽高比更新后页盒停留旧比例：重写页大小计算，盒高现算、禁止回读

### 优化

- 窗口尺寸响应重写为 ResizeObserver 双通道管线：轻量通道即时失效缓存、重量通道防抖后完整对齐
- 动态 DPR 分级预渲染与可见页升清 force 接管，窗口拖拽/缩放期间渲染更平滑
- 小黑板适配动态窗口尺寸
- 移除无用的 package.json/package-lock.json（项目无 bundler，构建不依赖 Node）
