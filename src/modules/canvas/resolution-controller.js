/**
 * ResolutionController —— 动态分辨率（DPR）统一控制器（单例）。
 *
 * 集中管理渲染层所需的**全部** DPR 计算与配置，是全应用唯一的 DPR 事实来源：
 *   - 瓦片层 DPR（内容空间，随缩放线性提升，保证放大后清晰）
 *   - 覆盖层 DPR（屏幕空间，以显示 DPR 为硬上限）
 *   - 页面栅格化 DPR（PDF 光栅化，按活动页/邻页/离屏分级）
 *   - 小尺寸 UI DPR（缩略图等，只需够用即可）
 *   - 静态倍率 DPR（动态分辨率关闭时的固定倍率，落点 DRAW_CONFIG.dpr）
 *   - DPR 相关设置的统一写入、启动期回放与变更订阅
 *
 * 主画布 / 阅读器 / 小黑板三处渲染上下文共享同一份计算逻辑，
 * 并通过 register_context 订阅 DPR 变更，取代原先散落各处、
 * 由全局函数手动逐处修补式同步的写法（那个全局别名已删除）。
 *
 * 不变式（改动本文件时请一并遵守）：
 *   1. 任何模块都不得自行读取 devicePixelRatio 推导 DPR，一律走本控制器。
 *   2. DRAW_CONFIG.dpr 是**派生值**，只由 sync_static_dpr() 写入，外部不得直接赋值。
 *   3. 覆盖层画布永不因缩放而重建（屏幕空间），瓦片/页面才随缩放提升。
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

        // 内存压力阈值：堆占用超过此值时页面栅格化降级到 1x，避免 OOM
        this._memoryGuardBytes = 500 * 1024 * 1024;

        // 覆盖层（绘画时 DPR）显式设置值的硬上限。设置面板提供的最高档即 6x；
        // 超过它画面无增益、显存爆炸，导入设置时也在此处兜底
        this.OVERLAY_DPR_HARD_MAX = 6;

        // 显示 DPR 变化监听器（跨显示器 / 系统缩放变更）
        this._dprWatcher = null;
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
     * 基准 DPR 自愈：baseDpr 是内容空间的 1x 起点，语义上恒等于当前显示 DPR。
     *
     * 它此前只由事件刷新（watch_display_dpr 的 matchMedia change、主画布的
     * 窗口几何路径），而 matchMedia 的 resolution 查询并非在所有环境都派发
     * change，跨屏拖动也不一定产生窗口尺寸变化。一旦漏派发，baseDpr 就停在
     * 旧显示密度上；而 calc_overlay_dpr 与图像层（`<img>` 的呈现密度）都是
     * 实时读 devicePixelRatio —— 于是「批注层按旧密度栅格化、图片层按新密度
     * 呈现」，两层的动态分辨率对不上，且不会自愈。
     *
     * 故改为在读取处对齐：读到与显示 DPR 不一致就地修正，让这类漂移活不过
     * 一次计算。事件路径（refresh_display_dpr）保留，它额外负责广播
     * refresh_all 让各上下文主动重建。
     * @returns {number} 已与显示 DPR 对齐的基准 DPR
     */
    sync_base_dpr() {
        const cfg = window.DRAW_CONFIG;
        if (!cfg) return this.display_dpr();
        const display = this.display_dpr();
        if (cfg.baseDpr === display) return display;
        cfg.baseDpr = display;
        // 静态倍率是 baseDpr 的派生值，对齐后立刻落一遍，避免残留旧倍率
        this.sync_static_dpr();
        return display;
    }

    /**
     * 内容空间基准 DPR（瓦片 / 页面栅格化的 1x 起点）。
     * 每次都经 sync_base_dpr 对齐，不用可能陈旧的缓存值。
     */
    base_dpr() {
        return this.sync_base_dpr();
    }

    /**
     * 静态倍率 DPR：动态分辨率关闭时的固定倍率 = 基准 DPR 受 dprLimit 约束
     * （dprLimit <= 0 表示"自动"，即不设上限）。
     * 这是 base*limit 公式在全应用的唯一实现。
     */
    static_dpr() {
        const cfg = this._cfg();
        const base = this.base_dpr();
        const limit = cfg.dprLimit;
        return (limit != null && limit > 0) ? Math.min(base, limit) : base;
    }

    /**
     * 把静态倍率写回 DRAW_CONFIG.dpr。
     * DRAW_CONFIG.dpr 是派生值，只允许此方法写入——其余模块读它即可。
     * @returns {number} 写入后的静态倍率
     */
    sync_static_dpr() {
        const cfg = window.DRAW_CONFIG;
        if (!cfg) return 1;
        const value = this.static_dpr();
        if (cfg.dpr !== value) cfg.dpr = value;
        return value;
    }

    /** 当前是否处于内存压力状态（页面栅格化降级的依据） */
    is_memory_pressured() {
        try {
            const used = performance.memory?.usedJSHeapSize;
            return typeof used === 'number' && used > this._memoryGuardBytes;
        } catch (_) {
            return false;
        }
    }

    /**
     * 瓦片层目标 DPR：瓦片是内容空间画布（逻辑尺寸固定），
     * 需随缩放线性提升分辨率，否则放大后像素化。
     *
     * @param {number} scale - 当前缩放比例
     * @param {{role?: 'active'|'neighbor'|'offscreen', memoryGuard?: boolean}} [opts]
     *   role 分级（页面栅格化用）：
     *     active    活动页，取全量 DPR
     *     neighbor  半可见的相邻页，封顶 2x —— 翻页瞬间即清晰，兼顾显存
     *     offscreen 离屏预渲染页，大幅放大时降到 1x 省内存
     *   memoryGuard 为 true 时在此处统一做堆内存降级（默认关闭，
     *   仅页面栅格化开启；瓦片层历史上无此策略，保持行为一致）
     * @returns {number} 目标 DPR
     */
    calc_tile_dpr(scale, opts = {}) {
        const cfg = this._cfg();
        if (cfg.dynamicDprEnabled === false) {
            return this.static_dpr();
        }
        if (opts.memoryGuard && this.is_memory_pressured()) return 1;

        const baseDpr = this.base_dpr();
        const minDpr = cfg.dprMin || 1;
        const maxDpr = cfg.dprMax || 4;
        const step = cfg.dprStep || 0.25;
        // 向上取整到 step 的整数倍，避免向下取整导致轻微模糊
        let dpr = Math.ceil((baseDpr * (scale || 1)) / step) * step;
        dpr = Math.max(minDpr, Math.min(maxDpr, dpr));

        switch (opts.role) {
            case 'neighbor':
                return Math.min(dpr, 2);
            case 'offscreen':
                return (scale || 1) > 3 ? 1 : dpr;
            default:
                return dpr;
        }
    }

    /**
     * 覆盖层目标 DPR：覆盖层是屏幕空间画布，绘制时整体以 scale 作变换，
     * 线宽 = scale * overlayDpr —— 故 overlayDpr 取显示 DPR 即足够清晰，
     * 超过显示 DPR 对显示无增益、仅浪费显存。
     * 此前 dynamic 开启时错误地恒返回 1，导致高分屏 / 放大下实时预览发虚。
     *
     * 显式设置值允许到 6x（绘画时 DPR）：1x 屏上超采样可以让笔迹预览
     * 边缘更细腻，但必须钳制在 [0.5, 6]——导入的异常大值会把覆盖层
     * 画布的像素尺寸放大到失控（1920×1080 @6x ≈ 75M 像素）。
     */
    calc_overlay_dpr(scale) {
        const cfg = this._cfg();
        if (cfg.overlayDpr != null && cfg.overlayDpr > 0) {
            return Math.min(Math.max(cfg.overlayDpr, 0.5), this.OVERLAY_DPR_HARD_MAX);
        }
        if (cfg.dynamicDprEnabled === false) {
            return Math.min(this.static_dpr(), 2);
        }
        return Math.min(this.display_dpr(), cfg.dprMax || 4);
    }

    /**
     * 小尺寸 UI 渲染 DPR（列表缩略图等）：只需「够显示 + 有上限」，
     * 不随缩放提升，避免为几十像素的预览图分配大画布。
     */
    calc_ui_dpr(scale = 1, cap = 2) {
        const cfg = this._cfg();
        if (cfg.dynamicDprEnabled === false) {
            return Math.min(this.static_dpr(), cap);
        }
        return Math.min(this.base_dpr() * (scale || 1), cap);
    }

    /**
     * 统一写入 DPR 相关设置，返回实际发生变更的键集合（未变化的键不回写）。
     *
     * 收尾无条件重算一次静态倍率：它是派生值，只要 DRAW_CONFIG 里的
     * 输入（baseDpr / dprLimit / dpr）与 cfg.dpr 出现任何不一致，
     * 在此就地修好。基于「本次哪些键变了」来决定是否重算，会漏掉
     * 「输入被别处改动但本次传入同值」这类情况，留下静默的陈旧派生值。
     */
    update_settings(settings) {
        const cfg = window.DRAW_CONFIG;
        if (!cfg || !settings) return [];
        // 刻意不含 baseDpr：它是显示 DPR 的派生缓存（见 sync_base_dpr），
        // 不是设置项。留在键里会让人「设置成功」而实际被读取处立刻修正回去。
        const keys = [
            'dynamicDprEnabled', 'dprMin', 'dprMax', 'dprStep',
            'overlayDpr', 'dprLimit'
        ];
        const changed = [];
        for (const k of keys) {
            if (settings[k] !== undefined && settings[k] !== cfg[k]) {
                cfg[k] = settings[k];
                changed.push(k);
            }
        }
        this.sync_static_dpr();
        return changed;
    }

    /**
     * 启动期回放持久化设置。
     * 此前 DPR 设置只在「打开设置面板并改动」时才进入 DRAW_CONFIG，
     * 重启后一律回落到默认值（画面精度提示的"重启生效"实际不生效）。
     * @param {object} settings - 后端 settings_fetch_all 返回的设置对象
     * @returns {string[]} 实际发生变更的键集合
     */
    apply_persisted(settings) {
        if (!settings) return [];
        const changed = this.update_settings({
            dynamicDprEnabled: settings.dynamicDprEnabled,
            dprMin: settings.dprMin,
            dprMax: settings.dprMax,
            dprStep: settings.dprStep,
            overlayDpr: settings.overlayDpr,
            dprLimit: settings.dprLimit
        });
        // 即使一个键都没变也要落一遍静态倍率：baseDpr 与 dprLimit 的组合
        // 决定了动态模式关闭时的画质，首次渲染前必须已就位
        this.sync_static_dpr();
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

    /**
     * 复核基准 DPR 是否仍等于当前显示器 DPR，变化则更新并广播。
     * @returns {boolean} 是否发生变化
     */
    refresh_display_dpr() {
        const cfg = window.DRAW_CONFIG;
        if (!cfg) return false;
        const display = this.display_dpr();
        if (cfg.baseDpr === display) return false;
        // 对齐逻辑的唯一实现在 sync_base_dpr（它同时刷新派生值 DRAW_CONFIG.dpr）；
        // 此处只额外做广播，让各上下文主动重建到新密度而不是等下次交互
        this.sync_base_dpr();
        this.refresh_all(true);
        return true;
    }

    /**
     * 跟随显示 DPR 变化（窗口跨显示器拖动 / 系统缩放调整）。
     * baseDpr 启动后固定会让高 DPI 显示器切到低 DPI 时仍按旧倍率栅格化，
     * 既浪费显存又与新显示密度不匹配。matchMedia 的 resolution 查询
     * 能可靠捕获该变化，每次命中后重新绑定到新的 DPR 值。
     *
     * 注意：该查询并非在所有环境都派发 change（实测无头环境不派发），
     * 故窗口几何响应路径还会另行调用 refresh_display_dpr() 兜底。
     */
    watch_display_dpr() {
        if (this._dprWatcher || typeof window.matchMedia !== 'function') return;
        const bind = () => {
            const dpr = this.display_dpr();
            let mq;
            try {
                mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
            } catch (_) {
                return;
            }
            this._dprWatcher = mq;
            mq.addEventListener('change', () => {
                this._dprWatcher = null;
                this.refresh_display_dpr();
                bind();
            }, { once: true });
        };
        bind();
    }
}

window.ResolutionController = new ResolutionController();
