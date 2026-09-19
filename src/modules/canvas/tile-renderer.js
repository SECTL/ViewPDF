/**
 * 固定内容尺寸瓦片边长（内容像素）。
 * 网格随画布尺寸动态增删边缘块，已有瓦片的矩形恒定 —— 画布尺寸变化
 * （窗口 resize）不再触发既有内容（笔迹/底图缓存）重光栅化，
 * 这是消除 resize/加载结算冻结的关键（旧 4×4 布局下整帧 ~700ms）。
 */
const TILE_SIZE = 512;
/** 分帧重建：队列剩余不超过该数量时一帧做完，否则每帧至少处理这么多块 */
const TILE_REBUILD_BATCH = 3;
/** 渐进重建泵的单帧时间预算（毫秒）：至少处理 TILE_REBUILD_BATCH 块，
 * 之后在预算内继续，超过立即收手留给下一帧 */
const TILE_REBUILD_FRAME_BUDGET_MS = 6;

class TileRenderer {
    constructor(options) {
        this.dirty = new Set();
        this.tileInfos = [];
        this._lastDprUpdateScale = 0;
        this._pendingDpr = null;
        this._rebuildRafId = null;
        this._queuedUpgradeKeys = new Set();
        this._quadtree = null;
        this._baseCaches = new Map();
        this._baseCacheLoadId = 0;
        // 最近一次整体重算底图缓存时的视图缩放（诊断用，不参与判定）
        this._baseCacheDpr = 0;
        this._dprSettleTimerId = null;
        this._DPR_SETTLE_MS = 300;
        this._idleShrinkTimerId = null;
        this._IDLE_SHRINK_MS = 2000;
        this._strokeVersion = 0;
        this._builtStrokeVersion = -1;
        this._strokeIndex = null;
        this._strokeIndexVersion = -1;
        this._dirtyDrainIdleId = null;
        this._destroyed = false;

        // 渐进重建队列：DPR 升级不再一帧内全量 recreate，
        // 否则 16 块画布同时 realloc + 全量重绘必然掉帧，且中间态的
        // 拉伸快照会被合成出去，表现为"先糊一下再变清"。
        this._rebuildQueue = null;
        this._rebuildRafId = null;
        this._rebuildTargetDpr = null;
        // 最近一次已知的视图缩放，供 idle 回收时计算目标 DPR
        this._lastScale = 1;
        // 最近一次视图检查时间（update_visible_tile_dpr 触达），idle 回收避让用
        this._lastCheckAt = 0;
        // 快照画布池：复用 _recreate_tile 的临时 canvas，减少 GC
        this._snapshotPool = [];
        this._SNAPSHOT_POOL_MAX = 3;

        // 诊断钩子：由宿主（阅读器）注入，(event, data) => void；受 drDiag 开关门控
        this.diag_hook = null;

        // 离屏 canvas 池：复用 add_stroke 多 tile 预渲染 canvas，减少 GC 压力
        this._offscreen_pool = [];
        this._OFFSCREEN_POOL_MAX = 2;

        this._strokeHistoryRef = options?.strokeHistoryRef || null;
        this._getVisibleRectFn = options?.getVisibleRect || null;
        this._canvasW = options?.canvasW || null;
        this._canvasH = options?.canvasH || null;
        this._skipBaseCache = options?.skipBaseCache || false;

        // 动态网格：init_tiles/resize_grid 按 TILE_SIZE × 画布尺寸生成，
        // 已有瓦片矩形恒定，画布尺寸变化只增删边缘块
        this._gridCols = 0;
        this._gridRows = 0;
        this._tileMap = new Map();
    }

    _get_stroke_history() {
        return this._strokeHistoryRef || window.state.strokeHistory;
    }

    /**
     * 获取 stroke 按原始顺序的索引 Map，带版本缓存。
     * rebuild_tile 中排序需要按原始顺序，但四叉树不保证顺序，
     * 因此建立 stroke → index 映射。缓存避免每次 tile 重建都遍历全部 strokes。
     */
    _get_or_build_stroke_index() {
        const strokes = this._get_stroke_history();
        const version = this._strokeVersion;
        if (this._strokeIndexVersion !== version) {
            this._strokeIndex = new Map();
            for (let i = 0; i < strokes.length; i++) {
                this._strokeIndex.set(strokes[i], i);
            }
            this._strokeIndexVersion = version;
        }
        return this._strokeIndex;
    }

    _get_canvas_w() {
        return Math.max(1, this._canvasW || window.DRAW_CONFIG.canvasW || 1);
    }

    _get_canvas_h() {
        return Math.max(1, this._canvasH || window.DRAW_CONFIG.canvasH || 1);
    }

    _cancel_dpr_settle() {
        if (this._dprSettleTimerId !== null) {
            clearTimeout(this._dprSettleTimerId);
            this._dprSettleTimerId = null;
        }
    }

    _schedule_dpr_update(scale, force) {
        // 无论走哪条分支都先记录视图缩放：渐进泵的目标漂移检查
        // 以 _lastScale 为准（缩放中冻结分支不改队列，靠此让泵自行中止）
        if (scale != null) this._lastScale = scale;
        // 手势进行中：冻结重建。此时目标 DPR 每帧都在变，重建完立刻作废，
        // 且一帧内 realloc + 全量重绘必然掉帧。推迟到手势结束后再算一次。
        const rc = window.ResolutionController;
        if (!force && rc && rc.is_interacting) {
            this._cancel_dpr_settle();
            this._dprSettleTimerId = setTimeout(() => {
                this._dprSettleTimerId = null;
                this._schedule_dpr_update(scale, force);
            }, rc.interaction_remain_ms() + 40);
            return;
        }

        const targetDpr = this._calc_target_dpr(scale);

        // 只扫可见瓦片：dpr 与目标不符（升或降）才触发重建。
        //  - 升级：分辨率不足，补清晰度
        //  - 降级：缩小后目标低于当前 dpr，及时回收，节省显存与合成带宽
        // 不可见瓦片一律不在交互路径处理（不预升级、不重建），
        // 其显存回收由静止后的 idle-shrink 一次性完成。
        const keys = this.get_visible_keys();
        let needChange = false;
        let invisibleOverSupplied = false;
        for (const info of this.tileInfos) {
            if (keys.has(info.key)) {
                if (info.dpr !== targetDpr) { needChange = true; break; }
            } else if (info.dpr > 1) {
                invisibleOverSupplied = true;
            }
        }
        if (!needChange) {
            // 可见区已达标：无需重建。但不可见瓦片若仍占用高分辨率，
            // 交给 idle-shrink 在静止后回收（零交互开销）。
            if (invisibleOverSupplied) this._schedule_idle_shrink();
            return;
        }

        // 注：目标经步进量化后，相邻目标差恒 ≥ 1 个 step，传统"未跨步进不重建"
        // 迟滞形同虚设；防抖由手势冻结（上方分支）+ settle 定时承担。
        // 目标与上次一致（纯平移）时必须放行：新进入视野的低分辨率瓦片
        // 依赖此路径补齐分辨率。
        this._lastDprUpdateScale = scale;

        this._cancel_pending_rebuild();
        this._pendingDpr = targetDpr;
        this._rebuildRafId = requestAnimationFrame(() => this._apply_dpr_update());
    }

    /**
     * 底图缓存的**像素尺寸必须等于瓦片的像素尺寸**，即 rect × 瓦片 dpr。
     *
     * 此前这里恒按 rect（1x）分配，再由 rebuild_tile 在 dpr 变换下贴回瓦片：
     * 底图被放大 dpr 倍，而笔迹是矢量按 dpr 重绘 —— 同一张瓦片里「图片」与
     * 「批注」的有效分辨率差 dpr 倍，缩放越高差得越远。底图源本身可能已带
     * dpr 级细节（压缩快照是按 calc_tile_dpr 渲染出来的），按 1x 缓存等于
     * 先把这些细节丢掉再放大，属于纯粹的画质损失，换不来显存收益。
     *
     * 逐块比对而非整体早退：瓦片 dpr 由渐进重建队列逐个改动，缓存必须跟着
     * 每块自己的 dpr 走，不能只看最近一次整体目标。
     */
    _update_base_cache() {
        if (this._skipBaseCache) return;
        const img = window.state.baseImageObj;
        const loadId = window.state.baseImageLoadId || 0;
        if (!img) {
            this._clear_base_caches();
            this._baseCacheLoadId = loadId;
            return;
        }
        for (const info of this.tileInfos) {
            const dpr = info.dpr || 1;
            const entry = this._baseCaches.get(info.key);
            // 源未换且该块缓存已是本块当前 dpr：无需重画
            if (entry && entry.dpr === dpr && entry.loadId === loadId) continue;
            this._build_base_cache_entry(info, img, dpr, loadId);
        }
        this._baseCacheLoadId = loadId;
        this._baseCacheDpr = this._lastScale || 0;
    }

    /**
     * 按给定 dpr 重建单块底图缓存。dpr 变换 + 「源矩形取内容坐标」的组合
     * 与 rebuild_tile 同构：源图只在 dpr 倍下采样一次，不做二次拉伸。
     * @returns {{canvas:HTMLCanvasElement, ctx:CanvasRenderingContext2D, dpr:number, loadId:number}}
     */
    _build_base_cache_entry(info, img, dpr, loadId) {
        const rect = info.rect;
        const w = Math.max(1, Math.ceil(rect.width * dpr));
        const h = Math.max(1, Math.ceil(rect.height * dpr));
        let entry = this._baseCaches.get(info.key);
        if (!entry) {
            entry = { canvas: document.createElement('canvas'), ctx: null, dpr: 0, loadId: -1 };
            this._baseCaches.set(info.key, entry);
        }
        const canvas = entry.canvas;
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        let ctx = entry.ctx;
        if (!ctx) {
            ctx = canvas.getContext('2d');
            entry.ctx = ctx;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);
        ctx.drawImage(img, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        entry.dpr = dpr;
        entry.loadId = loadId;
        return entry;
    }

    /**
     * 取该块当前 dpr 对应的底图缓存，缺失/过期就地补建。
     * rebuild_tile 走此入口：渐进重建队列先改 info.dpr 再调 rebuild_tile，
     * 而批量 _update_base_cache 发生在改之前——中间那一帧会读到旧 dpr 的
     * 缓存。宁可此处补一次，也不能让底图被静默拉伸。
     */
    _ensure_base_cache(info, dpr) {
        if (this._skipBaseCache) return null;
        const img = window.state.baseImageObj;
        if (!img) return null;
        const loadId = window.state.baseImageLoadId || 0;
        const entry = this._baseCaches.get(info.key);
        if (entry && entry.dpr === dpr && entry.loadId === loadId) return entry;
        return this._build_base_cache_entry(info, img, dpr, loadId);
    }

    _clear_base_caches() {
        for (const entry of this._baseCaches.values()) {
            entry.canvas = null;
            entry.ctx = null;
        }
        this._baseCaches.clear();
    }

    invalidate_base_cache() {
        this._clear_base_caches();
    }

    mark_strokes_changed() {
        this._strokeVersion++;
    }

    _build_quadtree() {
        if (this._strokeVersion === this._builtStrokeVersion) return;
        this._builtStrokeVersion = this._strokeVersion;
        const strokes = this._get_stroke_history();
        if (!strokes || strokes.length === 0) {
            this._quadtree = null;
            return;
        }
        const boundary = {
            x: 0,
            y: 0,
            width: this._get_canvas_w(),
            height: this._get_canvas_h()
        };
        this._quadtree = new window.StrokeQuadTree(boundary);
        this._quadtree.build(strokes);
    }

    get_tile_dimensions() {
        // 固定内容尺寸：瓦片矩形不随画布尺寸变化
        return { w: TILE_SIZE, h: TILE_SIZE };
    }

    get_tile_rect(col, row) {
        const cw = this._get_canvas_w();
        const ch = this._get_canvas_h();
        return {
            x: col * TILE_SIZE,
            y: row * TILE_SIZE,
            width: Math.min(TILE_SIZE, cw - col * TILE_SIZE),
            height: Math.min(TILE_SIZE, ch - row * TILE_SIZE)
        };
    }

    tile_key(col, row) { return `${col}_${row}`; }

    _calc_target_dpr(scale, opts) {
        // 动态分辨率计算的唯一来源：ResolutionController。
        // 此前此处与 batch-draw 的 overlay、阅读器的页面栅格化各写一份，
        // 改动设置时易漏改一处。
        const res = window.ResolutionController;
        if (res && typeof res.calc_tile_dpr === 'function') {
            return res.calc_tile_dpr(scale, opts);
        }
        // 控制器缺失属于加载顺序被破坏（index.html 保证 Wave 0 先加载它）。
        // 此处刻意**不复刻**一套公式：复刻出的第二份实现会与控制器的口径静默
        // 漂移——而"改了设置只生效一半"正是这条分支存在时最容易出现的故障。
        // 退回 1x 是安全降级，报错让加载顺序问题当场可见。
        console.error('[TileRenderer] ResolutionController 未就绪，瓦片层降级为 1x');
        return 1;
    }

    /**
     * 诊断探针：统计含非空像素（笔迹）的 tile 数量。
     * 阅读器 tiles 为透明底（skipBaseCache），alpha>0 即有笔迹。
     * 通过 48×48 缩略采样读取，开销可忽略。
     */
    diag_content_ratio() {
        if (!this._diag_probe) {
            this._diag_probe = document.createElement('canvas');
            this._diag_probe.width = 48;
            this._diag_probe.height = 48;
        }
        const pc = this._diag_probe.getContext('2d', { willReadFrequently: true });
        let tilesWithContent = 0;
        let tilesAlive = 0;
        for (const info of this.tileInfos) {
            const cv = info.canvas;
            if (!cv || !cv.width || !cv.height) continue;
            tilesAlive++;
            try {
                pc.setTransform(1, 0, 0, 1, 0, 0);
                pc.clearRect(0, 0, 48, 48);
                pc.drawImage(cv, 0, 0, 48, 48);
                const d = pc.getImageData(0, 0, 48, 48).data;
                for (let i = 3; i < d.length; i += 4) {
                    if (d[i] !== 0) { tilesWithContent++; break; }
                }
            } catch (_) {}
        }
        return { tilesWithContent, tilesAlive };
    }

    _create_tile_canvas(info, dpr) {
        const rect = info.rect;
        const canvas = document.createElement('canvas');
        canvas.className = 'canvas-tile';
        canvas.width = Math.ceil(rect.width * dpr);
        canvas.height = Math.ceil(rect.height * dpr);
        canvas.style.width = rect.width + 'px';
        canvas.style.height = rect.height + 'px';
        canvas.style.left = rect.x + 'px';
        canvas.style.top = rect.y + 'px';

        const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        return { canvas, ctx };
    }

    _recreate_tile(info, newDpr, keepSnapshot = true) {
        const canvas = info.canvas;
        const ctx = info.ctx;
        if (!canvas || !ctx) return;

        // 快照作占位，防止 rebuild 未覆盖时 tile 以空白状态滞留。
        // 原子重建（recreate 后同帧立即 rebuild）时跳过：那一次 drawImage
        // 放大整块瓦片的开销不小，且占位图必然被随后 rebuild 清掉。
        let snapshot = null;
        if (keepSnapshot && canvas.width > 0 && canvas.height > 0) {
            snapshot = this._acquire_snapshot(canvas.width, canvas.height);
            snapshot.getContext('2d').drawImage(canvas, 0, 0);
        }

        canvas.width = Math.ceil(info.rect.width * newDpr);
        canvas.height = Math.ceil(info.rect.height * newDpr);
        ctx.imageSmoothingEnabled = false;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 写入旧内容（scaled）作为占位图，rebuild_tile 会覆盖精确内容
        if (snapshot) {
            ctx.save();
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(snapshot, 0, 0, canvas.width, canvas.height);
            ctx.restore();
            ctx.imageSmoothingEnabled = false;
            this._release_snapshot(snapshot);
        }

        info.dpr = newDpr;
        this.dirty.add(info.key);
        this.diag_hook?.('recreate', { key: info.key, dpr: newDpr });
    }

    _acquire_snapshot(w, h) {
        const c = this._snapshotPool.pop() || document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
    }

    _release_snapshot(c) {
        if (this._snapshotPool.length < this._SNAPSHOT_POOL_MAX) {
            this._snapshotPool.push(c);
        }
    }

    update_visible_tile_dpr(scale, force, skipSettle) {
        if (scale != null) this._lastScale = scale;
        // 最近一次视图检查时间：idle 回收用它避让一切变换活动（含纯平移），
        // 防止平移过程中段突然回收不可见瓦片造成 realloc 抖动
        this._lastCheckAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (skipSettle) {
            this._cancel_dpr_settle();
            this._schedule_dpr_update(scale, force);
            return;
        }
        this._cancel_dpr_settle();
        this._dprSettleTimerId = setTimeout(() => {
            this._dprSettleTimerId = null;
            this._schedule_dpr_update(scale, force);
        }, this._DPR_SETTLE_MS);
    }

    cancel_idle_shrink() {
        this._cancel_idle_shrink();
    }

    _cancel_pending_rebuild() {
        this._cancel_dpr_settle();
        this._cancel_dirty_drain();
        this._cancel_rebuild_queue();
        if (this._rebuildRafId !== null) {
            cancelAnimationFrame(this._rebuildRafId);
            this._rebuildRafId = null;
        }
        this._pendingDpr = null;
    }

    _cancel_idle_shrink() {
        if (this._idleShrinkTimerId != null) {
            clearTimeout(this._idleShrinkTimerId);
            this._idleShrinkTimerId = null;
        }
    }

    /**
     * 静止后回收显存。分两类：
     *   - 不可见瓦片：直接回收到 dpr=1
     *   - 可见但过度供给的瓦片（缩小后仍在用高 dpr）：降到当前目标
     * 降到「目标 dpr」在视觉上是无损的——目标本就等于 scale × 显示 DPR，
     * 即在当前缩放下刚好铺满物理像素，再高只是浪费显存。
     * 整段在同一个同步块内 recreate + rebuild，不存在中间态。
     */
    _schedule_idle_shrink() {
        this._cancel_idle_shrink();
        this._idleShrinkTimerId = setTimeout(() => {
            this._idleShrinkTimerId = null;
            if (this._destroyed) return;
            const rc = window.ResolutionController;
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            // 仍在交互（缩放手势保持期内）或近期有任何视图检查活动（平移/缩放
            // 都会触碰 update_visible_tile_dpr）则顺延：回收只做给真正静止后的
            // 不可见瓦片，绝不打断变换中的视图
            if ((rc && rc.is_interacting) ||
                (this._lastCheckAt && now - this._lastCheckAt < 600)) {
                this._schedule_idle_shrink();
                return;
            }
            const keys = this.get_visible_keys();
            const targetDpr = this._calc_target_dpr(this._lastScale || 1);
            let anyShrunk = false;
            for (const info of this.tileInfos) {
                if (!keys.has(info.key)) {
                    if (info.dpr > 1) {
                        // 保留旧内容作占位（等比缩入新画布）：块此后进入视野时
                        // 不会短暂空白，等下次重建刷新为精确内容
                        this._recreate_tile(info, 1, true);
                        anyShrunk = true;
                    }
                } else if (info.dpr > targetDpr) {
                    this._recreate_tile(info, targetDpr, false);
                    anyShrunk = true;
                }
            }
            if (anyShrunk) {
                this.rebuild_visible(keys);
                // 回收产生的不可见脏块在 idle 分片补齐，不留长期滞留
                this._drain_dirty_tiles(keys);
            }
        }, this._IDLE_SHRINK_MS);
    }

    _apply_dpr_update() {
        this._rebuildRafId = null;
        const targetDpr = this._pendingDpr;
        this._pendingDpr = null;
        if (targetDpr == null) return;

        // 中断上一轮未完成的队列（目标 DPR 可能已变化）
        this._cancel_rebuild_queue();

        const keys = this.get_visible_keys();
        this.diag_hook?.('dpr-update', { dpr: targetDpr, keys: keys.size });

        // DPR 已达标但内容 dirty 的可见瓦片：直接重绘，不动画布尺寸
        this.rebuild_visible(keys);

        // 需要变更 DPR 的可见瓦片（升或降）排进渐进队列，不在此帧批量 realloc。
        // 每块在轮到时于同一帧内原子完成 realloc → 精确重绘，未轮到的保持
        // 原分辨率原内容，因此不存在"先变糊"。不可见瓦片不排队、不处理，
        // 节约交互期性能；其显存回收由 idle-shrink 完成。
        const vr = this._getVisibleRectFn ? this._getVisibleRectFn() : null;
        const queue = [];
        for (const info of this.tileInfos) {
            if (!info.canvas || !info.ctx) continue;
            if (!keys.has(info.key)) continue;
            if (info.dpr === targetDpr) continue;
            queue.push(info);
        }
        if (vr && queue.length > 1) {
            const cx = vr.x + vr.width / 2;
            const cy = vr.y + vr.height / 2;
            queue.sort((a, b) => this._tile_dist2(a, cx, cy) - this._tile_dist2(b, cx, cy));
        }

        this._rebuildQueue = queue;
        this._rebuildTargetDpr = targetDpr;
        for (const info of this._rebuildQueue) {
            this._queuedUpgradeKeys.add(info.key);
        }
        this._pump_rebuild_queue();
    }

    _tile_dist2(info, cx, cy) {
        const r = info.rect;
        const dx = r.x + r.width / 2 - cx;
        const dy = r.y + r.height / 2 - cy;
        return dx * dx + dy * dy;
    }

    _cancel_rebuild_queue() {
        if (this._rebuildRafId !== null) {
            cancelAnimationFrame(this._rebuildRafId);
            this._rebuildRafId = null;
        }
        this._rebuildQueue = null;
        this._rebuildTargetDpr = null;
        this._queuedUpgradeKeys.clear();
    }

    /**
     * 分帧消费重建队列。每块瓦片的「realloc → 精确重绘」在同一帧内原子完成：
     * 未轮到的瓦片保持原分辨率原内容，因此不会出现"先变糊再变清"。
     */
    _pump_rebuild_queue() {
        this._rebuildRafId = null;
        const targetDpr = this._rebuildTargetDpr;
        const q = this._rebuildQueue;
        if (this._destroyed || !q || targetDpr == null || q.length === 0) {
            this._finish_rebuild_queue();
            return;
        }

        this._build_quadtree();
        this._update_base_cache();

        // 每帧以最新可见性过滤队列：建队后视图可能已变化，
        // 已滚出视野的瓦片跳过（它是不可见块，显存交给 idle 回收），
        // 仍可见的才继续重建——确保不会把可见块按不可见块对待
        const liveKeys = this.get_visible_keys();
        for (let i = q.length - 1; i >= 0; i--) {
            if (!liveKeys.has(q[i].key)) {
                this._queuedUpgradeKeys.delete(q[i].key);
                q.splice(i, 1);
            }
        }
        if (q.length === 0) {
            this._finish_rebuild_queue();
            return;
        }
        // 目标 DPR 已漂移（期间缩放目标变化）：中止本轮，由调度路径按新目标重排
        if (this._calc_target_dpr(this._lastScale || 1) !== targetDpr) {
            this._finish_rebuild_queue();
            return;
        }

        // 剩余的预算：至少处理 TILE_REBUILD_BATCH 块；之后按帧预算继续，
        // 超过单帧预算立即收手留给下一帧。瓦片缩小后单块更便宜、可见块数
        // 更多，固定块数预算在大墨量下仍可能超帧预算 —— 按时间计量才能
        // 保证结算期每帧都落在预算内，用户无感。
        const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        let processed = 0;
        while (q.length > 0 && !this._destroyed) {
            const info = q.shift();
            this._queuedUpgradeKeys.delete(info.key);
            if (this._destroyed) break;
            if (!liveKeys.has(info.key)) continue;
            if (info.dpr === targetDpr || !info.ctx || !info.canvas) continue;
            try {
                this._recreate_tile(info, targetDpr, false);
                this.rebuild_tile(info);
            } catch (e) {
                console.error('tile-renderer: DPR 重建失败', info.key, e);
                this.dirty.add(info.key);
            }
            processed++;
            if (processed >= TILE_REBUILD_BATCH &&
                (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 >= TILE_REBUILD_FRAME_BUDGET_MS) {
                break;
            }
        }

        if (q.length > 0 && !this._destroyed) {
            this._rebuildRafId = requestAnimationFrame(() => this._pump_rebuild_queue());
        } else {
            this._finish_rebuild_queue();
        }
    }

    _finish_rebuild_queue() {
        this._rebuildQueue = null;
        this._rebuildTargetDpr = null;
        this._queuedUpgradeKeys.clear();
        // 兜底：仍为 dirty 的不可见 tile 分片惰性补建，防止空白 tile 长期滞留
        this._drain_dirty_tiles(new Set());
        this._schedule_idle_shrink();
    }

    /**
     * 分片重建残留 dirty 的不可见 tile（idle 回调，每片至多 4 块）
     * @param {Set<string>} justHandledKeys - 本轮已处理的键，避免重复
     */
    _drain_dirty_tiles(justHandledKeys) {
        const remaining = [];
        for (const info of this.tileInfos) {
            if (this.dirty.has(info.key) && !justHandledKeys.has(info.key)) {
                remaining.push(info);
            }
        }
        if (remaining.length === 0) return;

        this._cancel_dirty_drain();
        const slice = () => {
            this._dirtyDrainIdleId = null;
            if (this._destroyed) return;
            this._build_quadtree();
            let budget = 4;
            while (budget-- > 0 && remaining.length) {
                const info = remaining.shift();
                if (this.dirty.has(info.key) && info.ctx && info.canvas) this.rebuild_tile(info);
            }
            if (remaining.length > 0 && !this._destroyed) {
                if (window.requestIdleCallback) {
                    this._dirtyDrainIdleId = window.requestIdleCallback(slice, { timeout: 800 });
                } else {
                    this._dirtyDrainIdleId = setTimeout(slice, 30);
                }
            }
        };
        if (window.requestIdleCallback) {
            this._dirtyDrainIdleId = window.requestIdleCallback(slice, { timeout: 800 });
        } else {
            this._dirtyDrainIdleId = setTimeout(slice, 30);
        }
    }

    _cancel_dirty_drain() {
        if (this._dirtyDrainIdleId !== null && this._dirtyDrainIdleId !== undefined) {
            if (window.cancelIdleCallback) window.cancelIdleCallback(this._dirtyDrainIdleId);
            else clearTimeout(this._dirtyDrainIdleId);
            this._dirtyDrainIdleId = null;
        }
    }

    /**
     * 全量初始化网格（加载源 / 清空画布等「内容作废」场景）：
     * 清空既有瓦片后按当前画布尺寸重建。
     */
    init_tiles(wrapper, initialScale) {
        // 复位销毁闩锁：主画布路径是「destroy_all() 后复用同一实例 init_tiles()」
        // （加载源、清空绘制、以及窗口尺寸变化重建网格都走这条）。_destroyed
        // 一旦为 true，DPR 调度、dirty 补帧泵、idle 显存回收会全部静默失效，
        // 表现为「重建之后瓦片再也不升分辨率」。
        this._destroyed = false;
        const scale = initialScale || (window.state ? (window.state.scale || 1) : 1);
        this._lastScale = scale;
        const existing = wrapper.querySelectorAll('.canvas-tile');
        for (const el of existing) el.remove();

        this.tileInfos = [];
        this._tileMap = new Map();
        this._gridCols = 0;
        this._gridRows = 0;
        this.dirty.clear();
        this.resize_grid(wrapper);
    }

    /**
     * 画布尺寸变化时的网格增删（窗口 resize / 页面尺寸变化）。
     *
     * 与 init_tiles 的本质区别：**保留内容仍然有效的瓦片**。
     * 瓦片是固定内容尺寸（TILE_SIZE），已有瓦片的矩形与内容坐标恒定 ——
     * 画布变大/变小只影响网格边缘：新增块、移除越界块、边缘矩形被
     * 裁剪变化的块才需要重光栅化，其余瓦片零成本保留。
     *
     * @param {HTMLElement} wrapper 瓦片容器
     * @returns {{added:number, removed:number, kept:number}} 网格变化统计
     */
    resize_grid(wrapper) {
        const cw = this._get_canvas_w();
        const ch = this._get_canvas_h();
        const cols = Math.max(1, Math.ceil(cw / TILE_SIZE));
        const rows = Math.max(1, Math.ceil(ch / TILE_SIZE));
        const prev = this._tileMap;
        this._gridCols = cols;
        this._gridRows = rows;

        this.tileInfos = [];
        this._tileMap = new Map();
        const targetDpr = this._calc_target_dpr(this._lastScale || 1);
        let added = 0, kept = 0, changed = 0;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const key = `${c}_${r}`;
                const old = prev.get(key);
                const rect = this.get_tile_rect(c, r);
                if (old && old.canvas && old.ctx) {
                    const sameRect = old.rect.x === rect.x && old.rect.y === rect.y &&
                        old.rect.width === rect.width && old.rect.height === rect.height;
                    if (sameRect) {
                        // 原样保留：内容与底图缓存继续有效，零重绘
                        this.tileInfos.push(old);
                        this._tileMap.set(key, old);
                        kept++;
                        continue;
                    }
                    // 边缘裁剪矩形变化：画布尺寸收缩/扩展导致边缘块被裁剪，
                    // 像素尺寸随之重分配（内容作废），底图缓存一并作废
                    const dpr = old.dpr;
                    old.rect = rect;
                    old.canvas.width = Math.ceil(rect.width * dpr);
                    old.canvas.height = Math.ceil(rect.height * dpr);
                    old.canvas.style.width = rect.width + 'px';
                    old.canvas.style.height = rect.height + 'px';
                    old.canvas.style.left = rect.x + 'px';
                    old.canvas.style.top = rect.y + 'px';
                    // 画布重分配会重置绘图状态，与 _create_tile_canvas/_recreate_tile 保持一致
                    old.ctx.imageSmoothingEnabled = false;
                    old.ctx.lineCap = 'round';
                    old.ctx.lineJoin = 'round';
                    this._baseCaches.delete(key);
                    this.dirty.add(key);
                    this.tileInfos.push(old);
                    this._tileMap.set(key, old);
                    changed++;
                    continue;
                }
                // 新增块
                const info = { col: c, row: r, key, dpr: targetDpr, rect };
                const { canvas, ctx } = this._create_tile_canvas(info, targetDpr);
                if (wrapper) wrapper.appendChild(canvas);
                info.canvas = canvas;
                info.ctx = ctx;
                this.dirty.add(key);
                this.tileInfos.push(info);
                this._tileMap.set(key, info);
                added++;
            }
        }

        // 移除越界块
        for (const [key, info] of prev) {
            if (this._tileMap.has(key)) continue;
            if (info.canvas && info.canvas.parentNode) {
                info.canvas.parentNode.removeChild(info.canvas);
            }
            this._baseCaches.delete(key);
            this.dirty.delete(key);
        }

        // 画布边界变化：四叉树 boundary 随之变化，强制下次全量重建
        this._builtStrokeVersion = -1;

        this.diag_hook?.('resize-grid', { cols, rows, added, removed: prev.size - kept - changed, changed });
        return { added, removed: prev.size - kept - changed, kept };
    }

    for_each_visible(fn) {
        const keys = this.get_visible_keys();
        for (const info of this.tileInfos) {
            if (keys.has(info.key)) {
                fn(info);
            }
        }
    }

    for_each(fn) {
        for (const info of this.tileInfos) {
            fn(info);
        }
    }

    get_visible_keys() {
        const vr = this._getVisibleRectFn ? this._getVisibleRectFn() : window.main_fetch_visible_rect();
        const { w, h } = this.get_tile_dimensions();
        const keys = new Set();
        if (!this._gridCols || !this._gridRows) return keys;
        const sc = Math.max(0, Math.floor(vr.x / w));
        const ec = Math.min(this._gridCols - 1, Math.floor((vr.x + vr.width - 1) / w));
        const sr = Math.max(0, Math.floor(vr.y / h));
        const er = Math.min(this._gridRows - 1, Math.floor((vr.y + vr.height - 1) / h));
        for (let r = sr; r <= er; r++) {
            for (let c = sc; c <= ec; c++) {
                keys.add(this.tile_key(c, r));
            }
        }
        return keys;
    }

    info_for_point(x, y) {
        if (!this._gridCols || !this._gridRows) return undefined;
        const { w, h } = this.get_tile_dimensions();
        const col = Math.min(this._gridCols - 1, Math.max(0, Math.floor(x / w)));
        const row = Math.min(this._gridRows - 1, Math.max(0, Math.floor(y / h)));
        return this._tileMap.get(this.tile_key(col, row));
    }

    infos_for_segment(x1, y1, x2, y2, padding = 0) {
        const { w, h } = this.get_tile_dimensions();
        const minX = Math.min(x1, x2) - padding;
        const maxX = Math.max(x1, x2) + padding;
        const minY = Math.min(y1, y2) - padding;
        const maxY = Math.max(y1, y2) + padding;
        const result = [];
        if (!this._gridCols || !this._gridRows) return result;
        const sc = Math.max(0, Math.floor(minX / w));
        const ec = Math.min(this._gridCols - 1, Math.floor(maxX / w));
        const sr = Math.max(0, Math.floor(minY / h));
        const er = Math.min(this._gridRows - 1, Math.floor(maxY / h));
        for (let r = sr; r <= er; r++) {
            for (let c = sc; c <= ec; c++) {
                const info = this._tileMap.get(this.tile_key(c, r));
                if (info) result.push(info);
            }
        }
        return result;
    }

    rebuild_tile(info) {
        const ctx = info.ctx;
        const rect = info.rect;
        const dpr = info.dpr;
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, -rect.x * dpr, -rect.y * dpr);
        ctx.clearRect(rect.x, rect.y, rect.width, rect.height);

        // 底图缓存与瓦片同 dpr（见 _update_base_cache）；源矩形必须取缓存
        // 自身的像素尺寸，否则 dpr 缓存只被取走左上角 1x 的一块
        const cacheEntry = this._ensure_base_cache(info, dpr);
        if (cacheEntry) {
            const cacheCanvas = cacheEntry.canvas;
            ctx.drawImage(
                cacheCanvas,
                0, 0, cacheCanvas.width, cacheCanvas.height,
                rect.x, rect.y, rect.width, rect.height
            );
        }

        const strokes = this._get_stroke_history();
        let relevant = null;
        if (strokes.length > 0) {
            if (this._quadtree) {
                relevant = Array.from(this._quadtree.query({
                    x: rect.x, y: rect.y,
                    width: rect.width, height: rect.height
                }));
                // 四叉树 Set 不保证插入顺序，必须按原始 strokes 顺序排序
                // 确保橡皮擦 destination-out 在绘制 stroke 之后执行
                if (relevant.length > 1) {
                    const stroke_index = this._get_or_build_stroke_index();
                    relevant.sort((a, b) => stroke_index.get(a) - stroke_index.get(b));
                }
            } else {
                relevant = [];
                for (let i = 0; i < strokes.length; i++) {
                    const s = strokes[i];
                    if (!s.bounds) { relevant.push(s); continue; }
                    const b = s.bounds;
                    if (b.maxX < rect.x || b.minX > rect.x + rect.width ||
                        b.maxY < rect.y || b.minY > rect.y + rect.height) {
                        continue;
                    }
                    relevant.push(s);
                }
            }
            if (relevant.length > 0) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(rect.x, rect.y, rect.width, rect.height);
                ctx.clip();
                if (window.main_reset_context_state) window.main_reset_context_state();
                window.main_render_strokes_to_context(ctx, relevant);
                ctx.restore();
            }
        }

        ctx.restore();
        this.dirty.delete(info.key);
        if (this.diag_hook) {
            this.diag_hook('rebuild', { key: info.key, n: relevant ? relevant.length : 0, hist: strokes.length });
        }
    }

    rebuild_visible(keys) {
        if (!keys) keys = this.get_visible_keys();
        this._build_quadtree();
        this._update_base_cache();
        for (const info of this.tileInfos) {
            if (keys.has(info.key) && this.dirty.has(info.key)) {
                this.rebuild_tile(info);
            }
        }
    }

    rebuild_all() {
        this._build_quadtree();
        this._update_base_cache();
        for (const info of this.tileInfos) {
            if (this.dirty.has(info.key)) {
                this.rebuild_tile(info);
            }
        }
    }

    /**
     * 渐进全量重建：可见块同步重绘保证首屏立即可见，
     * 其余脏块交给 idle 分片（_drain_dirty_tiles，每片 4 块）。
     *
     * 用于「加载 / 换底图 / 清空重绘」这类 mark_all 后的全量重建路径：
     * 旧实现 rebuild_all 同步重绘全部瓦片，大墨量下用户面对一整帧
     * 数百毫秒的白屏冻结；现在首帧只付可见区的钱，其余在空闲期补齐。
     * 注意：调用方若在 drain 完成前同步读取非可见瓦片像素（导出合成），
     * 读到的可能是旧内容 —— 导出属用户操作，间隔远大于 drain 耗时。
     */
    rebuild_progressive() {
        this._build_quadtree();
        this._update_base_cache();
        const keys = this.get_visible_keys();
        for (const info of this.tileInfos) {
            if (keys.has(info.key) && this.dirty.has(info.key)) {
                this.rebuild_tile(info);
            }
        }
        this._drain_dirty_tiles(keys);
    }

    mark_all() {
        for (const info of this.tileInfos) {
            this.dirty.add(info.key);
        }
    }

    mark_visible() {
        const keys = this.get_visible_keys();
        for (const info of this.tileInfos) {
            if (keys.has(info.key)) {
                this.dirty.add(info.key);
            }
        }
    }

    destroy() {
        this._destroyed = true;
        this._cancel_pending_rebuild();
        this._cancel_dpr_settle();
        this._cancel_idle_shrink();
        for (const info of this.tileInfos) {
            if (info.canvas && info.canvas.parentNode) {
                info.canvas.parentNode.removeChild(info.canvas);
            }
            info.canvas = null;
            info.ctx = null;
        }
        this._clear_base_caches();
        this._baseCacheLoadId = 0;
        this._strokeIndex = null;
        this._strokeIndexVersion = -1;
        this.dirty.clear();
        this._offscreen_pool.length = 0;
    }

    destroy_all() {
        this.destroy();
    }

    add_stroke(stroke) {
        // 允许单点笔画（点击产生的圆点）：stroke-renderer 以零长线段+圆头绘制，
        // 此前 points.length<2 直接返回会导致点在实时预览可见、翻页后消失
        if (!stroke || !stroke.points || stroke.points.length < 1) return;
        // 关键：递增版本号。否则 _get_or_build_stroke_index 的缓存不会感知新笔画，
        // tile 重建排序时新笔画索引为 undefined（NaN 比较），重放顺序错乱——
        // 多次绘制/擦除后早前的批注会在重建时被错误覆盖而"消失"
        this._strokeVersion++;
        if (this._quadtree) {
            this._quadtree.insert(stroke);
        }
        // 增量路径：新笔画已 insert 进四叉树，同步版本号使后续 rebuild_tile 命中
        // _build_quadtree / _get_or_build_stroke_index 的版本缓存，不再 O(n) 全量重建。
        // 仅当四叉树尚未建立（首次笔画）时置 -1，令下次 rebuild 全量 build（仅此一笔）。
        // 注意：undo/redo/clear 走 mark_strokes_changed（_strokeVersion++ 但不同步），
        // 下次 rebuild 仍会全量重建——保持与既有行为完全一致，仅优化"新增笔画"热路径。
        {
            const _hist = this._get_stroke_history();
            if (this._quadtree) {
                this._builtStrokeVersion = this._strokeVersion;
                if (!this._strokeIndex) this._strokeIndex = new Map();
                this._strokeIndex.set(stroke, _hist.length - 1);
                this._strokeIndexVersion = this._strokeVersion;
            } else {
                this._builtStrokeVersion = -1;
                this._strokeIndexVersion = -1;
            }
        }
        const halfWidth = Math.max(stroke.lineWidth || 5, stroke.eraserSize || 5) / 2;
        const infos = this.infos_for_segment(
            stroke.bounds.minX, stroke.bounds.minY,
            stroke.bounds.maxX, stroke.bounds.maxY,
            halfWidth
        );
        if (infos.length === 0) return;

        const uniqueKeys = new Set(infos.map(i => i.key));

        /* 单 tile —— 直接渲染，无需 offscreen 中间层 */
        if (infos.length === 1) {
            const info = infos[0];
            const ctx = info.ctx;
            const rect = info.rect;
            const dpr = info.dpr;
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, -rect.x * dpr, -rect.y * dpr);
            window.main_render_strokes_to_context(ctx, [stroke]);
            ctx.restore();
            this.dirty.delete(info.key);
            return;
        }

        /* 多 tile —— 同 DPR 前提下用 offscreen canvas 预渲染后 blit */
        /* 注：不存在多显示器混合 DPR 场景，无需对 DPR 分组 */
        const mainDpr = infos[0].dpr;
        if (infos.some(i => i.dpr !== mainDpr)) {
            for (const info of this.tileInfos) {
                if (!uniqueKeys.has(info.key)) continue;
                const ctx = info.ctx;
                const rect = info.rect;
                const dpr = info.dpr;
                ctx.save();
                ctx.setTransform(dpr, 0, 0, dpr, -rect.x * dpr, -rect.y * dpr);
                window.main_render_strokes_to_context(ctx, [stroke]);
                ctx.restore();
                this.dirty.delete(info.key);
            }
            return;
        }

        /* 多 tile 同 DPR —— 预渲染到 offscreen canvas，drawImage 复合各 tile */
        const sx = stroke.bounds.minX - halfWidth;
        const sy = stroke.bounds.minY - halfWidth;
        const sw = stroke.bounds.maxX - stroke.bounds.minX + halfWidth * 2;
        const sh = stroke.bounds.maxY - stroke.bounds.minY + halfWidth * 2;

        // 从池中获取或创建 offscreen canvas
        const offscreen_w = Math.ceil(sw * mainDpr);
        const offscreen_h = Math.ceil(sh * mainDpr);
        let offscreen;
        for (let i = this._offscreen_pool.length - 1; i >= 0; i--) {
            const c = this._offscreen_pool[i];
            if (c.width >= offscreen_w && c.height >= offscreen_h) {
                offscreen = this._offscreen_pool.splice(i, 1)[0];
                break;
            }
        }
        if (!offscreen) {
            offscreen = document.createElement('canvas');
        }
        offscreen.width = offscreen_w;
        offscreen.height = offscreen_h;
        const offCtx = offscreen.getContext('2d');
        offCtx.setTransform(mainDpr, 0, 0, mainDpr, -sx * mainDpr, -sy * mainDpr);
        window.main_render_strokes_to_context(offCtx, [stroke]);

        /* 将预渲染结果 blit 到各 tile，仅绘制 tile 与 stroke 交集区域 */
        for (const info of this.tileInfos) {
            if (!uniqueKeys.has(info.key)) continue;
            const ctx = info.ctx;
            const rect = info.rect;
            const clipX = Math.max(rect.x, sx);
            const clipY = Math.max(rect.y, sy);
            const clipR = Math.min(rect.x + rect.width, sx + sw);
            const clipB = Math.min(rect.y + rect.height, sy + sh);
            const clipW = Math.ceil(clipR - clipX);
            const clipH = Math.ceil(clipB - clipY);
            if (clipW <= 0 || clipH <= 0) continue;

            ctx.save();
            ctx.setTransform(mainDpr, 0, 0, mainDpr, -rect.x * mainDpr, -rect.y * mainDpr);
            ctx.drawImage(
                offscreen,
                Math.round((clipX - sx) * mainDpr), Math.round((clipY - sy) * mainDpr),
                clipW * mainDpr, clipH * mainDpr,
                clipX, clipY, clipW, clipH
            );
            ctx.restore();
            this.dirty.delete(info.key);
        }

        // 归还 offscreen canvas 到池中（不超过上限）
        if (this._offscreen_pool.length < this._OFFSCREEN_POOL_MAX) {
            this._offscreen_pool.push(offscreen);
        }
    }
}

window.TileRenderer = TileRenderer;
window.tileRenderer = new TileRenderer();
