/**
 * ViewPDF 小黑板模块
 * 从顶部弹出的独立绘制面板，支持多页绘制
 * 使用 DrawingEngine 管理绘制管线
 */

import { InputSource, PinchZoomSource, PinchZoomSourceV2, VirtualDeviceType } from '../gesture/index.js';
import { BlackboardPageManager } from './blackboard-page.js';
import { DrawingEngine } from './drawing-engine.js';
import { history_state, history_validate_undo, history_reset_executing } from '../history.js';

class BlackboardManager {
    constructor() {
        this.is_open = false;
        this.canvas = null;
        this.ctx = null;
        this.overlay_canvas = null;
        this.overlay_ctx = null;
        this.page_manager = new BlackboardPageManager();

        // DOM 元素引用（由 _create_panel / _create_toolbar 创建）
        this._el = {
            panel: null,
            canvasWrap: null,
            canvas: null,
            toolbar: null,
            btnMove: null,
            btnComment: null,
            btnEraser: null,
            btnUndo: null,
            pagePrev: null,
            pageNext: null,
            pageAdd: null,
            pageIndicator: null,
            btnClose: null
        };

        this.tile_renderer = null;
        this.bb_wrapper = null;

        this.bb_state = {
            canvas_x: 0,
            canvas_y: 0,
            canvas_w: 0,
            canvas_h: 0,
            scale: 1,
            move_bound: { min_x: 0, max_x: 0, min_y: 0, max_y: 0 },
            is_dragging: false,
            last_transform: { x: null, y: null, scale: null },
            start_drag_x: 0,
            start_drag_y: 0,
            start_scale: 1,
            start_finger0_cx: 0,
            start_finger0_cy: 0,
            start_canvas_x: 0,
            start_canvas_y: 0,
            is_scaling: false,
            is_zooming: false,
            start_distance_sq: 0,
            cached_inv_scale: 1
        };
        this._cached_move_bound_scale = null;
        this._cached_visible_rect = null;
        this._cached_visible_rect_scale = null;
        this._cached_visible_rect_x = null;
        this._cached_visible_rect_y = null;
        this._animate_timer_id = null;

        // 触摸手势优化
        this._touch_raf_id = null;               // 捏合缩放 rAF 节流 ID
        this._touch_pending_data = null;          // 待处理的触摸数据 { t0, t1 }

        // transform rAF 节流（拖拽/捏合共用）
        this._pending_bb_transform = null;
        this._bb_transform_raf_id = null;
        this._bb_last_transform = { x: 0, y: 0, scale: 1 };

        this._smooth_transform_timeout_id = null; // will-change 延迟移除定时器
        this._zoom_complete_timer_id = null;       // 缩放完成延迟重绘定时器

        // 惯性（动量）
        this._momentum_raf = null;
        this._gesture_vx = 0;
        this._gesture_vy = 0;
        this._last_canvas_x = 0;
        this._last_canvas_y = 0;

        this.draw_mode = 'comment';

        this.screen_w = 0;
        this.screen_h = 0;
        this._last_loaded_index = -1;
        this._tiles_changed_since_snapshot = false;

        // 弹性 overscroll 状态
        this._is_overscrolling = false;
        this._overscroll_display_x = 0;
        this._overscroll_display_y = 0;

        // gesture 模块实例
        this._input_source = null;
        this._pinch_source = null;

        /** @type {DrawingEngine|null} */
        this.drawing_engine = null;
    }

    /** 创建黑板面板 DOM（panel + canvasWrap + canvas） */
    _create_panel() {
        const panel = document.createElement('div');
        panel.className = 'blackboard-panel';
        panel.id = 'blackboardPanel';

        const canvasWrap = document.createElement('div');
        canvasWrap.className = 'blackboard-canvas-wrap';
        canvasWrap.id = 'blackboardCanvasWrap';

        const canvas = document.createElement('canvas');
        canvas.id = 'blackboardCanvas';
        canvasWrap.appendChild(canvas);

        panel.appendChild(canvasWrap);
        document.body.appendChild(panel);

        this._el.panel = panel;
        this._el.canvasWrap = canvasWrap;
        this._el.canvas = canvas;
    }

    /** 创建黑板工具栏 DOM，prepend 到 panel */
    _create_toolbar() {
        const _t = (key) => window.i18n?.format_translate(key) ?? key;

        const toolbar = document.createElement('div');
        toolbar.className = 'bb-toolbar';
        toolbar.id = 'bbToolbar';

        const g = document.createElement('div');
        g.className = 'bb-mode-group';

        const add = (tag, attrs, ...children) => {
            const el = document.createElement(tag);
            for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
            for (const c of children) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
            return el;
        };
        const btn = (id, cls, ...children) => {
            const b = add('button', { id, class: cls }, ...children);
            g.appendChild(b);
            return b;
        };
        const img = (icon, alt) => add('img', { 'data-icon': icon, width: '16', height: '16', alt });
        const span = (text) => add('span', {}, text);
        const sep = () => g.appendChild(add('div', { class: 'toolbar-separator' }));

        // 模式按钮
        const bMove = btn('bbBtnMove', 'toolbar-btn function-btn', img('move', '移动'), span(_t('toolbar.move')));
        bMove.dataset.bbMode = 'move';
        this._el.btnMove = bMove;

        const bComment = btn('bbBtnComment', 'toolbar-btn function-btn active', img('pen', '批注'), span(_t('toolbar.comment')));
        bComment.dataset.bbMode = 'comment';
        this._el.btnComment = bComment;

        const bEraser = btn('bbBtnEraser', 'toolbar-btn function-btn', img('eraser', '橡皮'), span(_t('toolbar.eraser')));
        bEraser.dataset.bbMode = 'eraser';
        this._el.btnEraser = bEraser;

        // 撤销
        const bUndo = btn('bbUndo', 'toolbar-btn', img('undo', '撤销'), span(_t('toolbar.undo')));
        this._el.btnUndo = bUndo;

        sep();

        // 翻页
        const bPrev = btn('bbPagePrev', 'toolbar-btn', img('chevron-left', '上一页'), span(_t('common.prevPage')));
        bPrev.disabled = true;
        this._el.pagePrev = bPrev;

        const pi = add('span', { class: 'dr-page-indicator', id: 'bbPageIndicator' }, '1 / 1');
        g.appendChild(pi);
        this._el.pageIndicator = pi;

        const bNext = btn('bbPageNext', 'toolbar-btn', img('chevron-right', '下一页'), span(_t('common.nextPage')));
        this._el.pageNext = bNext;

        const bAdd = btn('bbPageAdd', 'toolbar-btn', img('add', _t('common.addPage')), span(_t('common.addPage')));
        this._el.pageAdd = bAdd;

        sep();

        // 关闭
        const bClose = btn('bbClose', 'toolbar-btn', img('dismiss', '关闭'), span(_t('common.close')));
        bClose.style.color = 'var(--color-error)';
        this._el.btnClose = bClose;

        toolbar.appendChild(g);
        this._el.panel.prepend(toolbar);
        this._el.toolbar = toolbar;

        if (window.ThemeManager?.theme_load_icons) {
            window.ThemeManager.theme_load_icons();
        }
        this._apply_text_visibility();
    }

    _fetch_safe_scale() {
        return Math.max(0.001, this.bb_state.scale || 1);
    }


    _update_move_bound() {
        if (this._cached_move_bound_scale === this.bb_state.scale) return;
        this._cached_move_bound_scale = this.bb_state.scale;

        const screen_w = this.screen_w;
        const screen_h = this.screen_h;
        const canvas_w = this.bb_state.canvas_w;
        const canvas_h = this.bb_state.canvas_h;
        const scaled_w = canvas_w * this.bb_state.scale;
        const scaled_h = canvas_h * this.bb_state.scale;
        const mb = this.bb_state.move_bound;

        if (scaled_w >= screen_w) {
            mb.min_x = -(scaled_w - screen_w);
            mb.max_x = 0;
        } else {
            mb.min_x = (screen_w - scaled_w) / 2;
            mb.max_x = (screen_w - scaled_w) / 2;
        }

        if (scaled_h >= screen_h) {
            mb.min_y = -(scaled_h - screen_h);
            mb.max_y = 0;
        } else {
            mb.min_y = (screen_h - scaled_h) / 2;
            mb.max_y = (screen_h - scaled_h) / 2;
        }
    }

    _update_canvas_position() {
        const eps = 0.001;
        const mb = this.bb_state.move_bound;
        this.bb_state.canvas_x = Math.max(mb.min_x - eps, Math.min(mb.max_x + eps, this.bb_state.canvas_x));
        this.bb_state.canvas_y = Math.max(mb.min_y - eps, Math.min(mb.max_y + eps, this.bb_state.canvas_y));
    }

    _sync_bb_transform() {
        const s = this.bb_state;
        const lt = s.last_transform;
        if (lt.x === s.canvas_x && lt.y === s.canvas_y && lt.scale === s.scale) return;

        lt.x = s.canvas_x;
        lt.y = s.canvas_y;
        lt.scale = s.scale;

        this.bb_wrapper.style.transform = 'translate3d(' + s.canvas_x + 'px, ' + s.canvas_y + 'px, 0) scale(' + s.scale + ')';

        // 缩放进行中跳过 tile 更新，由缩放结束后批量刷新
        if (s.is_zooming) return;

        if (this.tile_renderer) {
            this.tile_renderer.update_visible_tile_dpr(s.scale, false, true);
        }
    }

    /** rAF 节流版 sync_transform：合并多帧调用，每帧最多一次 DOM 写入 */
    _sync_bb_transform_schedule(x, y, scale) {
        this._pending_bb_transform = { x, y, scale };
        if (this._bb_transform_raf_id === null) {
            this._bb_transform_raf_id = requestAnimationFrame(() => {
                const pt = this._pending_bb_transform;
                this._pending_bb_transform = null;
                this._bb_transform_raf_id = null;
                if (pt) {
                    const s = this.bb_state;
                    const saved_x = s.canvas_x;
                    const saved_y = s.canvas_y;
                    s.canvas_x = pt.x;
                    s.canvas_y = pt.y;
                    this._sync_bb_transform();
                    s.canvas_x = saved_x;
                    s.canvas_y = saved_y;
                }
            });
        }
    }

    /** 立即取消 rAF 节流并 flush 最终位置（手势结束时调用） */
    _flush_bb_transform(x, y, scale) {
        if (this._bb_transform_raf_id !== null) {
            cancelAnimationFrame(this._bb_transform_raf_id);
            this._bb_transform_raf_id = null;
        }
        this._pending_bb_transform = null;
        const s = this.bb_state;
        const saved_x = s.canvas_x;
        const saved_y = s.canvas_y;
        s.canvas_x = x;
        s.canvas_y = y;
        this._sync_bb_transform();
        s.canvas_x = saved_x;
        s.canvas_y = saved_y;
    }

    /** 标记缩放进行中，延迟 300ms 后触发批量重绘 */
    _set_zooming() {
        const s = this.bb_state;
        if (!s.is_zooming) s.is_zooming = true;
        if (this._zoom_complete_timer_id !== null) clearTimeout(this._zoom_complete_timer_id);
        this._zoom_complete_timer_id = setTimeout(() => {
            this._zoom_complete_timer_id = null;
            s.is_zooming = false;
            if (this.tile_renderer) {
                this.tile_renderer.update_visible_tile_dpr(s.scale, false, true);
            }
        }, 300);
    }

    /** 取消缩放延迟更新（缩放结束时立即更新） */
    _cancel_zoom_debounce() {
        const s = this.bb_state;
        if (this._zoom_complete_timer_id !== null) {
            clearTimeout(this._zoom_complete_timer_id);
            this._zoom_complete_timer_id = null;
        }
        s.is_zooming = false;
    }

    _sync_bb_transform_smooth(target_x, target_y, target_scale, duration = 200) {
        if (this._animate_timer_id !== null) {
            clearTimeout(this._animate_timer_id);
            this._animate_timer_id = null;
        }

        const s = this.bb_state;
        s.canvas_x = target_x;
        s.canvas_y = target_y;
        s.scale = target_scale;

        this._update_move_bound();
        this._update_canvas_position();

        const lt = s.last_transform;
        lt.x = s.canvas_x;
        lt.y = s.canvas_y;
        lt.scale = s.scale;

        this.bb_wrapper.style.transitionDuration = duration + 'ms';
        this.bb_wrapper.classList.add('smooth-transform');
        this.bb_wrapper.style.transform = `translate3d(${s.canvas_x}px, ${s.canvas_y}px, 0) scale(${s.scale})`;

        if (this.tile_renderer) {
            this.tile_renderer.update_visible_tile_dpr(s.scale, false, true);
        }

        this._animate_timer_id = setTimeout(() => {
            this._animate_timer_id = null;
            this.bb_wrapper.classList.remove('smooth-transform');
            this.bb_wrapper.style.transitionDuration = '';
        }, duration);
    }

    // ====== 惯性系统 ======

    _cancel_momentum() {
        if (this._momentum_raf !== null) {
            cancelAnimationFrame(this._momentum_raf);
            this._momentum_raf = null;
        }
    }

    _start_momentum() {
        // inertial scrolling disabled
    }

    _momentum_tick() {
        let vx = this._gesture_vx;
        let vy = this._gesture_vy;
        const speed = Math.sqrt(vx * vx + vy * vy);
        const friction = 0.85 - 0.20 * Math.exp(-speed / 8);
        vx *= friction;
        vy *= friction;
        this._gesture_vx = vx;
        this._gesture_vy = vy;

        const s = this.bb_state;
        const prevX = s.canvas_x;
        const prevY = s.canvas_y;
        s.canvas_x += vx;
        s.canvas_y += vy;

        this._update_move_bound();
        this._update_canvas_position();

        // 边界碰撞处理：速度归零（防止贴边滑行）
        if (s.canvas_x === prevX && vx !== 0) {
            this._gesture_vx = 0;
            vx = 0;
        }
        if (s.canvas_y === prevY && vy !== 0) {
            this._gesture_vy = 0;
            vy = 0;
        }

        this._sync_bb_transform();

        if (Math.abs(vx) > 0.5 || Math.abs(vy) > 0.5) {
            this._momentum_raf = requestAnimationFrame(() => this._momentum_tick());
        } else {
            this._momentum_raf = null;
            this._sync_bb_transform_smooth(s.canvas_x, s.canvas_y, s.scale, 150);
        }
    }

    _update_bb_gesture_velocity() {
        const s = this.bb_state;
        const dx = s.canvas_x - this._last_canvas_x;
        const dy = s.canvas_y - this._last_canvas_y;
        const alpha = 0.5;
        this._gesture_vx = this._gesture_vx * (1 - alpha) + dx * alpha;
        this._gesture_vy = this._gesture_vy * (1 - alpha) + dy * alpha;
        this._last_canvas_x = s.canvas_x;
        this._last_canvas_y = s.canvas_y;
    }

    /** 触控交互时启用 GPU 合成层（will-change: transform 内联样式，不使用带 transition 的 class） */
    _touch_enable_gpu() {
        if (this._smooth_transform_timeout_id !== null) {
            clearTimeout(this._smooth_transform_timeout_id);
            this._smooth_transform_timeout_id = null;
        }
        if (this.bb_wrapper) {
            this.bb_wrapper.style.willChange = 'transform';
        }
    }

    /** 触控交互结束后延迟释放 GPU 合成层 */
    _touch_schedule_disable_gpu() {
        if (this._smooth_transform_timeout_id !== null) {
            clearTimeout(this._smooth_transform_timeout_id);
        }
        this._smooth_transform_timeout_id = setTimeout(() => {
            this._smooth_transform_timeout_id = null;
            if (this.bb_wrapper) {
                this.bb_wrapper.style.willChange = '';
            }
        }, 150);
    }

    _fetch_visible_rect() {
        const s = this.bb_state;
        if (this._cached_visible_rect_scale === s.scale &&
            this._cached_visible_rect_x === s.canvas_x &&
            this._cached_visible_rect_y === s.canvas_y &&
            this._cached_visible_rect) {
            return this._cached_visible_rect;
        }

        this._cached_visible_rect_scale = s.scale;
        this._cached_visible_rect_x = s.canvas_x;
        this._cached_visible_rect_y = s.canvas_y;

        const scale = s.scale || 1;
        const canvas_w = this.bb_state.canvas_w;
        const canvas_h = this.bb_state.canvas_h;

        let visible_x = Math.max(0, -s.canvas_x / scale);
        let visible_y = Math.max(0, -s.canvas_y / scale);
        let visible_w = Math.min(canvas_w - visible_x, this.screen_w / scale);
        let visible_h = Math.min(canvas_h - visible_y, this.screen_h / scale);

        const padding = 10;
        visible_x = Math.max(0, visible_x - padding);
        visible_y = Math.max(0, visible_y - padding);
        visible_w = Math.min(canvas_w - visible_x, visible_w + padding * 2);
        visible_h = Math.min(canvas_h - visible_y, visible_h + padding * 2);

        this._cached_visible_rect = {
            x: visible_x,
            y: visible_y,
            width: visible_w,
            height: visible_h
        };
        return this._cached_visible_rect;
    }

    init(container) {
        if (this.bb_wrapper) return; // 防止重复初始化

        // 创建面板和工具栏 DOM
        this._create_panel();
        this._create_toolbar();

        const panel = this._el.panel;
        if (!panel) return;

        // 使用面板尺寸，如果没有则使用传入的container或窗口尺寸
        this.screen_w = Math.max(1, panel.clientWidth || container?.clientWidth || window.innerWidth);
        this.screen_h = Math.max(1, panel.clientHeight || container?.clientHeight || window.innerHeight);

        // 黑板画布大小为屏幕两倍
        this.bb_state.canvas_w = Math.floor(this.screen_w * 2);
        this.bb_state.canvas_h = Math.floor(this.screen_h * 2);

        const canvas_wrap = this._el.canvasWrap;

        // 创建分块包装器（CSS transform 目标）
        this.bb_wrapper = document.createElement('div');
        this.bb_wrapper.className = 'bb-canvas-wrapper';
        this.bb_wrapper.style.width = this.bb_state.canvas_w + 'px';
        this.bb_wrapper.style.height = this.bb_state.canvas_h + 'px';
        canvas_wrap.appendChild(this.bb_wrapper);

        // tile_renderer / overlay_canvas / DrawingEngine 子模块
        // 延迟到首次 open() 中初始化，减少应用启动时不必要的 canvas 创建
        this.tile_renderer = null;
        this.overlay_canvas = null;
        this.overlay_ctx = null;

        // 初始化状态位置：居中画布
        const init_x = -(this.bb_state.canvas_w - this.screen_w) / 2;
        const init_y = -(this.bb_state.canvas_h - this.screen_h) / 2;
        this.bb_state.canvas_x = init_x;
        this.bb_state.canvas_y = init_y;
        this.bb_state.scale = 1;
        this._update_move_bound();
        this._update_canvas_position();
        this._sync_bb_transform();

        // 初始化 DrawingEngine（仅构造函数，子模块延迟初始化）
        this.drawing_engine = new DrawingEngine({
            get_rect: () => this.bb_wrapper?.getBoundingClientRect() || null,
            get_scale: () => this.bb_state.scale,
            get_origin: () => ({ x: this.bb_state.canvas_x, y: this.bb_state.canvas_y }),
            set_origin: (x, y) => {
                this.bb_state.canvas_x = x;
                this.bb_state.canvas_y = y;
                this._update_canvas_position();
                this._sync_bb_transform();
            },
            get_stroke_history: () => this.page_manager.get_current_page()?.stroke_history || null,
            get_eraser_hint_rect: () => this.bb_wrapper?.parentElement?.getBoundingClientRect() || null,
            render_all_strokes: (bounds) => this._render_all_strokes(bounds),
            on_stroke_finalized: (stroke, bounds) => {
                if (this.tile_renderer) {
                    const page = this.page_manager.get_current_page();
                    if (page) {
                        this.tile_renderer._strokeHistoryRef = page.stroke_history;
                        this.tile_renderer.add_stroke?.(stroke);
                    }
                }
            }
        });

        this.page_manager.init();

        // 隐藏 #blackboardCanvas（使用 tile_renderer + overlay canvas 代替）
        if (this._el.canvas) {
            this._el.canvas.style.display = 'none';
        }

        // 缓存标题栏和阅读器工具栏 DOM 引用，黑板打开时隐藏/恢复
        this._cached_titlebar = document.querySelector('.titlebar');
        this._cached_titlebar_display = null;
        this._cached_dr_toolbar = document.getElementById('drToolbar');
        this._cached_dr_toolbar_display = null;

        // resize 时失效 container rect 缓存，避免下一次 _handle_wheel 读到过期 rect
        this._resize_handler = () => this._invalidate_cached_container_rect();
        window.addEventListener('resize', this._resize_handler, { passive: true });

        this._setup_events();
        this._setup_keyboard_events();
        this._sync_page_buttons();
        this._update_page_indicator();
    }

    /** 延迟初始化 Canvas 层：tile_renderer、overlay、DrawingEngine 子模块 */
    _lazy_init_canvas() {
        if (this.tile_renderer) return; // 已初始化

        const canvas_wrap = this._el.canvasWrap;

        // 分块渲染器
        this.tile_renderer = new window.TileRenderer({
            strokeHistoryRef: null,
            getVisibleRect: () => this._fetch_visible_rect(),
            canvasW: this.bb_state.canvas_w,
            canvasH: this.bb_state.canvas_h,
            skipBaseCache: true
        });
        this.tile_renderer.init_tiles(this.bb_wrapper, 1);

        // 覆盖层（实时预览，独立于分块包装器之外）
        this.overlay_canvas = document.createElement('canvas');
        this.overlay_canvas.className = 'blackboard-overlay';
        this.overlay_canvas.style.width = this.screen_w + 'px';
        this.overlay_canvas.style.height = this.screen_h + 'px';
        canvas_wrap.appendChild(this.overlay_canvas);
        this.overlay_ctx = this.overlay_canvas.getContext('2d');
        this.overlay_ctx.imageSmoothingEnabled = false;

        // batch_draw 使用覆盖层
        this.drawing_engine.init_batch_draw(this.overlay_canvas, this.overlay_ctx);
        this.drawing_engine.batch_draw._tileRenderer = this.tile_renderer;
        // 按 DPR 调整 overlay canvas 实际像素尺寸
        const init_dpr = this.drawing_engine.batch_draw._overlayDpr || 1;
        this.overlay_canvas.width = Math.ceil(this.screen_w * init_dpr);
        this.overlay_canvas.height = Math.ceil(this.screen_h * init_dpr);

        // 橡皮擦提示
        this.drawing_engine.init_eraser_hint(canvas_wrap);

        // 历史管理器由 open() 中 push_history_isolate 负责初始化，此处不重复调用
    }

    _setup_keyboard_events() {
        document.addEventListener('keydown', (e) => {
            if (!this.is_open) return;

            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }

            if (e.key === 'ArrowUp' || e.key === 'PageUp') {
                e.preventDefault();
                this.handle_page_nav_prev();
                return;
            }
            if (e.key === 'ArrowDown' || e.key === 'PageDown') {
                e.preventDefault();
                this.handle_page_nav_next();
                return;
            }
        });
    }

    _update_button_status() {
        const can_undo = history_validate_undo();
        // 黑板自己的撤销按钮
        if (this._el.btnUndo) this._el.btnUndo.disabled = !can_undo;
        // 主工具栏撤销按钮（黑板开着时被隐藏，但保留状态同步）
        const dom = window.dom;
        if (dom.btnUndo) dom.btnUndo.disabled = !can_undo;
    }

    /** 同步黑板模式按钮激活态（复用主题 .active 类） */
    _update_mode_buttons(mode) {
        const btns = this._el.toolbar?.querySelectorAll('.function-btn') || [];
        for (const btn of btns) {
            btn.classList.toggle('active', btn.dataset.bbMode === mode);
        }
    }

    /** 根据主题配置控制工具栏文字显隐 */
    _apply_text_visibility() {
        const show = window.ThemeManager?.theme_fetch_toolbar_text?.() ?? true;
        const tb = this._el.toolbar;
        if (!tb) return;
        tb.querySelectorAll('.toolbar-btn span').forEach(span => {
            span.style.display = show ? '' : 'none';
        });
        tb.classList.toggle('hide-text', !show);
    }

    async open() {
        if (this.is_open) return;

        // 首次打开时延迟初始化 tile_renderer / overlay / DrawingEngine 子模块
        this._lazy_init_canvas();

        if (window.main_submit_stroke) {
            await window.main_submit_stroke();
        }
        if (window.batchDrawManager) {
            window.batchDrawManager.batch_draw_delete_all();
        }
        this.drawing_engine.set_draw_mode('move');
        if (window.main_update_mode) {
            window.main_update_mode('move');
        }
        this._update_mode_buttons('move');

        // 使用 DrawingEngine 隔离历史
        this.drawing_engine.push_history_isolate(() => {
            this._update_button_status();
        });

        // 面板弹出过渡期间禁止绘制（修复 getBoundingClientRect 过渡中偏移 bug）
        this.drawing_engine.set_painting_allowed(false);

        this.is_open = true;
        this._tiles_changed_since_snapshot = false;

        const panel = this._el.panel;
        panel.classList.add('active');

        // 监听 CSS transition 实际结束，替代固定 400ms 等待
        const transition_promise = new Promise(resolve => {
            let resolved = false;
            const on_end = (e) => {
                if (e.propertyName === 'transform') {
                    panel.removeEventListener('transitionend', on_end);
                    resolved = true;
                    resolve();
                }
            };
            panel.addEventListener('transitionend', on_end);
            // 安全兜底：防止 transitionend 因故未触发
            setTimeout(() => {
                if (!resolved) {
                    panel.removeEventListener('transitionend', on_end);
                    resolve();
                }
            }, 600);
        });

        this._switch_toolbar(true);
        this._apply_text_visibility();

        this.draw_mode = 'comment';
        this.drawing_engine.set_draw_mode('comment');
        if (window.main_update_mode) {
            await window.main_update_mode('comment');
        }
        this._update_mode_buttons('comment');

        // 等待面板过渡完成后再允许绘制
        await transition_promise;
        this.drawing_engine.set_painting_allowed(true);

        this._last_loaded_index = -1;
        await this._load_page_strokes(this.page_manager.current_index);
        this._update_page_indicator();
        this._update_button_status();
    }

    async close() {
        if (!this.is_open) return;
        this.is_open = false;

        if (this._animate_timer_id !== null) {
            clearTimeout(this._animate_timer_id);
            this._animate_timer_id = null;
        }
        if (this.bb_wrapper) {
            this.bb_wrapper.classList.remove('smooth-transform');
            this.bb_wrapper.style.willChange = '';
        }
        // 清理 gesture 模块 — 仅重置状态，不销毁 InputSource/PinchZoomSource。
        // 两者保持附着但不会收到事件（面板关闭时 transform 移出屏幕）。
        // 防止下次 open() 时手势事件丢失导致无法批注/缩放。
        if (this._input_source) {
            // 重置活跃指针状态（防止残留状态污染下次 open）
            this._input_source._emitAllUp(VirtualDeviceType.LostCapture);
            // 重新 attach 确保状态干净
            this._input_source.detach();
            this._input_source.attach();
        }
        // 重置 PinchZoomSource 内部状态（不移除监听）
        if (this._pinch_source) {
            this._pinch_source._isPinching = false;
        }
        this.bb_state.is_scaling = false;
        this.bb_state.is_dragging = false;

        // 通过 DrawingEngine 提交未完成的笔画
        if (this.drawing_engine.is_drawing || this.drawing_engine.current_stroke) {
            await this.drawing_engine._submit_stroke();
        }
        this.drawing_engine._hide_eraser_hint();

        // 关闭前保存当前页的 undo/redo 和 tile 快照
        const cur_page = this.page_manager.get_current_page();
        if (cur_page) {
            cur_page.undo_list = [...history_state.undo_list];
            cur_page.redo_list = [...history_state.redo_list];
            if (this.tile_renderer) this._save_page_tile_snapshots(cur_page);
        }

        // DrawingEngine 恢复全局历史
        this.drawing_engine.pop_history_isolate();

        this._el.panel.classList.remove('active');

        this._switch_toolbar(false);
    }

    _switch_toolbar(bb_active) {
        // 隐藏/恢复标题栏
        if (this._cached_titlebar) {
            if (bb_active) {
                this._cached_titlebar_display = this._cached_titlebar.style.display;
                this._cached_titlebar.style.display = 'none';
            } else {
                if (this._cached_titlebar_display !== undefined) {
                    this._cached_titlebar.style.display = this._cached_titlebar_display || '';
                }
                this._cached_titlebar_display = null;
            }
        }
        // 隐藏/恢复阅读器工具栏（z-index 100 > 黑板面板 z-index 10）
        if (this._cached_dr_toolbar) {
            if (bb_active) {
                this._cached_dr_toolbar_display = this._cached_dr_toolbar.style.display;
                this._cached_dr_toolbar.style.display = 'none';
            } else {
                if (this._cached_dr_toolbar_display !== undefined) {
                    this._cached_dr_toolbar.style.display = this._cached_dr_toolbar_display || '';
                }
                this._cached_dr_toolbar_display = null;
            }
        }
        if (!bb_active) {
            if (window.main_update_mode) {
                window.main_update_mode('move');
            }
            if (window.main_update_tabs) {
                window.main_update_tabs();
            }
        }
    }

    _setup_events() {
        const wrap = this._el.canvasWrap;
        if (!wrap) return;

        const input = new InputSource(wrap);
        this._input_source = input;
        input.attach();

        // ====== 输入事件（绘制、手掌擦除、拖拽平移） ======
        input.on('inputDown', async (ev) => {
            if (!this.is_open) return;
            this._cancel_momentum();
            this.bb_state.cached_inv_scale = 1 / this._fetch_safe_scale();

            // 缩放中不处理任何状态切换，直到手势结束重置
            if (this.bb_state.is_zooming) return;

            // 多指触摸时跳过首指以外的输入（留给 PinchZoomSource 处理）
            if (input.activeCount > 1) return;

            // 拖拽平移（move 模式）
            if (this.draw_mode === 'move') {
                this.bb_state.is_dragging = true;
                this.bb_state.start_drag_x = ev.position.x - this.bb_state.canvas_x;
                this.bb_state.start_drag_y = ev.position.y - this.bb_state.canvas_y;
                this._last_canvas_x = this.bb_state.canvas_x;
                this._last_canvas_y = this.bb_state.canvas_y;
                this._gesture_vx = 0;
                this._gesture_vy = 0;
                this._touch_enable_gpu();
                return;
            }

            // PointerEvent / MouseEvent 路径 → 委托 DrawingEngine
            if (window.PointerEvent || ev.originEvent?.type === 'mousedown') {
                this.drawing_engine.handle_pointer_down(ev.originEvent);
                return;
            }

            // TouchEvent 路径（非 PointerEvent）：单指绘制
            if (!window.PointerEvent && ev.originEvent?.touches?.length === 1) {
                this.drawing_engine.draw_canvas_rect = this._get_canvas_rect();
                if (!this.drawing_engine.draw_canvas_rect) return;
                this.drawing_engine.is_drawing = true;
                const inv = this.bb_state.cached_inv_scale;
                const touch = ev.originEvent.touches[0];
                this.drawing_engine.last_x = (touch.clientX - this.drawing_engine.draw_canvas_rect.left) * inv;
                this.drawing_engine.last_y = (touch.clientY - this.drawing_engine.draw_canvas_rect.top) * inv;
                this.drawing_engine._start_stroke(this.draw_mode === 'comment' ? 'draw' : 'erase');
            }
        });

        input.on('inputMove', (ev) => {
            if (!this.is_open) return;

            const s = this.bb_state;

            // 拖拽平移
            if (s.is_dragging) {
                s.canvas_x = ev.position.x - s.start_drag_x;
                s.canvas_y = ev.position.y - s.start_drag_y;
                this._update_canvas_position();
                this._update_bb_gesture_velocity();
                // 脏检查 + rAF 节流
                if (this._bb_last_transform.x !== s.canvas_x ||
                    this._bb_last_transform.y !== s.canvas_y ||
                    this._bb_last_transform.scale !== s.scale) {
                    this._sync_bb_transform_schedule(s.canvas_x, s.canvas_y, s.scale);
                }
                return;
            }

            if (this.draw_mode === 'eraser') {
                this.drawing_engine._update_eraser_hint_position(ev.position.x, ev.position.y);
            }

            // PointerEvent / MouseEvent 路径
            if (window.PointerEvent || ev.originEvent?.type === 'mousemove') {
                this.drawing_engine.handle_pointer_move(ev.originEvent);
                return;
            }

            // TouchEvent 路径
            if (!window.PointerEvent && ev.originEvent?.touches?.length === 1 && this.drawing_engine.is_drawing) {
                this.drawing_engine._handle_single_touch_draw(ev.originEvent.touches[0]);
            }
        });

        input.on('inputUp', async (ev) => {
            if (!this.is_open) return;

            const s = this.bb_state;

            // 拖拽结束
            if (s.is_dragging) {
                s.is_dragging = false;
                // 立即 flush 最终位置（取消 rAF 节流）
                this._flush_bb_transform(s.canvas_x, s.canvas_y, s.scale);
                this._touch_schedule_disable_gpu();
                if (this.draw_mode === 'move' && (Math.abs(this._gesture_vx) > 2 || Math.abs(this._gesture_vy) > 2)) {
                    this._update_move_bound();
                    this._update_canvas_position();
                    this._start_momentum();
                }
                return;
            }

            // PointerEvent / MouseEvent 路径
            if (window.PointerEvent || ev.originEvent?.type === 'mouseup') {
                await this.drawing_engine.handle_pointer_up(ev.originEvent);
                return;
            }

            // TouchEvent 路径
            if (!window.PointerEvent) {
                if (this.drawing_engine.is_drawing || this.drawing_engine.current_stroke) {
                    this.drawing_engine.is_drawing = false;
                    this.drawing_engine.draw_canvas_rect = null;
                    await this.drawing_engine._submit_stroke();
                }
            }
        });

        // ====== 两指捏合缩放 ======
        const bbUseV2 = window.DRAW_CONFIG?.pinchZoomV2 === true;
        const pinch = bbUseV2 ? new PinchZoomSourceV2(input) : new PinchZoomSource(input);
        this._pinch_source = pinch;

        pinch.onPinchStarted = (ev) => {
            if (!this.is_open) return;
            this._cancel_momentum();
            // 取消任何 pending 的 transform rAF，避免残留覆盖新位置
            if (this._bb_transform_raf_id !== null) {
                cancelAnimationFrame(this._bb_transform_raf_id);
                this._bb_transform_raf_id = null;
            }
            this._pending_bb_transform = null;

            // 清除上一轮缩放残留状态
            this._is_overscrolling = false;

            const s = this.bb_state;
            s.cached_inv_scale = 1 / this._fetch_safe_scale();

            // 取消当前笔画
            if (this.drawing_engine.is_drawing || this.drawing_engine.current_stroke) {
                this.drawing_engine.is_drawing = false;
                if (this.drawing_engine.current_stroke) {
                    this.drawing_engine._submit_stroke();
                }
                if (this.drawing_engine.batch_draw) {
                    this.drawing_engine.batch_draw.batch_draw_delete_all();
                }
            }

            s.is_dragging = false;
            s.is_scaling = true;
            s.start_scale = s.scale;

            if (ev.finger0) {
                s.start_finger0_cx = (ev.finger0.x - s.canvas_x) / s.scale;
                s.start_finger0_cy = (ev.finger0.y - s.canvas_y) / s.scale;
            }
            // V2 中点锚点
            s.start_mid_cx = (ev.centerX - s.canvas_x) / s.scale;
            s.start_mid_cy = (ev.centerY - s.canvas_y) / s.scale;
            s.start_canvas_x = s.canvas_x;
            s.start_canvas_y = s.canvas_y;
            this._last_canvas_x = s.canvas_x;
            this._last_canvas_y = s.canvas_y;
            this._gesture_vx = 0;
            this._gesture_vy = 0;
            this._touch_enable_gpu();
        };

        pinch.onPinchDelta = (ev) => {
            if (!this.is_open) return;
            const s = this.bb_state;
            if (!s.is_scaling) return;

            const max_scale = window.DRAW_CONFIG ? window.DRAW_CONFIG.maxScaleImage : 3;
            const min_scale = window.DRAW_CONFIG?.minScale || 0.5;

            if (bbUseV2) {
                // V2: 增量式缩放 + 中点锚点
                const newScale = s.scale * ev.scale;
                s.scale = Math.max(min_scale, Math.min(max_scale, newScale));
                s.canvas_x = ev.centerX - s.start_mid_cx * s.scale;
                s.canvas_y = ev.centerY - s.start_mid_cy * s.scale;
            } else {
                const unclamped_s = s.start_scale * ev.scale;
                s.scale = Math.max(min_scale, Math.min(max_scale, unclamped_s));

                if (s.scale !== unclamped_s) {
                    const fdx = ev.finger0.x - ev.finger1.x;
                    const fdy = ev.finger0.y - ev.finger1.y;
                    this._pinch_source.resetScaleReference(Math.sqrt(fdx * fdx + fdy * fdy));
                    s.start_finger0_cx = (ev.finger0.x - s.canvas_x) / s.scale;
                    s.start_finger0_cy = (ev.finger0.y - s.canvas_y) / s.scale;
                    s.start_scale = s.scale;
                }

                s.canvas_x = ev.finger0.x - s.start_finger0_cx * s.scale;
                s.canvas_y = ev.finger0.y - s.start_finger0_cy * s.scale;
            }

            this._update_move_bound();
            this._update_canvas_position();

            // 弹性 overscroll（仅显示层）
            const mb = s.move_bound;
            this._is_overscrolling = false;
            let display_x = s.canvas_x;
            let display_y = s.canvas_y;

            if (s.canvas_x < mb.min_x) {
                const excess = s.canvas_x - mb.min_x;
                this._is_overscrolling = true;
                display_x = mb.min_x + excess * 0.3;
                this._overscroll_display_x = display_x;
                this._overscroll_display_y = display_y;
            } else if (s.canvas_x > mb.max_x) {
                const excess = s.canvas_x - mb.max_x;
                this._is_overscrolling = true;
                display_x = mb.max_x + excess * 0.3;
                this._overscroll_display_x = display_x;
                this._overscroll_display_y = display_y;
            }

            if (s.canvas_y < mb.min_y) {
                const excess = s.canvas_y - mb.min_y;
                this._is_overscrolling = true;
                display_y = mb.min_y + excess * 0.3;
                this._overscroll_display_x = display_x;
                this._overscroll_display_y = display_y;
            } else if (s.canvas_y > mb.max_y) {
                const excess = s.canvas_y - mb.max_y;
                this._is_overscrolling = true;
                display_y = mb.max_y + excess * 0.3;
                this._overscroll_display_x = display_x;
                this._overscroll_display_y = display_y;
            }

            this._set_zooming();
            this._update_bb_gesture_velocity();

            // rAF 节流更新 transform
            this._sync_bb_transform_schedule(display_x, display_y, s.scale);
        };

        pinch.onPinchCompleted = () => {
            if (!this.is_open) return;
            const s = this.bb_state;
            s.is_scaling = false;
            // 取消 rAF 节流，避免回调覆盖后续 smooth transition
            if (this._bb_transform_raf_id !== null) {
                cancelAnimationFrame(this._bb_transform_raf_id);
                this._bb_transform_raf_id = null;
            }
            this._pending_bb_transform = null;
            this._cancel_zoom_debounce();

            if (input.activeCount === 1 && this.draw_mode === 'move') {
                const ev = input.activeEvents[0];
                if (ev) {
                    s.is_dragging = true;
                    s.start_drag_x = ev.position.x - s.canvas_x;
                    s.start_drag_y = ev.position.y - s.canvas_y;
                }
            } else if (input.activeCount === 0) {
                if (this._is_overscrolling) {
                    this._is_overscrolling = false;
                    const mb = this.bb_state.move_bound;
                    const snap_x = Math.max(mb.min_x, Math.min(mb.max_x, this._overscroll_display_x));
                    const snap_y = Math.max(mb.min_y, Math.min(mb.max_y, this._overscroll_display_y));
                    this._sync_bb_transform_smooth(snap_x, snap_y, this.bb_state.scale, 250);
                } else {
                    this._update_move_bound();
                    this._update_canvas_position();
                    this._sync_bb_transform();
                    if (this.draw_mode === 'move' && (Math.abs(this._gesture_vx) > 2 || Math.abs(this._gesture_vy) > 2)) {
                        this._start_momentum();
                    }
                }
                this._touch_schedule_disable_gpu();
            }
        };

        // ====== 滚轮缩放（独立于 gesture 模块） ======
        wrap.addEventListener('wheel', (e) => this._handle_wheel(e), { passive: false });
    }

    _teardown_gesture() {
        if (this._pinch_source) {
            this._pinch_source.destroy();
            this._pinch_source = null;
        }
        if (this._input_source) {
            this._input_source.detach();
            this._input_source = null;
        }
    }

    /** 窗口 resize 时失效 container rect 缓存 */
    _invalidate_cached_container_rect() {
        this._cached_container_rect = null;
    }

    _handle_wheel(e) {
        if (!this.is_open) return;
        if (this.drawing_engine?.is_drawing) return;
        if (this.tile_renderer) this.tile_renderer.cancel_idle_shrink();
        e.preventDefault();

        const s = this.bb_state;
        const max_scale = window.DRAW_CONFIG ? window.DRAW_CONFIG.maxScaleImage : 3;
        const min_scale = window.DRAW_CONFIG ? window.DRAW_CONFIG.minScale : 0.5;
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const new_scale = Math.max(min_scale, Math.min(max_scale, s.scale + delta));

        if (new_scale !== s.scale) {
            // 缓存 container rect 避免每次滚轮触发 layout 回流
            if (!this._cached_container_rect) {
                this._cached_container_rect = (window.dom.mainContent || window.dom.canvasContainer).getBoundingClientRect();
            }
            const container_rect = this._cached_container_rect;
            const mouse_x = e.clientX - container_rect.left;
            const mouse_y = e.clientY - container_rect.top;

            const old_scale = s.scale;
            const scale_ratio = new_scale / old_scale;
            const target_x = mouse_x - (mouse_x - s.canvas_x) * scale_ratio;
            const target_y = mouse_y - (mouse_y - s.canvas_y) * scale_ratio;

            s.scale = new_scale;
            s.canvas_x = target_x;
            s.canvas_y = target_y;

            this._update_move_bound();
            this._update_canvas_position();
            this._sync_bb_transform_smooth(s.canvas_x, s.canvas_y, s.scale, 200);

            // mark_all 与 update_visible_tile_dpr 在缩放时重复，移除冗余的全标记
            // _sync_bb_transform_smooth → update_visible_tile_dpr 已处理 DPR 变化
        }
    }

    setup_toolbar_events() {
        // 关闭
        if (this._el.btnClose) {
            this._el.btnClose.addEventListener('click', () => this.close());
        }

        // 模式按钮 — 同步 blackboard.draw_mode、drawing_engine.draw_mode 与按钮视觉
        const handle_mode_click = (btn) => {
            const mode = btn.dataset.bbMode;
            if (this.draw_mode === mode) {
                // 已激活的按钮再次点击 → 唤出笔控制面板（move 无面板）
                if (mode === 'move') {
                    this.drawing_engine.set_draw_mode('move');
                    window.main_update_mode?.('move');
                    this._update_mode_buttons('move');
                    return;
                }
                window.main_show_pen_control_panel?.(btn, mode);
            } else {
                this.draw_mode = mode;
                this.drawing_engine.set_draw_mode(mode);
                window.main_update_mode?.(mode);
                this._update_mode_buttons(mode);
            }
        };
        const mode_btns = this._el.toolbar?.querySelectorAll('.function-btn') || [];
        for (const btn of mode_btns) {
            btn.addEventListener('click', () => handle_mode_click(btn));
        }

        // 撤销
        if (this._el.btnUndo) {
            this._el.btnUndo.addEventListener('click', () => this.handle_undo());
        }
        
        // 翻页
        if (this._el.pagePrev) {
            this._el.pagePrev.addEventListener('click', () => this.handle_page_nav_prev());
        }
        if (this._el.pageNext) {
            this._el.pageNext.addEventListener('click', () => this.handle_page_nav_next());
        }
        if (this._el.pageAdd) {
            this._el.pageAdd.addEventListener('click', () => this.handle_page_add());
        }
    }

    _get_canvas_rect() {
        return this.bb_wrapper ? this.bb_wrapper.getBoundingClientRect() : null;
    }

    /** 清理触摸手势的 rAF 节流和 GPU 合成层 */
    _cleanup_touch_gesture() {
        if (this._touch_raf_id !== null) {
            cancelAnimationFrame(this._touch_raf_id);
            this._touch_raf_id = null;
        }
        this._touch_pending_data = null;
        // 标记缩放结束，让后续 _sync_bb_transform 可以更新 tile
        // 注意：不取消 debounce 定时器，由定时器完成最终 tile 刷新
        this.bb_state.is_zooming = false;
        this._touch_schedule_disable_gpu();
    }

    // ====== 快照 ======

    _save_tile_snapshots() {
        const tr = this.tile_renderer;
        if (!tr) return null;
        if (!this._tiles_changed_since_snapshot) return null;
        this._tiles_changed_since_snapshot = false;
        return tr.tileInfos.map(info => {
            const w = info.canvas.width;
            const h = info.canvas.height;
            return info.ctx.getImageData(0, 0, w, h);
        });
    }

    _restore_tile_snapshots(snapshots) {
        const tr = this.tile_renderer;
        if (!tr || !snapshots) return false;
        for (let i = 0; i < tr.tileInfos.length; i++) {
            const info = tr.tileInfos[i];
            const snap = snapshots[i];
            if (snap && info.canvas && snap.width === info.canvas.width && snap.height === info.canvas.height) {
                info.ctx.putImageData(snap, 0, 0);
            }
        }
        return true;
    }

    // ====== 渲染 — 使用主渲染管线 ======

    async _render_all_strokes(bounds) {
        const page = this.page_manager.get_current_page();
        if (!page) return;

        if (this.tile_renderer) {
            const orig_scale = window.state.scale;
            window.state.scale = this.bb_state.scale;

            window.main_reset_context_state();
            this.tile_renderer._strokeHistoryRef = page.stroke_history;
            this.tile_renderer.mark_strokes_changed();

            if (bounds && isFinite(bounds.minX) && isFinite(bounds.minY) &&
                          isFinite(bounds.maxX) && isFinite(bounds.maxY)) {
                const infos = this.tile_renderer.infos_for_segment(
                    bounds.minX, bounds.minY,
                    bounds.maxX, bounds.maxY
                );
                for (const info of infos) {
                    this.tile_renderer.dirty.add(info.key);
                }
            } else {
                this.tile_renderer.mark_all();
            }

            try {
                this.tile_renderer.rebuild_all();
            } finally {
                window.state.scale = orig_scale;
            }
            this._tiles_changed_since_snapshot = true;
        }
        page.snapshot_dirty = true;
    }

    _save_page_tile_snapshots(page) {
        const snapshots = this._save_tile_snapshots();
        if (snapshots) {
            page.tile_snapshots = snapshots;
            page.snapshot_dirty = false;
        }
    }

    _restore_page_tile_snapshots(page) {
        const restored = this._restore_tile_snapshots(page.tile_snapshots);
        if (restored) this._tiles_changed_since_snapshot = true;
        return restored;
    }

    async _rebuild_from_history(page) {
        if (!this.tile_renderer) return;

        const orig_scale = window.state.scale;
        window.state.scale = this.bb_state.scale;

        window.main_reset_context_state();
        this.tile_renderer._strokeHistoryRef = page.stroke_history;
        this.tile_renderer.mark_strokes_changed();
        this.tile_renderer.mark_all();

        try {
            this.tile_renderer.rebuild_all();
        } finally {
            window.state.scale = orig_scale;
        }
    }

    async _load_page_strokes(index) {
        // 保存当前页的 undo/redo 和历史和 tile 快照
        if (this._last_loaded_index >= 0 && this._last_loaded_index < this.page_manager.pages_list.length) {
            const prev_page = this.page_manager.pages_list[this._last_loaded_index];
            prev_page.undo_list = history_state.undo_list;
            prev_page.redo_list = history_state.redo_list;
            this._save_page_tile_snapshots(prev_page);
        }
        this._last_loaded_index = index;

        const page = this.page_manager.pages_list[index];
        if (!page) return;

        // 恢复目标页的 undo/redo 历史
        history_state.undo_list = page.undo_list || [];
        history_state.redo_list = page.redo_list || [];
        history_reset_executing();

        // 优先从 tile 快照恢复（像素级精确，保留 batch draw 的擦除效果）
        // 没有快照或标记脏时从 stroke_history 重建
        if (page.snapshot_dirty || !page.tile_snapshots) {
            await this._rebuild_from_history(page);
            this._save_page_tile_snapshots(page);
        } else {
            this._restore_page_tile_snapshots(page);
        }
        this._update_button_status();
    }

    // ====== 撤销与清空 — 委托 DrawingEngine ======

    async handle_undo() {
        await this.drawing_engine.handle_undo();
        this._update_button_status();
    }

    async handle_clear() {
        const page = this.page_manager.get_current_page();
        await this.drawing_engine.handle_clear(page?.stroke_history);
        this._update_button_status();
    }

    // ====== 多页导航 ======

    async handle_page_nav_prev() {
        if (this.drawing_engine.is_drawing) return;
        if (this.drawing_engine.current_stroke) {
            await this.drawing_engine._submit_stroke();
        }
        const moved = this.page_manager.nav_prev();
        if (moved) {
            await this._load_page_strokes(this.page_manager.current_index);
            this._update_page_indicator();
            this._sync_page_buttons();
            this._update_button_status();
        }
    }

    async handle_page_nav_next() {
        if (this.drawing_engine.is_drawing) return;
        if (this.drawing_engine.current_stroke) {
            await this.drawing_engine._submit_stroke();
        }
        const moved = this.page_manager.nav_next();
        if (moved) {
            await this._load_page_strokes(this.page_manager.current_index);
            this._update_page_indicator();
            this._sync_page_buttons();
            this._update_button_status();
        }
    }

    async handle_page_add() {
        if (this.drawing_engine.is_drawing) return;
        if (this.drawing_engine.current_stroke) {
            await this.drawing_engine._submit_stroke();
        }
        this.page_manager.add_page();
        const new_idx = this.page_manager.current_index;
        await this._load_page_strokes(new_idx);
        this._update_page_indicator();
        this._sync_page_buttons();
        this._update_page_indicator();
        this._update_button_status();
    }


    _update_page_indicator() {
        if (this._el.pageIndicator) {
            this._el.pageIndicator.textContent = `${this.page_manager.current_index + 1} / ${this.page_manager.get_page_count()}`;
        }
    }

    _sync_page_buttons() {
        if (this._el.pagePrev) this._el.pagePrev.disabled = this.page_manager.current_index <= 0;
        if (this._el.pageNext) this._el.pageNext.disabled = this.page_manager.current_index >= this.page_manager.get_page_count() - 1;
        if (this._el.pageAdd) this._el.pageAdd.disabled = false;
    }

    resize(screen_w, screen_h) {
        this.screen_w = screen_w;
        this.screen_h = screen_h;

        // 重新计算画布大小
        this.bb_state.canvas_w = Math.floor(screen_w * 2);
        this.bb_state.canvas_h = Math.floor(screen_h * 2);

        // overlay 在首次 open() 前为 null，首次 open 时才会创建
        if (this.overlay_canvas) {
            const dpr = this.drawing_engine?.batch_draw?._overlayDpr || 1;
            this.overlay_canvas.width = Math.ceil(screen_w * dpr);
            this.overlay_canvas.height = Math.ceil(screen_h * dpr);
            this.overlay_canvas.style.width = screen_w + 'px';
            this.overlay_canvas.style.height = screen_h + 'px';
            this.overlay_ctx.imageSmoothingEnabled = false;
        }

        // 重新居中画布
        const init_x = -(this.bb_state.canvas_w - screen_w) / 2;
        const init_y = -(this.bb_state.canvas_h - screen_h) / 2;
        this.bb_state.canvas_x = init_x;
        this.bb_state.canvas_y = init_y;
        this._cached_move_bound_scale = null;
        this._cached_visible_rect = null;
        this._cached_visible_rect_scale = null;
        this._cached_visible_rect_x = null;
        this._cached_visible_rect_y = null;
        this._update_move_bound();
        this._update_canvas_position();
        this._sync_bb_transform();

        if (this.tile_renderer) {
            const page = this.page_manager.get_current_page();
            const orig_scale = window.state.scale;
            window.state.scale = this.bb_state.scale;

            window.main_reset_context_state();
            if (page) this.tile_renderer._strokeHistoryRef = page.stroke_history;
            this.tile_renderer.mark_all();

            try {
                this.tile_renderer.rebuild_all();
            } finally {
                window.state.scale = orig_scale;
            }
        }
    }

    async destroy() {
        if (this._resize_handler) {
            window.removeEventListener('resize', this._resize_handler);
            this._resize_handler = null;
        }
        this._cached_container_rect = null;
        this._cached_titlebar = null;
        this._cached_dr_toolbar = null;

        // 清理手势资源
        this._teardown_gesture();

        if (this.drawing_engine) {
            if (this.drawing_engine.is_drawing || this.drawing_engine.current_stroke) {
                await this.drawing_engine._submit_stroke();
            }
            this.drawing_engine.destroy();
        }
        window.__HISTORY_ISOLATED = false;
        this._last_loaded_index = -1;
        this.page_manager.destroy();

        if (this.tile_renderer) {
            this.tile_renderer.destroy();
            this.tile_renderer = null;
        }

        if (this.bb_wrapper && this.bb_wrapper.parentNode) {
            this.bb_wrapper.parentNode.removeChild(this.bb_wrapper);
            this.bb_wrapper = null;
        }

        if (this.overlay_canvas && this.overlay_canvas.parentNode) {
            this.overlay_canvas.parentNode.removeChild(this.overlay_canvas);
        }

        // 清理面板 DOM
        if (this._el.panel && this._el.panel.parentNode) {
            this._el.panel.parentNode.removeChild(this._el.panel);
        }
        this._el = {
            panel: null, canvasWrap: null, canvas: null,
            toolbar: null, btnMove: null, btnComment: null, btnEraser: null,
            btnUndo: null, pagePrev: null, pageNext: null, pageAdd: null,
            pageIndicator: null, btnClose: null
        };

        this.overlay_canvas = null;
        this.overlay_ctx = null;
        this.drawing_engine = null;
        this.is_open = false;
    }
}

const blackboardManager = new BlackboardManager();
window.blackboardManager = blackboardManager;
export default blackboardManager;
