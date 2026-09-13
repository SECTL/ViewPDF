/**
 * ResolutionController —— 动态分辨率（DPR）统一控制器（单例）。
 *
 * 集中管理渲染层所需的全部 DPR 计算与配置：
 *   - 瓦片层 DPR（内容空间，随缩放线性提升，保证放大后清晰）
 *   - 覆盖层 DPR（屏幕空间，以显示 DPR 为硬上限）
 *   - DPR 相关设置的统一写入与变更订阅
 *
 * 主画布 / 阅读器 / 小黑板三处渲染上下文共享同一份计算逻辑，
 * 并通过 register_context 订阅 DPR 变更，取代原先散落各处、
 * 由 sync_all_overlay_dpr 手动逐处修补式同步的写法。
 */
class ResolutionController {
    constructor() {
        /** @type {Set<{id:string, get_scale?:()=>number, on_dpr_change?:(scale:number,force:boolean)=>void}>} */
        this._contexts = new Set();

        // 交互闸门：缩放/平移手势进行中冻结一切 DPR 重建。
        // 手势期间浏览器本就用 CSS transform 缩放现有瓦片，视觉连续；
        // 此时重建画布只会掉帧，且目标 DPR 每帧都在变、重建完立刻作废。
        this._lastInteractionAt = 0;
        this._interactionHoldMs = 320;
    }

    /**
     * 标记一次交互（缩放 / 平移 / 拖拽）。采用时间戳而非 begin/end 配对，
     * 避免因异常路径漏调 end 导致永久冻结。
     */
    mark_interaction() {
        this._lastInteractionAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    }

    _now() {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    /** 手势是否仍在进行（距最后一次交互不足 hold 时长） */
    get is_interacting() {
        return this._now() - this._lastInteractionAt < this._interactionHoldMs;
    }

    /** 距离手势判定结束还剩多少毫秒，用于安排延后重建 */
    interaction_remain_ms() {
        return Math.max(0, this._interactionHoldMs - (this._now() - this._lastInteractionAt));
    }

    _cfg() {
        return window.DRAW_CONFIG || {};
    }

    /** DPR 步进：同时作为重建迟滞的粒度，避免跨半个步进就重建一次 */
    dpr_step() {
        return this._cfg().dprStep || 0.25;
    }

    /** 当前物理显示 DPR（如不可用回退 1）。 */
    display_dpr() {
        return window.devicePixelRatio || 1;
    }

    /**
     * 瓦片层目标 DPR：瓦片是内容空间画布（逻辑尺寸固定），
     * 需随缩放线性提升分辨率，否则放大后像素化。
     */
    calc_tile_dpr(scale) {
        const cfg = this._cfg();
        if (cfg.dynamicDprEnabled === false) {
            return cfg.dpr != null ? cfg.dpr : 1;
        }
        const baseDpr = cfg.baseDpr || this.display_dpr();
        const minDpr = cfg.dprMin || 1;
        const maxDpr = cfg.dprMax || 4;
        const step = cfg.dprStep || 0.25;
        // 向上取整到 step 的整数倍，避免向下取整导致轻微模糊
        let dpr = baseDpr * (scale || 1);
        dpr = Math.ceil(dpr / step) * step;
        return Math.max(minDpr, Math.min(maxDpr, dpr));
    }

    /**
     * 覆盖层目标 DPR：覆盖层是屏幕空间画布，绘制时整体以 scale 作变换，
     * 线宽 = scale * overlayDpr —— 故 overlayDpr 取显示 DPR 即足够清晰，
     * 超过显示 DPR 对显示无增益、仅浪费显存。
     * 此前 dynamic 开启时错误地恒返回 1，导致高分屏 / 放大下实时预览发虚。
     */
    calc_overlay_dpr(scale) {
        const cfg = this._cfg();
        if (cfg.overlayDpr != null && cfg.overlayDpr > 0) return cfg.overlayDpr;
        const display = this.display_dpr();
        if (cfg.dynamicDprEnabled === false) {
            return Math.min(cfg.dpr != null ? cfg.dpr : display, 2);
        }
        return Math.min(display, cfg.dprMax || 4);
    }

    /** 统一写入 DPR 相关设置，返回实际发生变更的键集合（未变化的键不回写）。 */
    update_settings(settings) {
        const cfg = window.DRAW_CONFIG;
        if (!cfg || !settings) return [];
        const keys = ['dynamicDprEnabled', 'dprMin', 'dprMax', 'dprStep', 'overlayDpr', 'dpr', 'baseDpr'];
        const changed = [];
        for (const k of keys) {
            if (settings[k] !== undefined && settings[k] !== cfg[k]) {
                cfg[k] = settings[k];
                changed.push(k);
            }
        }
        return changed;
    }

    /**
     * 注册渲染上下文，订阅 DPR 变更。
     * @param {{id:string, get_scale?:()=>number, on_dpr_change?:(scale:number,force:boolean)=>void}} ctx
     */
    register_context(ctx) {
        if (ctx) this._contexts.add(ctx);
        return ctx;
    }

    unregister_context(ctx) {
        if (ctx) this._contexts.delete(ctx);
    }

    /** 通知所有已注册上下文：按各自当前 scale 重新计算并应用 DPR。 */
    refresh_all(force = true) {
        for (const ctx of this._contexts) {
            try {
                const scale = ctx.get_scale ? ctx.get_scale() : 1;
                if (ctx.on_dpr_change) ctx.on_dpr_change(scale, force);
            } catch (e) {
                console.error('[ResolutionController] 上下文 DPR 刷新失败:', e);
            }
        }
    }
}

window.ResolutionController = new ResolutionController();
