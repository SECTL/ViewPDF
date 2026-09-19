/**
 * OverlayManager —— 实时预览覆盖层（屏幕空间 canvas）的唯一定义与管理。
 *
 * 从 RealtimeBatchDrawManager 中抽取，供阅读器 / 小黑板复用。
 *
 * 注：主画布**当前没有实时预览覆盖层**（笔迹直接落瓦片层），因此本类没有
 * "由容器自建 canvas" 的入口——覆盖层一律由调用方创建后经 attach() 注入。
 *
 * 职责：
 *   - 持有 overlay canvas / ctx / dpr（**唯一所有者**：像素释放与 DOM 摘除都在此）
 *   - 依据 ResolutionController 计算动态 DPR（屏幕空间，以显示 DPR 为上限）
 *   - 视图变换（setTransform）由外部注入的锚点提供
 *   - 展示尺寸与 DPR 只有一条写入路径（_apply_geometry）：改像素尺寸必然
 *     清空内容，故一律走「快照 → 重设 → 回写」，并在无变化时提前返回
 *   - 局部 / 全量清除、缩放期间显隐
 *
 * 注：曾经存在一套"笔画进行中把 DPR 调整顺延到 end_stroke"的机制
 * （begin_stroke/end_stroke/request_dpr + 迟滞定时器）。_apply_geometry
 * 的内容快照已独立保证"未提交笔迹不闪断"，顺延机制失去存在理由，且会让
 * 笔画期间的真实尺寸变化被无声丢弃，故整体移除：笔画进行中调用 resize() /
 * sync_dpr_now() 现在立即生效，未提交的预览由快照续上。
 */
class OverlayManager {
    constructor(options = {}) {
        this.resolution = options.resolution || null; // 缺省运行时取 window.ResolutionController
        this.canvas = null;
        this.ctx = null;
        this.dpr = 1;

        this._displayW = 0;
        this._displayH = 0;

        this.invalidate_transform();

        this._transformProvider = null;
        this._warnedNoProvider = false;

        this._contextAttributes = options.contextAttributes || { willReadFrequently: false };
    }

    _res() {
        return this.resolution || window.ResolutionController;
    }

    _calc_dpr(scale) {
        const res = this._res();
        if (res && res.calc_overlay_dpr) return res.calc_overlay_dpr(scale);
        // 控制器缺失属于加载顺序被破坏（index.html 已保证 Wave 0 先加载它）。
        // 此处刻意**不复刻**一套公式：复刻出的第二份实现会与控制器的口径静默
        // 漂移，让"唯一事实来源"名存实亡。退回 1x 是安全降级，报错让问题可见。
        console.error('[OverlayManager] ResolutionController 未就绪，覆盖层降级为 1x');
        return 1;
    }

    /**
     * 注入任意的视图变换提供器（底层原语）。
     * 返回内容原点 (0,0) 在屏幕上的位置与缩放：{ scale, originX, originY }。
     * 绝大多数调用方要的是"以某元素的实时矩形为锚"，直接用 set_rect_anchor 即可。
     */
    set_transform_provider(fn) {
        this._transformProvider = fn;
    }

    /**
     * 以「锚点元素的实时屏幕矩形」为变换锚点（阅读器 / 小黑板共用写法）。
     *
     * 内容原点 (0,0) 的屏幕位置 = 锚点元素 getBoundingClientRect() 的 left/top。
     * 该 rect 自动包含滚动、缩放、容器 padding、工具栏高度等全部偏移；
     * 而任何基于状态值（coord.get_origin / last_transform.x）的推算都会因
     * 状态滞后或基础偏移缺失而偏离——小黑板曾因此整体偏移 ~112px
     * （表现为"绘制中位置错、抬笔后正常"）。把该模式固化为唯一写法，
     * 是为了让新接入的上下文不再有机会走错路径。
     *
     * @param {object} opts
     * @param {() => ({left:number, top:number}|null)} opts.get_rect - 取锚点元素实时矩形
     * @param {() => number} [opts.get_scale] - 当前缩放
     * @param {() => ({x:number, y:number})} [opts.fallback_origin] - 矩形取不到时的原点兜底
     */
    set_rect_anchor({ get_rect, get_scale, fallback_origin } = {}) {
        this.set_transform_provider(() => {
            const r = get_rect ? get_rect() : null;
            const fb = (!r && fallback_origin) ? fallback_origin() : null;
            return {
                scale: (get_scale ? get_scale() : 1) || 1,
                originX: r ? r.left : (fb ? fb.x : 0),
                originY: r ? r.top : (fb ? fb.y : 0)
            };
        });
    }

    /**
     * 使视图变换缓存失效，下一帧 sync_transform 会重新对齐。
     * 页面几何变化（翻页、滚动、布局调整）后调用——外层模块需要重置变换时
     * 走这里，而不是直接去写 _transformScale 等内部字段。
     */
    invalidate_transform() {
        this._transformScale = 0;
        this._transformX = 0;
        this._transformY = 0;
    }

    /** 注入已存在的 canvas（阅读器全局覆盖层 / 小黑板路径）。 */
    attach(canvas, ctx, screenW, screenH) {
        this.canvas = canvas;
        this.ctx = ctx || (canvas ? canvas.getContext('2d', this._contextAttributes) : null);
        this._displayW = 0;   // 先清空旧值，让 _apply_geometry 不做「同尺寸」判定
        this._displayH = 0;
        this.dpr = this._calc_dpr(1);
        this._apply_geometry(screenW, screenH, this.dpr, true);
        if (this.ctx) this.ctx.imageSmoothingEnabled = false;
        this.invalidate_transform();
    }

    /**
     * 视口尺寸变化：重算 DPR 并重设画布像素尺寸。
     *
     * 与 DPR 调整共用同一条几何路径 —— 两者都改写 canvas.width/height，
     * 也就都会清空内容。此前 resize 自己实现一份，代价有两个：
     *   - 丢了内容快照：绘制中窗口被改变时，未提交的整段笔迹预览直接消失
     *     （类头注释与 CHANGELOG 都承诺过「resize 前存快照」，实际只有 DPR
     *     路径做到了）；
     *   - 尺寸完全没变也重分配一次全屏画布：阅读器每次容器几何变化都会调到这里
     *     （高度变化、面板显隐等），视口本身未变时纯属白清空一次。
     */
    resize(screenW, screenH) {
        this._apply_geometry(screenW, screenH, this._calc_dpr(1));
        // 展示尺寸未变但锚点元素可能已移动，变换缓存照样作废，下一帧重新对齐
        this.invalidate_transform();
    }

    /**
     * 应用展示尺寸与 DPR —— **改写画布像素尺寸的唯一实现**。
     *
     * canvas.width/height 一经赋值内容即被清空，故先把旧内容转成快照、改完
     * 立刻回写，避免「预览笔迹突然消失」的闪断：
     *   - 仅 DPR 变化（逻辑尺寸不变）：快照等比回写，像素级无损；
     *   - 逻辑尺寸也变了：按 1:1 回写。此时平移量（锚点）与缩放都已不同，
     *     拉伸只会让未提交的笔迹先变形一次；等比原样保留至少形状是对的，
     *     下一帧的增量绘制会补齐。
     * @param {number} displayW/displayH 展示尺寸（CSS 像素）
     * @param {number} newDpr 目标 DPR
     * @param {boolean} [force] 同尺寸同 DPR 时是否仍然重设（attach 用）
     * @returns {boolean} 是否真的改动了画布
     */
    _apply_geometry(displayW, displayH, newDpr, force = false) {
        const w = Math.max(1, Math.round(displayW));
        const h = Math.max(1, Math.round(displayH));
        const prevW = this._displayW;
        const prevH = this._displayH;
        const unchanged = !force && w === prevW && h === prevH && newDpr === this.dpr;
        this._displayW = w;
        this._displayH = h;
        if (unchanged) return false;      // 无变化：resize 只会白清空一次
        if (!this.canvas) { this.dpr = newDpr; return false; }

        const sizeChanged = (w !== prevW || h !== prevH);

        let snapshot = null;
        if (this.ctx && this.canvas.width > 0 && this.canvas.height > 0) {
            snapshot = document.createElement('canvas');
            snapshot.width = this.canvas.width;
            snapshot.height = this.canvas.height;
            snapshot.getContext('2d').drawImage(this.canvas, 0, 0);
        }

        this.dpr = newDpr;
        this.canvas.width = Math.ceil(w * newDpr);
        this.canvas.height = Math.ceil(h * newDpr);
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';

        if (snapshot) {
            this.ctx.save();
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);
            if (sizeChanged) {
                this.ctx.imageSmoothingEnabled = false;
                this.ctx.drawImage(snapshot, 0, 0);
            } else {
                this.ctx.imageSmoothingEnabled = true;
                this.ctx.drawImage(snapshot, 0, 0, this.canvas.width, this.canvas.height);
            }
            this.ctx.restore();
            this.ctx.imageSmoothingEnabled = false;
        }

        this.invalidate_transform();
        return true;
    }

    /**
     * 立即应用 DPR（无迟滞），用于设置变更 / 上下文注册刷新 / 显示器变化。
     * 既然被显式调用，就以最终值收敛；目标与当前相同则由 _apply_geometry
     * 提前返回，不会白清空一次画布。
     */
    sync_dpr_now(scale) {
        this._apply_dpr(this._calc_dpr(scale));
    }

    /**
     * 立即应用新 DPR（无迟滞）：尺寸取当前展示尺寸，走同一条几何路径。
     */
    _apply_dpr(newDpr) {
        const size = this._ensure_display_size();
        this._apply_geometry(size.w, size.h, newDpr);
    }

    /**
     * 确保已知展示尺寸：外部直接注入 canvas（黑板 / 阅读器）时 _displayW/H 可能为 0，
     * 此时从 canvas 的 CSS 尺寸或布局尺寸推断，避免把画布缩成 1px。
     */
    _ensure_display_size() {
        if (this._displayW > 0 && this._displayH > 0) {
            return { w: this._displayW, h: this._displayH };
        }
        const c = this.canvas;
        if (!c) return { w: 1, h: 1 };
        const cssW = parseFloat(c.style.width);
        const cssH = parseFloat(c.style.height);
        const w = (cssW > 0 ? cssW : (c.clientWidth || c.width)) || 1;
        const h = (cssH > 0 ? cssH : (c.clientHeight || c.height)) || 1;
        this._displayW = w;
        this._displayH = h;
        return { w, h };
    }

    _fetch_view_transform() {
        if (this._transformProvider) {
            const t = this._transformProvider();
            return {
                scale: t && t.scale != null ? t.scale : 1,
                originX: t && t.originX != null ? t.originX : 0,
                originY: t && t.originY != null ? t.originY : 0
            };
        }
        // 未注入 provider 时无从得知内容原点的屏幕位置。此前这里读的是
        // window.state.canvasX/canvasY —— 那是主画布专属的旧约定，而主画布
        // 根本没有覆盖层（笔迹直接落瓦片层），该分支实际无人到达。
        // 保留一个会告警的单位变换，比留一份平时不生效、主画布一旦接覆盖层
        // 就会算错的"老约定"更安全。
        if (!this._warnedNoProvider) {
            this._warnedNoProvider = true;
            console.warn('[OverlayManager] 未注入变换锚点，覆盖层变换回退为单位矩阵');
        }
        return { scale: 1, originX: 0, originY: 0 };
    }

    sync_transform() {
        if (!this.ctx) return;
        const dpr = this.dpr;
        const { scale, originX, originY } = this._fetch_view_transform();
        if (this._transformScale === scale &&
            this._transformX === originX &&
            this._transformY === originY) {
            return;
        }
        this._transformScale = scale;
        this._transformX = originX;
        this._transformY = originY;
        this.ctx.setTransform(
            scale * dpr, 0, 0, scale * dpr,
            originX * dpr, originY * dpr
        );
    }

    /**
     * 清除：dirty 为 {x,y,x2,y2} 时仅局部清除（按视图变换换算到设备像素），否则全量。
     */
    clear(dirty) {
        if (!this.ctx) return;
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        if (dirty) {
            const { scale: s, originX, originY } = this._fetch_view_transform();
            const dpr = this.dpr;
            const ox = originX * dpr;
            const oy = originY * dpr;
            const x = Math.floor(dirty.x * s * dpr + ox - 1);
            const y = Math.floor(dirty.y * s * dpr + oy - 1);
            const w = Math.ceil((dirty.x2 - dirty.x) * s * dpr + 2);
            const h = Math.ceil((dirty.y2 - dirty.y) * s * dpr + 2);
            const cw = this.canvas.width;
            const ch = this.canvas.height;
            const clampX = Math.max(0, Math.min(x, cw));
            const clampY = Math.max(0, Math.min(y, ch));
            const clampW = Math.max(0, Math.min(w, cw - clampX));
            const clampH = Math.max(0, Math.min(h, ch - clampY));
            if (clampW > 0 && clampH > 0) {
                this.ctx.clearRect(clampX, clampY, clampW, clampH);
            }
        } else {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        this.invalidate_transform();
    }

    hide() { if (this.canvas) this.canvas.style.visibility = 'hidden'; }
    show() { if (this.canvas) this.canvas.style.visibility = ''; }

    /**
     * 释放覆盖层：清像素（释放 backing store，仅丢引用要等 GC）+ DOM 摘除。
     * 调用方不得再自行去 removeChild / 置 width=0 —— 双份清理会互相干扰，
     * 且持有 canvas 引用的一方容易忘记清像素。
     */
    destroy() {
        if (this.canvas) {
            try {
                const ctx = this.ctx || this.canvas.getContext('2d');
                if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            } catch (_) {}
            this.canvas.width = 0;
            this.canvas.height = 0;
            if (this.canvas.parentNode) {
                this.canvas.parentNode.removeChild(this.canvas);
            }
        }
        this.canvas = null;
        this.ctx = null;
        this._displayW = 0;
        this._displayH = 0;
        this._transformProvider = null;
    }
}

window.OverlayManager = OverlayManager;
