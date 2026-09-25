# ViewPDF v0.3.0-Bata2 变更总结

**范围**：`v0.3.0-Bata1`（79a0d3a，2026-09-13）→ `v0.3.0-Bata2`（27443b1，2026-09-19）
**规模**：12 个提交 · 28 个文件 · 约 +2200 / −1200 行
**回归验证**：五套自研探针全绿（dpr-harness 117 / resize-probe 75 / layer-dpr 15 / perf-equivalence 9 / reader-deadzone 22，共 238 条），`cargo check` 通过。

---

## 一、新功能

### 1. 拖拽平移惯性滑动（2d07a59）
阅读器与小黑板 move 模式的拖拽平移松手后按手势速度自然滑行减速。
惯性基础设施自首提交起就存在但被禁用（`momentumEnabled: false`、黑板入口被掏空），本次启用并重做手感：

- **速度估计按时间归一化**：原按「每次输入事件的位移」估速度，鼠标/触屏/手写笔事件率不同导致甩动距离天差地别；现折算为「每 16.7ms 位移」再做 EMA 平滑。
- **减速帧率无关**：原摩擦系数按帧写死（0.85~0.65/帧），120Hz 屏滑行距离减半；现改为指数衰减 `v ×= 0.94^(dt/16.7)` + 位移按 dt 缩放。猛甩约滑行 1 秒、轻抛约 0.6 秒。
- **防误甩**：松手前停顿 >120ms 不触发惯性；拖拽中途停顿 >200ms 旧速度作废；撞到可移动边界速度归零。
- 主画布无拖拽平移（仅滚轮），不涉及。

### 2. 主画布撤销/重做（ac13a74）
- 补 `main_handle_redo`（与 undo 对称）与全局 `Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z` 快捷键（黑板/阅读器打开时让位、输入框聚焦不劫持）。
- 清空画布后接入 `initCompaction()`——后台历史压缩首次真正启动。

---

## 二、缺陷修复

### 渲染与分辨率（bbaf81a）
- **底图缓存逐块同 DPR**：瓦片底图缓存按该块自身 `info.dpr` 存储，消除「底图被拉伸 dpr 倍而笔迹按 dpr 重绘」的层内分歧（批注糊、图片清晰度不一致）。
- **基准 DPR 读取自愈**：`base_dpr()` 读取时对齐显示 DPR，事件漏派发不再导致瓦片层永久停在旧密度。
- **DPR 设置启动回放**：`init.js` 首帧渲染前回放全部持久化 DPR 设置，设置面板改经 `ResolutionController.update_settings()` 写入——「画面精度建议重启生效」从此成立。
- **OverlayManager 几何收敛**：展示尺寸与 DPR 收敛为唯一写入路径 `_apply_geometry()`；笔画期顺延 DPR 调整机制整体删除（内容快照已保证未提交笔迹不闪断）；变换锚点统一 `set_rect_anchor`。

### 渲染性能（7abc8ff）
- **笔锋分段几何缓存**：按细分笔画对象缓存 Path2D 列表，渲染退化为逐段 `ctx.stroke(path)`——全量重绘 lineTo 157 万次 → 0，微基准 21.2ms → 1.7ms。
- **常量宽度笔画 Path2D 按笔画缓存**：内容坐标书写、跨瓦片复用。
- **缓存配额悬崖根治**：配额满改整体作废重来——原实现缓存计数只增不减，累计 20 万段后缓存永久停止接纳新笔画。
- **统一作废入口 `window.main_invalidate_stroke_geometry_caches()`**：任何原地改写笔画坐标/线宽的路径必须调用。

### PDF 阅读器（bdaf163）
- **批注缩放后整片消失（重点缺陷）**：`_scale_page_annotations` 原地改写笔画坐标，而三处按笔画对象缓存的渲染几何只认对象标识 → 重绘按旧坐标落笔，位移越过瓦片边界即整块可见瓦片空白（实测缩放往返后 16 块里 10 块空白）。现重建瓦片前调用统一作废入口。
- 新增重做按钮与 `Ctrl+Z/Y` 快捷键；撤销按钮图标修正（原 `undo` 图标文件不存在一直裂图 → `reply`）。
- 逐页回收定时器改为每页独立：快速滚动时 A 页的回收定时器不再被 B 页误取消。

### 撤销/重做链路与小黑板（36af9d6）
- **重做链路补全**：`history.js` 新增 `history_handle_redo` 与 `history_peek_redo`；redo 栈加硬上限（50×2）——原 redo_list 只进不出且被持久化，无上限增长。
- **黑板 close() 竞态**：加重入闩 + finally 兜底——原 `open()` 抢入会覆盖 `saved_history_state`（全局撤销历史被黑板栈覆盖），尾段上抛则面板永久关不掉。
- 黑板/绘制引擎 `handle_redo` 接线；关闭时补齐全部定时器/rAF 取消。
- **黑板手掌防误触**：`PinchZoomSourceV2` 补 `startDelayMs` 并随批注/移动模式切换（与阅读器同款容错）。

### 应用层（21a7c2d）
- **遥测开关真正生效**：`reportOnline()` 出口自带开关判断、OOBE 完成上报改走 `telemetryInit`——原唯一判空在零调用的函数里，关开关照样上报 UUID/IP/地理。
- **markdown 链接协议白名单**：`javascript:` 等不可信 href 降级为 `#`（链接来源是 GitHub Release body，属不可信输入）。

---

## 三、安全加固（2fb2210）

| 缺陷 | 修复 |
|---|---|
| `theme_import_vst` Zip Slip——恶意 .vst 可写任意路径 | zip 条目名逐段校验 `..`，解压加单条目/总量体积上限 |
| capabilities `fs:scope` 含全盘 `**` | 移除，仅留 `$HOME/$DESKTOP/$DOCUMENT` 等 |
| CSP 含 `unsafe-eval` | 移除 |
| release 构建开 `devtools` 特性 | 移除 |
| `update_install_release` 可执行任意路径安装包 | 限制只能执行更新目录内的文件 |
| 遥测 http 命令无限制 | 加域名白名单 |
| `file_md5` 未校验 | 强制 32 位十六进制 + 文件名消毒 |
| `config.json` 并发写入互相覆盖 | 加写锁（Mutex） |
| 主题预览后端命令不存在 → 预览永远空白 | 新增 `theme_get_preview`（canonicalize 防穿越 + 4MB 上限），预览图从此真正显示 |
| 孤儿镜像命令 | 删除 `mirror_update_state` / `mirror_fetch_state` |

---

## 四、代码清理（ac13a74 / c44a1e9）

- 删除零引用死函数约 230 行（`main_load_image` / `main_save_photo` / `main_update_source` 等 7 个）、死参数 `renderScale` 及其空转逻辑、`historyCompactor` 死依赖、`.draw-overlay` 死样式。
- 删除整模块 `palm-eraser/`（162 行零引用）。
- `developer-options`：`window.__documentReaderManager` 死句柄改正（椭圆笔刷开关此前对阅读器静默失效）。

---

## 五、文档与仓库

- **CHANGELOG.md** 定稿 v0.3.0（2026-09-19）：25 项审计修复按 P0–P3 完整记录（414c69d），后补惯性滑动条目（5a4b7db）。
- **AGENTS.md** 补语法检查命令、dpr-harness 验证说明、grep 须限定 `src/` 的提示。
- **`.gitignore`**：忽略 `.workbuddy/`（工作区数据全部保持本地，不入库）。

---

## 六、提交清单

| 提交 | 类型 | 内容 |
|---|---|---|
| `bbaf81a` | fix(canvas) | 底图缓存逐块同 DPR、基准 DPR 读取自愈、DPR 设置启动回放 |
| `7abc8ff` | perf(canvas) | 渲染热路径几何缓存与统一作废入口 |
| `36af9d6` | fix(history/blackboard) | 重做链路补全、黑板关闭竞态、手掌防误触 |
| `ac13a74` | feat(main) | 主画布撤销/重做 + 全局快捷键、死代码清理 |
| `bdaf163` | fix(reader) | 批注缩放后整片消失、重做按钮、逐页回收定时器 |
| `2fb2210` | fix(security) | Rust 后端与权限配置加固 |
| `21a7c2d` | fix(app) | 遥测开关生效、markdown 链接白名单 |
| `c44a1e9` | chore | 删除 palm-eraser 死模块 |
| `414c69d` | docs | CHANGELOG v0.3.0 |
| `2d07a59` | feat(reader,blackboard) | 惯性滑动 |
| `5a4b7db` | docs | CHANGELOG 补惯性滑动条目 |
| `27443b1` | chore | gitignore 忽略 .workbuddy/ |

## 七、验证方式

- 前端无 bundler / 无测试框架，回归靠自研 CDP 探针（真实 Chromium + `--no-sandbox`）。
- 本次全部改动经五套探针（238 条断言）+ `boot-check` 引导检查 + `cargo check` 验证；关键守卫均做过变异测试（改坏必红）。
- 探针位于本地 `.workbuddy/verify/`（不入库），用法见其中 README。
