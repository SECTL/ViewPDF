/**
 * OverlayManager —— 实时预览覆盖层（屏幕空间 canvas）的统一定义与管理。
 *
 * 从 RealtimeBatchDrawManager 中抽取，供主画布 / 阅读器 / 小黑板三处复用。
 * 职责：
 *   - 持有 overlay canvas / ctx / dpr
 *   - 依据 ResolutionController 计算动态 DPR（屏幕空间，以显示 DPR 为上限）
 *   - 视图变换（setTransform）由外部注入的 transform_provider 提供
 *   - 笔迹进行中延迟 DPR 调整，避免 resize 清空导致笔迹闪断
 *   - 局部 / 全量清除、缩放期间显隐
 */
class OverlayManager {
    constructor(options = {}) {
        this.resolution = options.resolution || null; // 缺省运行时取 window.ResolutionController
        this.canvas = null;
        this.ctx = null;
        this.dpr = 1;

        this._displayW = 0;
        this._displayH = 0;

        this._transformScale = 0;
        this._transformX = 0;
        this._transformY = 0;

        this._dprSettleMs = 300;
        this._dprSettleTimerId = null;

        // 笔迹进行中标记：resize / DPR 调整会清空内容（导致笔迹闪断），
        // 期间收到的 DPR 调整请求顺延到笔画结束（end_stroke）时补执行
        this._strokeActive = false;
        this._deferredDpr = null;

        this._transformProvider = null;

        this._className = options.className || 'canvas-tile draw-overlay';
        this._contextAttributes = options.contextAttributes || { willReadFrequently: false };
    }

    _res() {
        return this.resolution || window.ResolutionController;
    }

    _calc_dpr(scale) {
        const res = this._res();
        if (res && res.calc_overlay_dpr) return res.calc_overlay_dpr(scale);
        // 兜底：与 ResolutionController.calc_overlay_dpr 一致
        const cfg = window.DRAW_CONFIG || {};
        if (cfg.overlayDpr != null && cfg.overlayDpr > 0) return cfg.overlayDpr;
        const display = window.devicePixelRatio || 1;
        if (cfg.dynamicDprEnabled === false) return Math.min(cfg.dpr != null ? cfg.dpr : display, 2);
        return Math.min(display, cfg.dprMax || 4);
    }

    /** 覆盖层目标 DPR（对外暴露；内部统一走 _calc_dpr） */
    calc_overlay_dpr(scale) {
        return this._calc_dpr(scale);
    }

    set_transform_provider(fn) {
        this._transformProvider = fn;
    }

    /** 由容器创建全新 overlay（主画布路径）。 */
    init(container, screenW, screenH, dpr) {
        this.canvas = document.createElement('canvas');
        this.canvas.className = this._className;
        this._displayW = Math.max(1, screenW);
        this._displayH = Math.max(1, screenH);
        this.dpr = dpr != null ? dpr : this._calc_dpr(1);
        this.canvas.width = Math.ceil(this._displayW * this.dpr);
        this.canvas.height = Math.ceil(this._displayH * this.dpr);
        this.canvas.style.width = this._displayW + 'px';
        this.canvas.style.height = this._displayH + 'px';
        container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d', this._contextAttributes);
        if (this.ctx) this.ctx.imageSmoothingEnabled = false;
        this._transformScale = 0;
        this._transformX = 0;
        this._transformY = 0;
    }

    /** 注入已存在的 canvas（阅读器全局覆盖层 / 小黑板路径）。 */
    attach(canvas, ctx, screenW, screenH) {
        this.canvas = canvas;
        this.ctx = ctx || (canvas ? canvas.getContext('2d', this._contextAttributes) : null);
        this._displayW = Math.max(1, screenW);
        this._displayH = Math.max(1, screenH);
        this.dpr = this._calc_dpr(1);
        if (this.canvas) {
            this.canvas.width = Math.ceil(this._displayW * this.dpr);
            this.canvas.height = Math.ceil(this._displayH * this.dpr);
            this.canvas.style.width = this._displayW + 'px';
            this.canvas.style.height = this._displayH + 'px';
        }
        if (this.ctx) this.ctx.imageSmoothingEnabled = false;
        this._transformScale = 0;
        this._transformX = 0;
        this._transformY = 0;
    }

    resize(screenW, screenH) {
        this._displayW = Math.max(1, screenW);
        this._displayH = Math.max(1, screenH);
        const target = this._calc_dpr(1);
        this.dpr = target;
        if (this.canvas) {
            this.canvas.width = Math.ceil(this._displayW * this.dpr);
            this.canvas.height = Math.ceil(this._displayH * this.dpr);
            this.canvas.style.width = this._displayW + 'px';
            this.canvas.style.height = this._displayH + 'px';
        }
        this._transformScale = 0;
        this._transformX = 0;
        this._transformY = 0;
    }

    /** 缩放期间按 scale 调整 DPR（带迟滞；笔迹进行中顺延）。 */
    request_dpr(scale, force) {
        const target = this._calc_dpr(scale);
        // 覆盖层是屏幕空间画布，DPR 只随显示 DPR / 设置变化，与缩放无关。
        // 绝大多数调用（每次缩放）都是空转，此处提前返回，既省一个定时器，
        // 也杜绝 force 场景下无谓的 resize —— resize 会清空画布内容。
        if (target === this.dpr && !force) return;
        if (this._strokeActive) {
            this._deferredDpr = { scale, force };
            if (this._dprSettleTimerId != null) {
                clearTimeout(this._dprSettleTimerId);
                this._dprSettleTimerId = null;
            }
            return;
        }
        if (this._dprSettleTimerId != null) {
            clearTimeout(this._dprSettleTimerId);
            this._dprSettleTimerId = null;
        }
        this._dprSettleTimerId = setTimeout(() => {
            this._dprSettleTimerId = null;
            this._apply_dpr(this._calc_dpr(scale));
        }, this._dprSettleMs);
    }

    /** 立即按 scale 设置 DPR（无迟滞），用于 resize / 设置变更 / 上下文注册刷新。 */
    sync_dpr_now(scale) {
        this._apply_dpr(this._calc_dpr(scale));
    }

    /**
     * 应用新 DPR。canvas 尺寸一改内容即被清空，故先把旧内容转成快照，
     * resize 后立刻等比回写，避免出现"预览笔迹突然消失"的闪断。
     */
    _apply_dpr(newDpr) {
        if (!this.canvas) return;
        if (newDpr === this.dpr) return; // 无变化：resize 只会白清空一次
        const size = this._ensure_display_size();

        let snapshot = null;
        if (this.canvas.width > 0 && this.canvas.height > 0) {
            snapshot = document.createElement('canvas');
            snapshot.width = this.canvas.width;
            snapshot.height = this.canvas.height;
            snapshot.getContext('2d').drawImage(this.canvas, 0, 0);
        }

        this.dpr = newDpr;
        this.canvas.width = Math.ceil(Math.max(1, size.w * newDpr));
        this.canvas.height = Math.ceil(Math.max(1, size.h * newDpr));

        if (snapshot && this.ctx) {
            this.ctx.save();
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);
            this.ctx.imageSmoothingEnabled = true;
            this.ctx.drawImage(snapshot, 0, 0, this.canvas.width, this.canvas.height);
            this.ctx.restore();
            this.ctx.imageSmoothingEnabled = false;
        }

        this._transformScale = 0;
        this._transformX = 0;
        this._transformY = 0;
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
        const s = window.state || {};
        return {
            scale: s.scale || 1,
            originX: s.canvasX || 0,
            originY: s.canvasY || 0
        };
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
        this._transformScale = 0;
        this._transformX = 0;
        this._transformY = 0;
    }

    hide() { if (this.canvas) this.canvas.style.visibility = 'hidden'; }
    show() { if (this.canvas) this.canvas.style.visibility = ''; }

    begin_stroke() {
        this._strokeActive = true;
        this._deferredDpr = null;
    }

    /**
     * 结束笔画并补执行顺延的 DPR 调整。
     * @param {boolean} applyDeferred - 是否应用顺延请求（reset 场景传 false，仅清理）
     */
    end_stroke(applyDeferred = true) {
        this._strokeActive = false;
        if (!applyDeferred) {
            this._deferredDpr = null;
            return;
        }
        if (this._deferredDpr) {
            const d = this._deferredDpr;
            this._deferredDpr = null;
            this.request_dpr(d.scale, d.force);
        }
    }

    destroy() {
        if (this._dprSettleTimerId != null) {
            clearTimeout(this._dprSettleTimerId);
            this._dprSettleTimerId = null;
        }
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = null;
        this.ctx = null;
        this._deferredDpr = null;
        this._strokeActive = false;
    }
}

window.OverlayManager = OverlayManager;
