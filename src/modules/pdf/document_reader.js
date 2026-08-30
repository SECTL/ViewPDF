/**
 * 文档阅读器管理器 —— 连续滚动、逐页批注、懒加载 + Canvas 分块渲染
 * 从顶部弹出的独立阅读面板，复用 main.js 的绘制管道与撤销系统
 * 工具栏全部在右侧，支持 IntersectionObserver 懒加载
 */

import { InputSource, PinchZoomSourceV2, ZoomWallDamper } from '../gesture/index.js';
import { DocumentReaderPageManager } from './document_reader_page.js';
import {
    history_execute_command,
    history_init_manager,
    history_validate_undo,
    history_handle_undo,
    history_handle_state_change,
    history_trim_undo_front,
    history_peek_undo,
    DrawCommand,
    ClearCommand,
    history_state
} from '../history.js';

class DocumentReaderManager {
    constructor() {
        this.is_open = false;
        this.page_manager = new DocumentReaderPageManager();

        this.draw_mode = 'comment';
        this.is_drawing = false;
        this.current_stroke = null;

        this.active_page_index = -1;
        this.saved_history_state = null;
        this.folder_index = -1;
        // 当前打开文档的 folder 对象引用（fileList 重排/关闭期间索引可能失效，引用始终可靠）
        this._active_folder = null;

        // 防抖主动保存：批注/翻页变更后延迟落盘，应用被直接关闭或崩溃时数据也已持久化
        this._ann_save_timer = null;

        // 打开请求序号：快速连点标签时合并排队中的过期请求，只执行最新一次
        this._open_req_id = 0;

        // 快照保存门闩：仅在 open() 完整完成后允许写批注缓存。
        // 防止退出/防抖保存在切换加载中途把未恢复完成的空状态写回缓存，
        // 导致该文档历史批注被清空（高压下切换耗时拉长时风险显著）
        this._save_ready = false;

        // 页码器远跳两样本确认：几何缓存瞬态错误会造成页码单帧乱跳（如 4→5 时闪 1/24）
        this._pending_far_target = -1;

        // 渲染失败自愈：连败计数与自动重载互斥标志
        this._render_fail_streak = 0;
        this._reloading_doc = false;
        this._toast_timer = null;

        this.last_x = 0;
        this.last_y = 0;
        this.cached_draw_type = null;
        this.cached_draw_color = null;
        this.cached_draw_line_width = null;
        this.current_pressure = 0.5;
        this.current_line_width = 5;
        this.last_line_width = 5;

        this._scroll_container = null;
        this._dr_tool_group = null;

        // 缓存的 DOM 引用（避免重复 getElementById）
        this._el_undo_btn = null;
        this._el_prev_btn = null;
        this._el_next_btn = null;
        this._el_page_indicator = null;
        this._el_move_btn = null;
        this._el_comment_btn = null;
        this._el_eraser_btn = null;

        this._eraser_hint = null;
        this._eraser_hint_raf_id = null;
        this._eraser_hint_pending_pos = null;
        this.savedDrawMode = null;
        this._was_camera_open_before = false;
        this._last_loaded_index = -1;
        this._page_visible_timeout_id = null;
        this._wheel_raf_id = null;               // 滚轮缩放 rAF 节流
        this._smooth_transform_timeout_id = null; // will-change 延迟移除
        this._gpu_cleanup_delay_ms = 800;
        this._tile_keep_distance = 5;
        this._image_keep_distance = 5;
        this._blob_keep_distance = 6;
        this._wrapper_keep_distance = 8;   // 包裹层虚拟化窗口：超出此范围的页面从文档树卸载（仅留缓存坐标）
        this._layout_gap = 16;              // 页面间垂直间距（与 CSS .dr-zoom-wrapper gap 同步，构建时实测）
        this._layout_pad = 16;              // 滚动容器内边距（与 CSS padding 同步，构建时实测）
        this._prerender_distance = 5;           // 预渲染距离：静止/对称时前后各 N 屏
        this._prerender_enabled = true;         // 预渲染开关
        this._prerender_queue = [];             // 预渲染队列
        this._prerender_raf_id = null;          // 预渲染 rAF ID
        this._is_prerendering = false;          // 是否正在预渲染
        this._prerender_urgent_span = 8;        // 活动滚动时向前预渲染的紧急页数窗口（与 _wrapper_keep_distance 对齐，避免预渲染后即被卸载）
        // 滚动方向/速度感知：用于让预渲染窗口向滚动方向前倾，使用户即将到达的页
        // 在入场前就已栅格化（低 DPR 预渲染），消除下滑翻页时的白屏/卡顿感知。
        this._dr_scroll_dir = 1;                // 当前滚动方向：1=向下/-右， -1=向上/左
        this._dr_scroll_vel = 0;                // 本帧画布位移量(px)
        this._dr_last_vis_y = undefined;        // 上一次可见性扫描时的 dr_canvas_y
        this._dr_last_scroll_t = 0;             // 最后一次有效位移时间戳
        this._dr_prerender_pumping = false;     // 紧急预渲染泵是否运转
        this._dr_prerender_pump_raf = null;     // 紧急预渲染泵 rAF ID
        this._sidebar_virtual_threshold = 160;
        this._sidebar_item_height = 128;
        this._sidebar_overscan = 8;
        this._max_history_steps = 15;
        this._sidebar_thumbnail_cache = new Map(); // 缩略图缓存：page_index -> blob URL
        this._sidebar_thumbnail_cache_max = 30; // LRU 上限：保留最近 30 个缩略图
        this._thumbnail_observer = null;            // 侧边栏缩略图 IntersectionObserver

        // 分块渲染相关
        this.batch_draw = null;
        this.draw_canvas_rect = null;
        // 窗口/容器尺寸响应管线（ResizeObserver 双通道，见 _setup_container_resize_observer）
        this._container_resize_observer = null;  // 滚动容器几何观测器
        this._legacy_resize_handler = null;      // 无 ResizeObserver 环境的 window resize 回退
        this._resize_light_raf = null;           // 轻量通道 rAF（几何缓存失效 + transform 校正）
        this._resize_heavy_timer = null;         // 重量通道防抖（全量重布局 + overlay 重分配）
        this._resize_retry_timer = null;         // 最大化/最小化过渡期的延后重试定时器
        this._panel_settle_timer = null;     // 面板滑入动画结束等待的兜底定时器
        this._panel_settle_finish = null;    // 等待句柄（close 时强制完成，避免悬挂）
        this._open_watchdog_timer = null;    // 开页自愈看门狗定时器
        this._last_resize_base_w = -1;       // 上次重布局的基准页宽（未变化则跳过重量通道）
        this._last_resize_container_h = -1;  // 上次重布局的容器高（高度变化仅需轻量校正）

        // 缩放状态（Blackboard 风格：CSS transform translate3d + scale）
        this.dr_scale = 1;
        this.dr_canvas_x = 0;
        this.dr_canvas_y = 0;
        this.dr_move_bound = { min_x: 0, max_x: 0, min_y: 0, max_y: 0 };
        this.dr_is_dragging = false;
        this.dr_is_scaling = false;
        this.dr_start_drag_x = 0;
        this.dr_start_drag_y = 0;
        this.dr_start_scale = 1;
        this.dr_start_finger0_cx = 0;
        this.dr_start_finger0_cy = 0;
        this.dr_start_canvas_x = 0;
        this.dr_start_canvas_y = 0;
        this.dr_start_distance_sq = 0;
        this._dragFingerId = null;
        this._pinchProcessedFirstDelta = false;
        this.dr_min_scale = 0.25;
        this.dr_max_scale = 4;
        this.dr_cached_inv_scale = 1;

        // _dr_update_move_bound 缓存（避免每帧读 scrollWidth/scrollHeight 触发布局）
        this._dr_mb_cache_cw = -1;
        this._dr_mb_cache_ch = -1;
        this._dr_mb_cache_vw = -1;
        this._dr_mb_cache_vh = -1;
        this._dr_mb_cache_scale = -1;

        // 弹性 overscroll 状态
        this._dr_is_overscrolling = false;
        this._dr_overscroll_display_x = 0;
        this._dr_overscroll_display_y = 0;
        this._zoom_wrapper = null;
        // 视图常驻：folder_index -> 捕获的视图快照（state.viewKeepAlive 开启时生效）
        this._tab_views = new Map();
        this._view_keep_alive = () => window.state?.viewKeepAlive === true;
        // 包裹层虚拟化（默认开启）：远页从文档树彻底卸载，仅保留缓存坐标，活动标签 DOM 最小
        this._dom_virtualize = () => window.state?.domVirtualize !== false;
        this._dr_is_zooming = false;            // 缩放进行中标记，缩放结束后延迟批量重绘
        this._zoom_complete_timer = null;        // 缩放结束延迟触发重绘

        // 触摸手势优化状态
        this._touch_raf_id = null;               // 捏合缩放 rAF 节流 ID
        this._dr_touch_pending = null;            // 捏合缩放最新触摸数据（rAF 节流用）

        // transform rAF 节流（拖拽/捏合共用）
        this._dr_pending_transform = null;
        this._dr_transform_raf_id = null;
        this._dr_last_transform = { x: 0, y: 0, scale: 1 };

        // 惯性（动量）系统
        this._dr_momentum_raf = null;
        this._dr_gesture_vx = 0;
        this._dr_gesture_vy = 0;
        this._dr_last_canvas_x = 0;
        this._dr_last_canvas_y = 0;

        // 自适应 DPR（按缩放级别 + 内存压力动态降级，减少 4K 屏幕 GPU 显存占用）
        this._adaptive_dpr_enabled = true;

        // gesture 模块实例
        this._input_source = null;
        this._pinch_source = null;


        // 已初始化 tile 的页面索引集合（_dr_apply_scale 仅遍历此集合，跳过无 tile 页面）
        this._pages_with_tiles = new Set();

        this._open_seq = Promise.resolve();
        this._preload_idle_id = null;
        // 跨页并发渲染上限：限制同时在途的 PDF.js 渲染数，摊平首屏/滚动时
        // 多页同现的渲染峰值（避免 getPage + drawImage 在主线程堆叠卡顿），首屏活动页优先
        this._render_in_flight = 0;
        this._RENDER_MAX = 2;

        // 阅读器内加载层（打开/切标签时显示，首屏 DOM 真正渲染完成才隐藏）
        this._reader_loading_el = null;
        this._pending_first_render = false;
        this._open_loading_timer = null;

        // 容器矩形缓存（_check_page_visibility 中避免反复 getBoundingClientRect 触发布局）
        this._cached_container_rect = null;
        this._dr_transform_changed = false;        // 标记 transform 已变化，下次 _check_page_visibility 重新读取 rect

        // 离屏 canvas 池（复用双缓冲临时 canvas，避免频繁 GC）
        this._canvas_pool = [];
        this._canvas_pool_max = 3;

        // PDFPage 对象缓存（避免每次渲染重调 folder.pdfDoc.getPage()）
        this._pdf_page_cache = new Map();
        this._pdf_page_cache_max = 12; // LRU 上限：保留最近使用的 12 个 PDFPage

        // 文档级 cleanup 去抖定时器
        this._doc_cleanup_timer = null;

        // 页面 offsetTop/offsetHeight 缓存（避免 _check_page_visibility 重复触发布局）
        this._page_positions = { tops: [], heights: [], stale: true };
    }

    // ====== 初始化 ======

    init(container) {
        this._scroll_container = document.getElementById('docReaderScrollContainer');
        
        // 创建阅读器自己的工具栏
        this._create_toolbar();
        this._apply_text_visibility();
        
        this._setup_toolbar_events();
    }
    
    _apply_text_visibility() {
        const show = window.ThemeManager?.theme_fetch_toolbar_text?.() ?? true;
        const toolbar = document.getElementById('drToolbar');
        if (!toolbar) return;
        toolbar.querySelectorAll('.toolbar-btn span').forEach(span => {
            span.style.display = show ? '' : 'none';
        });
        toolbar.classList.toggle('hide-text', !show);
    }

    _create_toolbar() {
        // 检查是否已存在
        if (document.getElementById('drToolbar')) return;
        
        const toolbar = document.createElement('div');
        toolbar.id = 'drToolbar';
        toolbar.className = 'toolbar dr-toolbar';
        toolbar.style.display = 'none';
        toolbar.innerHTML = `
            <div class="toolbar-dr-group">
                <button class="toolbar-btn function-btn" id="drBtnMove" data-mode="move">
                    <img data-icon="move" width="16" height="16" alt="移动">
                    <span>移动</span>
                </button>
                <button class="toolbar-btn function-btn active" id="drBtnComment" data-mode="comment">
                    <img data-icon="pen" width="16" height="16" alt="批注">
                    <span>批注</span>
                </button>
                <button class="toolbar-btn function-btn" id="drBtnEraser" data-mode="eraser">
                    <img data-icon="eraser" width="16" height="16" alt="橡皮">
                    <span>橡皮</span>
                </button>
                <button class="toolbar-btn function-btn" id="drBtnUndo">
                    <img data-icon="undo" width="16" height="16" alt="撤销">
                    <span>撤销</span>
                </button>
                <button class="toolbar-btn function-btn" id="drBtnBlackboard">
                    <img data-icon="blackboard" width="16" height="16" alt="小黑板">
                    <span>黑板</span>
                </button>
                <div class="toolbar-separator"></div>
                <button class="toolbar-btn function-btn" id="drPagePrev" disabled>
                    <img data-icon="chevron-left" width="16" height="16" alt="上一页">
                    <span>上一页</span>
                </button>
                <span class="dr-page-indicator" id="drPageIndicator">1 / 1</span>
                <button class="toolbar-btn function-btn" id="drPageNext">
                    <img data-icon="chevron-right" width="16" height="16" alt="下一页">
                    <span>下一页</span>
                </button>
            </div>
        `;
        
        document.body.appendChild(toolbar);
        this._dr_tool_group = toolbar.querySelector('.toolbar-dr-group');
        this._apply_text_visibility();
    }

    // ====== 面板管理 ======

    async open(folder_index, page_index = 0) {
        const prev = this._open_seq;
        let resolve_cur;
        this._open_seq = new Promise(r => { resolve_cur = r; });
        // 请求时即登记序号：排队等待期间若来了更新的请求，本次直接放弃
        const my_req_id = ++this._open_req_id;
        await prev;

        // 合并过期请求：高负载下串行队列排空慢，逐个执行过期的打开
        // 会让快速连点标签明显卡顿；此处尚未做任何状态变更，可安全退出
        if (my_req_id !== this._open_req_id) {
            resolve_cur();
            return;
        }

        try {
            const folder = window.state.fileList[folder_index];
            if (!folder || !folder.pages || folder.pages.length === 0) return;

            // 后台被 LRU 卸载的文档先懒重载。放在关闭当前文档之前：
            // 重载失败时保留现有视图，而不是落到空白的主页
            if (!folder.pdfDoc && window.main_ensure_folder_doc) {
                const ok = await window.main_ensure_folder_doc(folder);
                if (!ok) return;
            }

            if (this.is_open) {
                await this.close();
            }
            this._active_folder = folder;
            this.folder_index = folder_index;

            // 阅读器内加载层：覆盖"打开文档 → 构建 DOM → 首屏渲染"与切标签的 DOM 重建期，
            // 仅当首屏 DOM 真正渲染完成（_render_pdf_page_direct 内 _pending_first_render 判定）才隐藏。
            // 首页（startupScreen）首次导入走全屏遮罩（#loadingOverlay），此处不重复叠加。
            this._pending_first_render = true;
            if (!document.getElementById('loadingOverlay')) this._show_reader_loading();
            if (this._open_loading_timer) clearTimeout(this._open_loading_timer);
            this._open_loading_timer = setTimeout(() => {
                if (this._pending_first_render) {
                    this._pending_first_render = false;
                    this._hide_reader_loading();
                }
            }, 8000);

            if (window.main_submit_stroke) {
            await window.main_submit_stroke();
        }
        if (window.batchDrawManager) {
            window.batchDrawManager.batch_draw_delete_all();
        }
        if (window.main_update_mode) {
            window.main_update_mode('move');
        }

        // 历史隔离
        window.__HISTORY_ISOLATED = true;
        this.saved_history_state = {
            undo_list: [...history_state.undo_list],
            redo_list: [...history_state.redo_list],
            on_state_change: history_state.on_state_change
        };
        history_init_manager({
            on_state_change: () => {
                this._update_button_status();
                // 历史变化（画笔/擦除/undo/redo/清空）→ 防抖落盘
                this._schedule_annotation_save();
            }
        });

        this.page_manager.init_from_folder_pages(folder.pages);
        // 诊断初始化 + 手动导出（控制台执行 window.__drDump() 查看现场）
        this._diag_journal = [];
        this._diag_last_lens = new Map();
        this._diag_suppress = false;
        // 缓存就绪门闩：恢复完成前禁止"空页面"延迟判定（见 _init_page_tiles）
        this._cache_ready = false;
        window.__drDump = () => this._dr_diag_dump('manual dump');
        this._dr_diag('open', { pages: folder.pages.length });
        this.active_page_index = page_index;
        this.page_manager.current_index = page_index;

        // 从缓存恢复批注（与 DOM 构建并行 I/O）
        const cachePromise = this._load_annotations_from_cache();

        this._build_page_dom();

        // 确保滚动容器事件已绑定（close() 可能已移除）
        this._setup_events();
        this._setup_keyboard_events();

        // 创建文档阅读器专用的橡皮擦提示元素（与 blackboard 模式一致）
        this._create_eraser_hint();

        // 默认启用移动模式，允许立即拖拽平移（不设为批注模式）
        this._set_draw_mode('move');

        // 等待缓存就绪
        const saved_state = await cachePromise;
        // 批注已恢复：此后"空页面"延迟判定才是可靠的
        this._cache_ready = true;

        // 开页自愈看门狗：批注已恢复，立即开始校验渲染结果
        this._start_open_watchdog();

        // 窗口/容器几何变化响应：观测滚动容器本身（窗口拖拽/最大化/贴靠、面板
        // 显隐、筛选栏换行等所有几何来源统一覆盖）。_last_resize_base_w 重置为
        // -1，保证 open 后的首次重布局必定执行——阅读器关闭期间（主页）发生的
        // 窗口 resize 无人处理，且此后不会再有 resize 事件，只能在打开时对齐
        this._last_resize_base_w = -1;
        this._last_resize_container_h = -1;
        this._setup_container_resize_observer();

        // 恢复上次的缩放/位置/页码，或使用传入的 page_index。
        // 缓存保存后的窗口尺寸若已变化，绝对偏移失效（_adopt_saved_zoom 内处理）
        let target_page = page_index;
        let saved_offsets_valid = false;
        if (saved_state && saved_state.active_page_index >= 0) {
            target_page = saved_state.active_page_index;
            saved_offsets_valid = this._adopt_saved_zoom(saved_state, this._get_page_base_width());
        }
        // 同步当前页状态：open() 入口的 active 是调用参数（常为 0），
        // 缓存视图恢复后必须一并对齐，否则 near_active 门控（看门狗补建/
        // 预加载/预渲染/batch_draw 绑定）全部指向错误页，目标页批注缺失
        this.active_page_index = target_page;
        this.page_manager.current_index = target_page;

        // 打开期预渲染锁：面板尚未激活（下方 458 行才 add('active')），
        // 此间容器几何为 0，_on_page_visible 若栅格化会得到错位瓦片、并在
        // 面板稳定后被 491 行的 _dr_apply_scale 二次重建——纯属浪费。
        // 锁定期间 _on_page_visible 只标记可见性，权威渲染统一延后到面板稳定后。
        this._open_prerender_locked = true;

        // 滚动到初始页面（会触发 _dr_apply_scale → _check_page_visibility → _on_page_visible → 首批页面渲染）
        await this._scroll_to_page(target_page);

        // 恢复缩放 transform（_scroll_to_page 内部会调 _dr_apply_scale，此处需重新设置）；
        // 窗口尺寸在缓存保存后已变化时偏移失效，保持 _scroll_to_page 的重新锚定结果
        if (saved_state && saved_state.active_page_index >= 0 && saved_offsets_valid) {
            this.dr_scale = saved_state.dr_scale;
            this.dr_canvas_x = saved_state.dr_canvas_x;
            this.dr_canvas_y = saved_state.dr_canvas_y;
            this.dr_cached_inv_scale = 1 / this.dr_scale;
            this._dr_update_move_bound();
            this._dr_update_canvas_position();
            this._dr_sync_transform();
        }

        // 打开完成自愈校验：可见/近活动页若有批注但从未真正建 tile
        //（缓存恢复前的误判、或面板滑入动画期间的几何测量偏差导致可见性检查漏标记），
        // 此处强制补初始化，保证二次打开时历史批注立即可见，无需用户交互触发
        // 注意：面板激活前几何为 0，锁定期间跳过实际栅格化，交给面板稳定后的权威渲染
        for (let i = 0; i < this.page_manager.pages_list.length; i++) {
            const pd = this.page_manager.pages_list[i];
            if (!pd?.page_element || pd.tile_renderer) continue;
            if (pd.stroke_history.length === 0) continue;
            if (!(pd.is_visible || this._is_page_near_active(i, this._tile_keep_distance))) continue;
            // 标记需要重建；锁定期间不栅格化（避免错位瓦片），延后到 491 行权威渲染
            pd._tiles_deferred = false;
            pd.is_tiles_initialized = false;
            if (this._open_prerender_locked) continue;
            this._dr_diag('heal-init', { page: i + 1, hist: pd.stroke_history.length });
            this._resize_page_layout(i, this._get_page_base_width());
            this._init_page_tiles(i);
            this._update_overlay_size(i);
        }

        // 打开期间 fileList 可能因其他标签的关闭/拖拽排序而变化，
        // 按对象引用重新定位索引；若该文档已被移除则放弃本次打开（由 close 统一回收资源）
        const live_folder_index = window.state.fileList.indexOf(this._active_folder);
        if (live_folder_index < 0) {
            await this.close(true);
            return;
        }
        this.folder_index = live_folder_index;

        this.is_open = true;
        // 打开完整走完（缓存批注已恢复、视图已就位）才允许快照落盘
        this._save_ready = true;
        // 新文档新会话：清空上一份文档遗留的远跳确认与渲染连败状态
        this._pending_far_target = -1;
        this._render_fail_streak = 0;

        // LRU 记录 + 按需卸载最久未使用的后台文档（控制多标签常驻内存）
        folder._last_used = Date.now();
        if (window.main_evict_background_docs) {
            window.main_evict_background_docs(this._active_folder);
        }

        // 小黑板按文档隔离（默认开启）：同步当前 PDF 标签的 md5
        // （板关闭时仅记录目标，板打开时即时切换内容）。
        if (window.blackboardManager?._bb_set_active_md5) {
            window.blackboardManager._bb_set_active_md5(this._active_folder?.fileMd5 || null);
        }

        // 空闲时间预加载附近页面的 PDFPage 到缓存（提升后续滚动/缩放渲染速度）
        this._idle_preload_pages(target_page);

        const panel = document.getElementById('documentReaderPanel');
        if (panel) panel.classList.add('active');

        this._switch_toolbar(true);
        this._update_page_indicator();
        this._sync_page_buttons();
        this._update_button_status();

        // 更新UI状态（隐藏启动界面）
        if (window.main_update_ui_state) {
            window.main_update_ui_state();
        }

        // ===== 首次渲染调度 =====
        // 滑入动画靠 CSS transform 实现，transform 不改变布局盒：容器 clientWidth/Height 与
        // 可见域在动画期间即有效、几何可信。故先解除预渲染锁并触发首批渲染，让首屏在动画
        // 进行中即出现（直接切入观感）；动画结束后的 _dr_apply_scale 再做一次幂等校正。
        // 动画期间被关闭则直接放弃。
        this._open_prerender_locked = false;

        // 几何缓存全部失效，按当前布局重算
        this._cached_container_rect = null;
        this._dr_transform_changed = true;
        if (this._page_positions) this._page_positions.stale = true;
        this._dr_cancel_zoom_debounce();

        // 重应用保存的视图状态（_scroll_to_page 会重置偏移），随后统一触发首批渲染；
        // 偏移已随窗口尺寸变化失效时保持锚定结果不回填
        if (saved_state && saved_state.active_page_index >= 0 && saved_offsets_valid) {
            this.dr_scale = saved_state.dr_scale;
            this.dr_canvas_x = saved_state.dr_canvas_x;
            this.dr_canvas_y = saved_state.dr_canvas_y;
            this.dr_cached_inv_scale = 1 / this.dr_scale;
        }
        this._dr_apply_scale();

        await this._wait_panel_settled(panel);
        if (!this.is_open) return;

        // 面板已稳定：几何已可信，强制执行一次全量重布局，对齐阅读器关闭期间
        // （主页）发生的任何窗口尺寸变化——主页调整窗口大小后打开 PDF 即在此处
        // 得到正确布局；随后 _handle_reader_resize 末尾的 _dr_apply_scale 会以
        // 确定后的几何再触发一次幂等渲染，纠正滑入动画期间的任何偏差
        this._cached_container_rect = null;
        this._dr_transform_changed = true;
        if (this._page_positions) this._page_positions.stale = true;
        this._dr_cancel_zoom_debounce();
        this._sync_reader_overlay_size();
        this._handle_reader_resize();

        // 并行回填剩余页真实尺寸：首屏已用首页真实尺寸即时渲染，
        // 其余页尺寸在后台流式读取（不阻塞首屏），到位后一次性重排 + 按真实尺寸重渲染活动页
        if (this._active_folder?._pages_estimated) {
            this._stream_remaining_page_dims();
        }

        // 兜底：可见/邻近页若有批注但瓦片缺失或内容为空，强制补建/重绘。
        // 注意：恢复目标页常是未加载的虚拟化页（373 页文档按需加载），
        // 此时 tile_renderer 为空——必须先 _ensure_page_runtime_dom 补齐
        // 占位符/layers/tiles 容器，再走初始化，否则永远缺瓦片。
        const pages = this.page_manager.pages_list;
        for (let i = 0; i < pages.length; i++) {
            const pd = pages[i];
            if (!pd?.page_element || pd.stroke_history.length === 0) continue;
            if (!(pd.is_visible || this._is_page_near_active(i, this._tile_keep_distance))) continue;

            if (!pd.tile_renderer || pd._tiles_deferred) {
                this._ensure_page_runtime_dom(i);
                pd._tiles_deferred = false;
                pd.is_tiles_initialized = false;
                this._resize_page_layout(i, this._get_page_base_width());
                pd._tiles_force = true;
                this._init_page_tiles(i);
                pd._tiles_force = false;
                this._update_overlay_size(i);
            } else {
                this._render_page_strokes(i);
            }
            pd.tile_renderer?.update_visible_tile_dpr(this.dr_scale, false, true);
        }
    } finally {
        resolve_cur();
    }
    }

    // ===== 视图常驻（多标签平衡取向，state.viewKeepAlive 开关）======
    // 开关关闭时 switch_to 退化为 open()（行为完全等同现状）。
    // 开关开启时：切走标签把 _zoom_wrapper 从文档树彻底移除（仅保留 JS 引用 +
    // 内存 tile 快照），使活动文档的 DOM 中只存在当前标签，消除后台标签的
    // 绘制/布局/样式重算开销；切回时把节点重新挂回即可秒恢复（节点未销毁，
    // canvas 位图仍保留），无需 close/open 全量重建。

    _capture_tab_view(folder) {
        if (!folder) return;
        // 以 folder 对象（稳定引用）为 key，避免标签关闭/重排导致数字索引偏移失效
        this._tab_views.set(folder, {
            zoomWrapper: this._zoom_wrapper,
            pageManager: this.page_manager,
            activeFolder: this._active_folder,
            folderIndex: this.folder_index,
            activePageIndex: this.active_page_index,
            drScale: this.dr_scale,
            drCanvasX: this.dr_canvas_x,
            drCanvasY: this.dr_canvas_y,
            drCachedInvScale: this.dr_cached_inv_scale,
            viewBaseW: this._get_page_base_width(),
            pagesWithTiles: this._pages_with_tiles,
            pagePositions: this._page_positions,
            savedHistoryState: this.saved_history_state,
            historyUndo: history_state.undo_list,
            historyRedo: history_state.redo_list,
            drawMode: this.draw_mode,
            annSaveTimer: this._ann_save_timer
        });
    }

    /** 丢弃某标签的保活视图（关闭非活动标签时调用）：删除快照并彻底释放其 detached DOM/GPU 内存 */
    discard_tab_view(folder) {
        if (!folder) return;
        const view = this._tab_views.get(folder);
        if (!view) return;
        this._tab_views.delete(folder);
        const w = view.zoomWrapper;
        if (w) {
            // 移除子节点触发 canvas 位图与显存回收（节点本就不在文档树）
            while (w.firstChild) w.removeChild(w.firstChild);
        }
    }

    _detach_current_view() {
        // 后台标签：将整个 _zoom_wrapper 从文档树彻底移除（仅保留 JS 引用）。
        // 活动文档的 DOM 中只剩余当前标签视图，后台标签零绘制/布局/样式重算开销。
        // 节点未被销毁，canvas 位图仍保留，切回时重新挂回即可秒恢复。
        if (this._zoom_wrapper && this._zoom_wrapper.parentNode) {
            this._zoom_wrapper.parentNode.removeChild(this._zoom_wrapper);
        }
    }

    // 切断 this.* 对已捕获视图的引用，使后续 close() 不会销毁保活视图
    _sever_active_refs() {
        this.page_manager = new DocumentReaderPageManager();
        this._zoom_wrapper = null;
        this.is_open = false;
        this._save_ready = false;
        this._ann_save_timer = null;
    }

    _restore_tab_view(index, view) {
        // 注意：viewBaseW 与当前基准宽不一致的快照在 switch_to 中已被丢弃并走
        // 完整 open 重建（快照的页盒/tile/批注坐标全是旧基准宽，局部修补不可靠），
        // 此处正常情况下尺寸必然一致，直接恢复快照即可
        this.page_manager = view.pageManager;
        this._zoom_wrapper = view.zoomWrapper;
        this._active_folder = view.activeFolder;
        this.folder_index = index;
        this.active_page_index = view.activePageIndex;
        this.page_manager.current_index = view.activePageIndex;
        this.dr_scale = view.drScale;
        this.dr_canvas_x = view.drCanvasX;
        this.dr_canvas_y = view.drCanvasY;
        this.dr_cached_inv_scale = view.drCachedInvScale;
        this._pages_with_tiles = view.pagesWithTiles;
        this._page_positions = view.pagePositions;
        this.saved_history_state = view.savedHistoryState;
        this.draw_mode = view.drawMode;
        this._ann_save_timer = view.annSaveTimer;
        this.is_open = true;
        this._save_ready = true;
        this._open_prerender_locked = false;

        if (view.zoomWrapper && view.zoomWrapper.parentNode) {
            view.zoomWrapper.parentNode.removeChild(view.zoomWrapper);
        }
        if (this._scroll_container) this._scroll_container.appendChild(view.zoomWrapper);

        this._dr_update_move_bound();
        this._dr_update_canvas_position();
        this._dr_sync_transform();
        this._check_page_visibility();
        this._update_page_indicator();
        this._update_button_status();
        if (window.batchDrawManager) window.batchDrawManager.batch_draw_delete_all();
    }

    async switch_to(index) {
        if (!this._view_keep_alive()) {
            await this.open(index);
            return;
        }
        const fileList = window.state.fileList || [];
        const folder = fileList[index];
        if (!folder) return;
        if (this.is_open && this.folder_index === index) {
            if (window.main_update_tabs) window.main_update_tabs();
            return;
        }
        if (!folder.pdfDoc && window.main_ensure_folder_doc) {
            const ok = await window.main_ensure_folder_doc(folder);
            if (!ok) return;
        }
        if (this.is_open) {
            this._capture_tab_view(this._active_folder);
            this._detach_current_view();
            this._sever_active_refs();
        }
        const view = this._tab_views.get(folder);
        if (view) {
            // 窗口尺寸在该标签后台期间变化：保活快照的页盒/tile/批注坐标全是
            // 旧基准宽下的产物，局部修补不可靠，丢弃快照走完整 open 重建
            // （缓存批注恢复按 coord_width 自动补偿缩放，视图按 view_base_w 重新锚定）
            const cur_base_w = this._get_page_base_width();
            const base_changed = !view.viewBaseW || Math.abs(view.viewBaseW - cur_base_w) > 1;
            if (base_changed) {
                this.discard_tab_view(folder);
                await this.open(index);
                this._capture_tab_view(this._active_folder);
            } else {
                this._restore_tab_view(index, view);
            }
        } else {
            await this.open(index);
            this._capture_tab_view(this._active_folder);
        }
        // 小黑板按文档隔离：同步当前 PDF 标签的 md5
        if (window.blackboardManager?._bb_set_active_md5) {
            window.blackboardManager._bb_set_active_md5(this._active_folder?.fileMd5 || null);
        }
        if (window.main_update_tabs) window.main_update_tabs();
        if (window.main_update_ui_state) window.main_update_ui_state();
    }

    /**
     * 开页自愈看门狗。
     *
     * 面板滑入动画、content-visibility、异步 DPR 更新等瞬态因素可能让首批
     * 可见性检查漏标记或瓦片被清空后未回填，表现为"历史批注空白、动态 DPR
     * 停在初始档位，需平移/落笔后才恢复"。
     *
     * 打开后约 2 秒内每 250ms 校验一次可见/邻近页：
     *   - 有批注但未建 tile（含被误标 deferred）→ 强制补建；
     *   - 已建 tile 但像素探针显示无内容 → 强制全量重绘 + 重同步 DPR。
     * 连续两次无需修复（稳定）或达到次数上限即停止。
     */
    _start_open_watchdog() {
        if (this._open_watchdog_timer !== null) clearTimeout(this._open_watchdog_timer);
        let attempts = 0;
        let clean_streak = 0;
        const tick = () => {
            this._open_watchdog_timer = null;
            if (!this.is_open || !this.page_manager) return;
            attempts++;
            let repaired = false;
            const pages = this.page_manager.pages_list;
            for (let i = 0; i < pages.length; i++) {
                const pd = pages[i];
                if (!pd?.page_element || pd.stroke_history.length === 0) continue;
                if (!(pd.is_visible || this._is_page_near_active(i, this._tile_keep_distance))) continue;

                if (!pd.tile_renderer || pd._tiles_deferred) {
                    // 漏初始化：清除误标并强制补建。
                    // 虚拟化页必须先补齐运行时 DOM（占位符/layers/tiles 容器）
                    this._dr_diag('wdg-init', { page: i + 1, hist: pd.stroke_history.length });
                    this._ensure_page_runtime_dom(i);
                    pd._tiles_deferred = false;
                    pd.is_tiles_initialized = false;
                    this._resize_page_layout(i, this._get_page_base_width());
                    pd._tiles_force = true;
                    this._init_page_tiles(i);
                    pd._tiles_force = false;
                    this._update_overlay_size(i);
                    pd.tile_renderer?.update_visible_tile_dpr(this.dr_scale, false, true);
                    repaired = true;
                } else {
                    // 瓦片存在但探针显示全空 → 被清空后未回填，强制重绘
                    const probe = pd.tile_renderer.diag_content_ratio();
                    if (probe.tilesAlive > 0 && probe.tilesWithContent === 0) {
                        this._dr_diag('wdg-repaint', { page: i + 1, hist: pd.stroke_history.length });
                        this._render_page_strokes(i);
                        pd.tile_renderer.update_visible_tile_dpr(this.dr_scale, false, true);
                        repaired = true;
                    }
                }
            }

            clean_streak = repaired ? 0 : clean_streak + 1;
            if (clean_streak >= 2 || attempts >= 8) return;
            this._open_watchdog_timer = setTimeout(tick, 250);
        };
        this._open_watchdog_timer = setTimeout(tick, 300);
    }

    /**
     * 等待阅读器面板滑入动画结束（transform 过渡完成）。
     * transitionend 监听 + 400ms 超时兜底（无过渡/reduce-motion/事件丢失）。
     * @param {HTMLElement|null} panel
     * @returns {Promise<void>}
     */
    _wait_panel_settled(panel) {
        return new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                this._panel_settle_finish = null;
                if (panel) panel.removeEventListener('transitionend', on_end);
                if (this._panel_settle_timer !== null) {
                    clearTimeout(this._panel_settle_timer);
                    this._panel_settle_timer = null;
                }
                resolve();
            };
            const on_end = (e) => {
                // 只认面板自身的 transform 过渡（子元素过渡会冒泡）
                if (e.target === panel && e.propertyName === 'transform') finish();
            };
            this._panel_settle_finish = finish;
            if (panel) {
                panel.addEventListener('transitionend', on_end);
                // 兜底：400ms 略大于 0.35s 过渡
                this._panel_settle_timer = setTimeout(finish, 400);
            } else {
                finish();
            }
        });
    }

    /**
     * 采用缓存视图的缩放/偏移。
     *
     * dr_canvas_x/y 是保存时刻窗口几何下的绝对像素，窗口尺寸跨会话变化后直接
     * 恢复会把页面定到错误位置（"主页调整窗口大小后打开 PDF 异常"的根源）。
     * 基准宽度一致 → 完整恢复；不一致（或旧缓存无基准记录，保守视为不一致）
     * → 保留等比换算后的缩放、清零偏移，由 _scroll_to_page 按当前几何重新锚定。
     * @param {object} saved_state 缓存视图状态
     * @param {number} cur_base_w 当前基准页宽（_get_page_base_width()）
     * @returns {boolean} 偏移是否有效（调用方据此决定是否在 _scroll_to_page 后重应用）
     */
    _adopt_saved_zoom(saved_state, cur_base_w) {
        const saved_base_w = saved_state.view_base_w || 0;
        const width_changed = saved_base_w > 0
            ? Math.abs(saved_base_w - cur_base_w) > 1
            : true;
        if (width_changed && saved_base_w > 0) {
            // 等比换算缩放，保持页面的观感大小不变
            const ratio = saved_base_w / cur_base_w;
            this.dr_scale = Math.min(this.dr_max_scale,
                Math.max(this.dr_min_scale, saved_state.dr_scale * ratio));
        } else {
            this.dr_scale = saved_state.dr_scale;
        }
        this.dr_cached_inv_scale = 1 / this.dr_scale;
        if (width_changed) {
            this.dr_canvas_x = 0;
            this.dr_canvas_y = 0;
            return false;
        }
        this.dr_canvas_x = saved_state.dr_canvas_x;
        this.dr_canvas_y = saved_state.dr_canvas_y;
        return true;
    }

    async close(force = false) {
        if (!this.is_open && !force) return;

        // 关闭即丢弃阅读器内加载层（切走/关闭时不再等待首屏）
        this._hide_reader_loading();

        // 复位打开期预渲染锁（快速关开时若旧 open 在锁定窗口被中断，
        // 必须主动解锁，避免新 open 的 _on_page_visible 被误锁导致白屏）
        this._open_prerender_locked = false;

        // 视图常驻：关闭活动标签时移除其保活快照（以 folder 对象为 key，
        // 不受 fileList 索引偏移影响；其余快照在切回时按原 key 命中）
        if (this._tab_views && this._active_folder) {
            this._tab_views.delete(this._active_folder);
        }

        // 清理窗口/容器尺寸响应管线（观测器 + 双通道定时器/raf）
        this._teardown_container_resize_observer();
        // 强制完成打开后的渲染等待（快速关开时旧回调不得触发；
        // 必须主动 finish，否则无过渡环境下 Promise 悬挂会卡死 open 队列）
        if (this._panel_settle_timer !== null) {
            clearTimeout(this._panel_settle_timer);
            this._panel_settle_timer = null;
        }
        if (this._panel_settle_finish) {
            const settle_finish = this._panel_settle_finish;
            this._panel_settle_finish = null;
            settle_finish();
        }
        // 停止开页自愈看门狗
        if (this._open_watchdog_timer !== null) {
            clearTimeout(this._open_watchdog_timer);
            this._open_watchdog_timer = null;
        }
        // 清理挂起的主动保存（close 自身会做显式保存，避免重复写盘）
        if (this._ann_save_timer !== null) {
            clearTimeout(this._ann_save_timer);
            this._ann_save_timer = null;
        }

        // 清理 gesture 模块
        this._teardown_gesture();

        if (this._wheel_raf_id !== null) {
            cancelAnimationFrame(this._wheel_raf_id);
            this._wheel_raf_id = null;
        }
        // 惯性滚动 rAF 无 is_open 门控，不取消会泄漏到下一次打开：
        // 动量 tick 会在新文档缓存恢复前触发可见性检查（空批注误判源头之一）
        this._dr_cancel_momentum();
        if (this._smooth_transform_timeout_id !== null) {
            clearTimeout(this._smooth_transform_timeout_id);
            this._smooth_transform_timeout_id = null;
        }
        if (this._zoom_complete_timer !== null) {
            clearTimeout(this._zoom_complete_timer);
            this._zoom_complete_timer = null;
        }
        this._dr_is_zooming = false;

        // 清理预渲染队列
        this._cancel_prerender();

        // 移除键盘事件监听器
        if (this._bound_handle_keydown) {
            document.removeEventListener('keydown', this._bound_handle_keydown);
            this._bound_handle_keydown = null;
        }

        this.is_open = false;
        window.__HISTORY_ISOLATED = false;

        await this._submit_stroke();
        this._hide_eraser_hint();

        // 移除橡皮擦提示元素
        if (this._eraser_hint && this._eraser_hint.parentNode) {
            this._eraser_hint.parentNode.removeChild(this._eraser_hint);
            this._eraser_hint = null;
        }

        // 移除阅读器 toast（若存在）
        const toast_el = document.getElementById('drReaderToast');
        if (toast_el) toast_el.remove();
        if (this._toast_timer !== null) {
            clearTimeout(this._toast_timer);
            this._toast_timer = null;
        }

        // 保存所有页的批注到缓存（含全局 undo/redo 历史）
        // 关闭路径跳过空闲调度立即写盘，保证退出时序确定
        await this._save_annotations_to_cache({ awaitIdle: false });

        // 保存最后打开的文档信息到 config（用于重启后恢复）
        await this._save_last_doc_state();

        // 恢复主画面历史
        if (this.saved_history_state) {
            history_state.undo_list = this.saved_history_state.undo_list;
            history_state.redo_list = this.saved_history_state.redo_list;
            history_state.on_state_change = this.saved_history_state.on_state_change;
            this.saved_history_state = null;
            history_handle_state_change();
        }

        this._destroy_lazy_loading();
        this._destroy_all_tiles();
        this._pages_with_tiles.clear();
        this.page_manager.destroy();

        // 清理 batch_draw 和 overlay_canvas
        if (this.batch_draw) {
            // 显式清空 overlay canvas 释放 GPU 纹理
            if (this.batch_draw._overlayCanvas) {
                const ctx = this.batch_draw._overlayCanvas.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, this.batch_draw._overlayCanvas.width, this.batch_draw._overlayCanvas.height);
                }
                this.batch_draw._overlayCanvas.width = 0;
                this.batch_draw._overlayCanvas.height = 0;
                if (this.batch_draw._overlayCanvas.parentNode) {
                    this.batch_draw._overlayCanvas.parentNode.removeChild(this.batch_draw._overlayCanvas);
                }
            }
            this.batch_draw.batch_draw_delete_all();
            this.batch_draw = null;
        }

        // 重置缩放状态
        this.dr_scale = 1;
        this.dr_canvas_x = 0;
        this.dr_canvas_y = 0;
        this.dr_is_scaling = false;
        this.dr_is_dragging = false;
        this.dr_move_bound = { min_x: 0, max_x: 0, min_y: 0, max_y: 0 };
        this.dr_cached_inv_scale = 1;
        this._dr_mb_cache_cw = -1;
        this._dr_mb_cache_ch = -1;
        this._dr_mb_cache_vw = -1;
        this._dr_mb_cache_vh = -1;
        this._dr_last_transform = { x: 0, y: 0, scale: 1 };
        this._dr_mb_cache_scale = -1;
        this._zoom_wrapper = null;
        this._cached_container_rect = null;

        const panel = document.getElementById('documentReaderPanel');
        if (panel) panel.classList.remove('active');

        // 清理页面侧边栏
        const page_sidebar = document.getElementById('drPageSidebar');
        if (page_sidebar) page_sidebar.remove();

        // 断开缩略图 IntersectionObserver
        if (this._thumbnail_observer) {
            this._thumbnail_observer.disconnect();
            this._thumbnail_observer = null;
        }
        // 释放缩略图缓存
        this._release_sidebar_thumbnail_cache();

        // 释放 canvas 池
        this._canvas_pool.forEach(c => {
            c.width = 0;
            c.height = 0;
        });
        this._canvas_pool = [];

        // 释放缓存的 PDFPage 对象
        for (const pdf_page of this._pdf_page_cache.values()) {
            pdf_page.cleanup?.();
        }
        this._pdf_page_cache.clear();

        // 清理文档级 cleanup 定时器
        if (this._doc_cleanup_timer !== null) {
            clearTimeout(this._doc_cleanup_timer);
            this._doc_cleanup_timer = null;
        }

        if (this._preload_idle_id !== null) {
            if (window.cancelIdleCallback) {
                window.cancelIdleCallback(this._preload_idle_id);
            } else {
                clearTimeout(this._preload_idle_id);
            }
            this._preload_idle_id = null;
        }

        if (this._scroll_container) {
            this._scroll_container.innerHTML = '';
        }

        this._switch_toolbar(false);

        // 清理缓存的 DOM 引用
        this._el_undo_btn = null;
        this._el_prev_btn = null;
        this._el_next_btn = null;
        this._el_page_indicator = null;
        this._el_move_btn = null;
        this._el_comment_btn = null;
        this._el_eraser_btn = null;

        // 统一清理激活文档状态：无论从哪条路径关闭（Esc/切标签/关标签），
        // folder_index 必须复位，否则主页与文档标签会同时高亮、拖拽映射错位
        this.folder_index = -1;
        this._active_folder = null;
        // 关闭后禁止快照落盘，直到下次 open() 完整走完
        this._save_ready = false;

        // 更新UI状态（显示启动界面）
        if (window.main_update_ui_state) {
            window.main_update_ui_state();
        }
    }

    /**
     * 获取当前激活文档的 folder 对象引用。
     * 标签重排/关闭可能让 folder_index 与 fileList 脱节，
     * 批注缓存与末次文档保存必须以 open 时捕获的对象引用为准，避免跨文档串写。
     */
    _get_active_folder() {
        return this._active_folder || window.state?.fileList?.[this.folder_index] || null;
    }

    /**
     * 防抖主动保存：批注/翻页变更后延迟 1.5s 落盘（复用幂等的全量快照保存），
     * 即使应用被直接关闭或崩溃，数据也已持久化。
     * 回调执行前校验 is_open 且调度时的目标文档未变，避免把内容写串到其他标签。
     */
    _schedule_annotation_save() {
        if (!this.is_open) return;
        if (this._ann_save_timer !== null) {
            clearTimeout(this._ann_save_timer);
        }
        const folder_at_schedule = this._active_folder;
        this._ann_save_timer = setTimeout(async () => {
            this._ann_save_timer = null;
            if (!this.is_open || this._active_folder !== folder_at_schedule) return;
            try {
                await this._save_annotations_to_cache();
                await this._save_last_doc_state();
            } catch (e) {
                console.error('[document_reader] 主动保存批注失败:', e);
            }
        }, 1500);
    }

    // ====== 批注丢失诊断（常驻开销极低：环形缓冲 + 长度哨兵） ======

    _dr_diag(event, data) {
        try {
            const j = this._diag_journal || (this._diag_journal = []);
            j.push({ t: Date.now() % 1000000, e: event, ...(data || {}) });
            if (j.length > 300) j.splice(0, 120);
        } catch (_) {}
    }

    _dr_diag_digest() {
        return (this.page_manager?.pages_list || []).map((p, i) => ({
            p: i + 1,
            n: p.stroke_history?.length ?? -1,
            tr: p.tile_renderer ? 1 : (p._tiles_deferred ? 'd' : (p.is_tiles_initialized ? '?' : 0)),
            cw: p.coord_width || 0
        }));
    }

    _dr_diag_dump(reason) {
        console.error(`[批注诊断] ${reason}`, {
            active: this.active_page_index + 1,
            digest: this._dr_diag_digest(),
            journal: (this._diag_journal || []).slice(-80)
        });
    }

    /** 哨兵：stroke_history 长度非预期收缩时自动抓拍现场（undo/clear/缓存恢复期间抑制） */
    _dr_diag_sentinel(trigger) {
        this._diag_last_trigger = trigger;
        if (!this._diag_last_lens) return;
        const pages = this.page_manager.pages_list;
        for (let i = 0; i < pages.length; i++) {
            const len = pages[i].stroke_history?.length ?? 0;
            const prev = this._diag_last_lens.get(i);
            if (typeof prev === 'number' && len < prev && !this._diag_suppress) {
                this._dr_diag_dump(`第${i + 1}页笔画数异常收缩 ${prev}->${len}（触发点:${trigger}）`);
            }
            this._diag_last_lens.set(i, len);
        }
    }

    /**
     * 将所有页的批注序列化写入缓存文件（含全局 undo/redo 历史）
     * @param {Object} [options]
     * @param {boolean} [options.awaitIdle=true] - false 时跳过空闲调度立即写入。
     *   关闭文档/退出应用路径应传 false：高负载下 requestIdleCallback 可能被长时间饥饿，
     *   空等会拖慢退出，甚至超过 Rust 侧强关兜底时限导致写盘中断。
     */
    async _save_annotations_to_cache(options = {}) {
        const folder = this._get_active_folder();
        if (!folder) return;
        // 门闩：open() 未完整走完（切换加载中/刚放弃的打开）时禁止写缓存，
        // 否则会把未恢复完成的空批注状态写回，清空该文档历史数据
        if (!this._save_ready) return;
        const await_idle = options?.awaitIdle !== false;
        const config_dir = window.configDir;
        if (!config_dir) return;
        const cache_id = this._get_annotations_cache_id();
        if (!cache_id) return;

        const pages = this.page_manager.pages_list;

        const serialize_cmd = (cmd) => {
            if (cmd.type === 'draw') {
                return { type: 'draw', page_index: cmd.page_index, stroke_uid: cmd.stroke?._cache_uid || null };
            } else if (cmd.type === 'clear') {
                return {
                    type: 'clear',
                    page_index: cmd.page_index,
                    saved_strokes: (cmd.savedStrokeHistory || []).map(s => ({
                        _cache_uid: s._cache_uid,
                        points: s.points,
                        color: s.color,
                        lineWidth: s.lineWidth,
                        eraserSize: s.eraserSize,
                        eraserSizeRaw: s.eraserSizeRaw,
                        storedWidths: s.storedWidths,
                        bounds: s.bounds,
                        type: s.type
                    }))
                };
            }
            return null;
        };

        const today = new Date().toISOString().split('T')[0];
        const cache_data = {
            version: 5,
            folder_index: this.folder_index,
            file_md5: folder?.fileMd5 || null,
            active_page_index: this.active_page_index,
            dr_scale: this.dr_scale,
            dr_canvas_x: this.dr_canvas_x,
            dr_canvas_y: this.dr_canvas_y,
            // 视图偏移的坐标基准（_get_page_base_width）：恢复时据此判断窗口尺寸
            // 是否变化，变化则丢弃绝对偏移、由 _scroll_to_page 重新锚定
            view_base_w: this._get_page_base_width(),
            last_open_date: today,
            pages: pages.map(p => ({
                stroke_history: p.stroke_history,
                // v5：记录每页批注的坐标基准。窗口尺寸跨会话变化时，
                // 恢复后首次进入页面由 _resize_page_layout 完成一次性补偿缩放
                coord_width: p.coord_width || null,
                coord_height: p.coord_height || null
            })),
            undo_stack: history_state.undo_list.map(serialize_cmd).filter(Boolean),
            redo_stack: history_state.redo_list.map(serialize_cmd).filter(Boolean)
        };
        this._dr_diag('save', {
            active: this.active_page_index + 1,
            lens: pages.map(p => p.stroke_history.length).join(',')
        });

        const doc_state_dir = `${config_dir}/doc_state`;
        const file_path = `${doc_state_dir}/doc_annotations_${cache_id}.json`;

        // 异步序列化：先确保目录存在，再在空闲时执行 JSON.stringify 避免阻塞
        const do_write = async (json_str) => {
            const { writeTextFile, mkdir } = window.__TAURI__.fs;
            try { await mkdir(doc_state_dir, { recursive: true }); } catch (_) {}
            await writeTextFile(file_path, json_str);
        };

        if (await_idle && window.requestIdleCallback) {
            await new Promise((resolve) => {
                window.requestIdleCallback(() => {
                    do_write(JSON.stringify(cache_data)).then(resolve).catch((err) => {
                        console.error('[document_reader] 保存批注缓存失败:', err);
                        resolve();
                    });
                }, { timeout: 3000 });
            });
        } else {
            await do_write(JSON.stringify(cache_data)).catch((err) => {
                console.error('[document_reader] 保存批注缓存失败:', err);
            });
        }
    }

    /** 从缓存文件恢复所有页的批注和全局 undo/redo 历史 */
    async _load_annotations_from_cache() {
        if (this.folder_index < 0) return null;
        const config_dir = window.configDir;
        const cache_dir = window.cacheDir;
        if (!config_dir && !cache_dir) return null;
        const cache_id = this._get_annotations_cache_id();
        if (!cache_id) return null;

        try {
            const { readTextFile } = window.__TAURI__.fs;
            let json_str;
            // 优先从 config_dir/doc_state 读取
            if (config_dir) {
                try {
                    json_str = await readTextFile(`${config_dir}/doc_state/doc_annotations_${cache_id}.json`);
                } catch (_) {}
            }
            // 兼容旧版：从缓存目录读取
            if (!json_str && cache_dir) {
                try {
                    json_str = await readTextFile(`${cache_dir}/doc_annotations_${cache_id}.json`);
                } catch (_) {}
            }
            if (!json_str) return null;
            const cache_data = JSON.parse(json_str);
            if (!cache_data || !cache_data.pages) return null;

            const pages = this.page_manager.pages_list;
            const len = Math.min(cache_data.pages.length, pages.length);

            // 缓存恢复会整体替换数组，抑制哨兵误报
            this._diag_suppress = true;
            // 恢复每页的 stroke_history
            for (let i = 0; i < len; i++) {
                const src = cache_data.pages[i];
                const dst = pages[i];
                if (src.stroke_history) {
                    dst.stroke_history = src.stroke_history;
                    // 防御：若 tile 渲染器已持有旧数组引用，同步重指向，
                    // 避免重建时读到替换前的空数组导致批注不可见
                    if (dst.tile_renderer) {
                        dst.tile_renderer._strokeHistoryRef = dst.stroke_history;
                    }
                }
                // v5：恢复批注的坐标基准（仅限尚未初始化 tile 的页）。
                // 若与当前窗口基准不同，首次进入页面时 _resize_page_layout
                // 会按 old/new 比例完成一次性补偿缩放，避免跨会话尺寸变化导致批注错位
                if (typeof src.coord_width === 'number' && src.coord_width > 0 &&
                    !dst.tile_renderer && !dst.is_tiles_initialized) {
                    dst.coord_width = src.coord_width;
                    if (typeof src.coord_height === 'number' && src.coord_height > 0) {
                        dst.coord_height = src.coord_height;
                    }
                }
            }

            // v3 格式：重建全局 undo/redo 栈
            if (cache_data.version >= 3 && cache_data.undo_stack) {
                this._rebuild_history_from_cache(cache_data.undo_stack, pages, history_state.undo_list);
            }
            if (cache_data.version >= 3 && cache_data.redo_stack) {
                this._rebuild_history_from_cache(cache_data.redo_stack, pages, history_state.redo_list);
            }
            this._diag_suppress = false;
            this._dr_diag('cache-loaded', {
                lens: pages.slice(0, len).map(p => p.stroke_history.length).join(',')
            });

            // v4 格式：返回保存的视图状态
            if (cache_data.version >= 4) {
                return {
                    active_page_index: cache_data.active_page_index ?? -1,
                    dr_scale: cache_data.dr_scale ?? 1,
                    dr_canvas_x: cache_data.dr_canvas_x ?? 0,
                    dr_canvas_y: cache_data.dr_canvas_y ?? 0,
                    view_base_w: cache_data.view_base_w ?? null
                };
            }
            return null;
        } catch (err) {
            this._diag_suppress = false;
            // 文件不存在或解析失败 → 无缓存，忽略
            if (err && err.code !== 'ENOENT' && !err.message?.includes('No such file')) {
                console.error('[document_reader] 恢复批注缓存失败:', err);
            }
            return null;
        }
    }

    /**
     * 从缓存数据重建 undo/redo 栈命令
     * 通过 stroke._cache_uid 匹配还原后的 stroke_history 中的对象引用
     */
    _rebuild_history_from_cache(serialized_list, pages, target_stack) {
        for (const entry of serialized_list) {
            const page = pages[entry.page_index];
            if (!page) continue;

            if (entry.type === 'draw' && entry.stroke_uid) {
                const stroke = page.stroke_history.find(s => s._cache_uid === entry.stroke_uid);
                if (stroke) {
                    const cmd = new DrawCommand({
                        stroke,
                        strokeHistoryRef: page.stroke_history,
                        redrawFn: () => this._render_all_strokes(stroke.bounds)
                    });
                    cmd.page_index = entry.page_index;
                    target_stack.push(cmd);
                }
            } else if (entry.type === 'clear' && entry.saved_strokes) {
                // 重建 ClearCommand：saved_strokes 为清空前的笔画快照
                const saved_strokes = entry.saved_strokes.map(s_data => {
                    // 尝试匹配 stroke_history 中的对象（若笔画未被清除）
                    const existing = page.stroke_history.find(s => s._cache_uid === s_data._cache_uid);
                    return existing || s_data;
                });
                const cmd = new ClearCommand({
                    savedStrokeHistory: saved_strokes,
                    strokeHistoryRef: page.stroke_history,
                    baseImageURLRef: { get value() { return null; }, set value(v) {} },
                    baseImageObjRef: { get value() { return null; }, set value(v) {} },
                    redrawFn: () => this._render_all_strokes(),
                    loadBaseImageFn: () => Promise.resolve()
                });
                cmd.page_index = entry.page_index;
                target_stack.push(cmd);
            }
        }
    }

    _get_annotations_cache_id() {
        const folder = this._get_active_folder();
        if (folder?.fileMd5) {
            return `md5_${folder.fileMd5}`;
        }
        return this.folder_index >= 0 ? `index_${this.folder_index}` : null;
    }

    /** 保存最后打开的文档信息到 config.json（用于重启后恢复） */
    async _save_last_doc_state() {
        const folder = this._get_active_folder();
        if (!folder) return;

        const today = new Date().toISOString().split('T')[0];
        const lastDoc = {
            folder_index: this.folder_index,
            file_name: folder.name || null,
            file_md5: folder.fileMd5 || null,
            page_index: this.active_page_index,
            dr_scale: this.dr_scale,
            dr_canvas_x: this.dr_canvas_x,
            dr_canvas_y: this.dr_canvas_y,
            last_open_date: today
        };

        try {
            if (window.__TAURI__?.core?.invoke) {
                await window.__TAURI__.core.invoke('settings_save_all', {
                    settings: { lastOpenDoc: lastDoc }
                });
            }
        } catch (err) {
            console.error('[document_reader] 保存最后文档状态失败:', err);
        }
    }

    /** 从 config.json 读取最后打开的文档信息 */
    async _load_last_doc_state() {
        try {
            if (window.__TAURI__?.core?.invoke) {
                const result = await window.__TAURI__.core.invoke('settings_fetch_all');
                return result?.settings?.lastOpenDoc || null;
            }
        } catch (err) {
            console.error('[document_reader] 读取最后文档状态失败:', err);
        }
        return null;
    }

    /** 恢复上次打开的文档（重启后调用） */
    async restore_last_document() {
        const lastDoc = await this._load_last_doc_state();
        if (!lastDoc) return false;

        const { folder_index, file_md5, page_index, dr_scale, dr_canvas_x, dr_canvas_y } = lastDoc;

        // 查找匹配的文件夹（优先用 md5 匹配，其次用 index）
        let target_index = -1;
        const fileList = window.state?.fileList;
        if (!fileList || fileList.length === 0) return false;

        if (file_md5) {
            target_index = fileList.findIndex(f => f?.fileMd5 === file_md5);
        }
        if (target_index < 0 && folder_index >= 0 && folder_index < fileList.length) {
            // 仅当文件名也一致时才回退旧索引，避免重启后按索引打开错误的文档
            const candidate = fileList[folder_index];
            if (!file_name || candidate?.name === file_name) {
                target_index = folder_index;
            }
        }
        if (target_index < 0) return false;

        // 打开文档并恢复状态
        await this.open(target_index, page_index || 0);

        // open() 内部已从缓存恢复了缩放/位置，但如果缓存不存在则使用 config 中的值
        if (this.dr_scale === 1 && this.dr_canvas_x === 0 && this.dr_canvas_y === 0 &&
            (dr_scale !== 1 || dr_canvas_x !== 0 || dr_canvas_y !== 0)) {
            this.dr_scale = dr_scale || 1;
            this.dr_canvas_x = dr_canvas_x || 0;
            this.dr_canvas_y = dr_canvas_y || 0;
            this.dr_cached_inv_scale = 1 / this.dr_scale;
            this._dr_update_move_bound();
            this._dr_update_canvas_position();
            this._dr_sync_transform();
            // 恢复缩放后同步瓦片 DPR，否则已初始化的瓦片仍使用缩放=1 时的 DPR
            for (const i of this._pages_with_tiles) {
                const pd = this.page_manager.pages_list[i];
                if (pd?.tile_renderer) {
                    pd.tile_renderer.update_visible_tile_dpr(this.dr_scale, false, true);
                }
            }
        }

        return true;
    }

    async delete_annotation_cache_files() {
        if (!window.__TAURI__?.core?.invoke) return;
        try {
            await window.__TAURI__.core.invoke('cache_delete_doc_annotations');
        } catch (error) {
            console.error('[document_reader] 删除批注缓存失败:', error);
        }
    }

    // ====== DOM 构建 ======

    _build_page_dom() {
        if (!this._scroll_container) return;
        this._scroll_container.innerHTML = '';

        // 缩放包装器（transform translate3d + scale 统一缩放）
        const wrapper = document.createElement('div');
        wrapper.className = 'dr-zoom-wrapper';
        this._zoom_wrapper = wrapper;
        this._scroll_container.appendChild(wrapper);

        // 基准页面宽度（容器可见宽度减 padding），后续 resize 会动态重算
        const base_w = this._get_page_base_width();

        const pages = this.page_manager.pages_list;
        const len = pages.length;

        // 先对所有页初始化宽高比（供 _compute_page_layout 估算坐标；不建 DOM、零开销）。
        // 远页随后由虚拟化 _on_page_visible → _ensure_page_element 懒建并重定位。
        for (let i = 0; i < len; i++) {
            this._refresh_page_aspect(pages[i]);
        }

        // ［性能］仅构建近活动页(±K)的 DOM，其余页保持 page_element=null，
        // 滚动进入可视区时由虚拟化懒建。千页文档首屏同步开销从 O(N) 降到 O(K)。
        const K = 2;
        const center = Math.max(0, Math.min(len - 1, this.active_page_index || 0));
        const from = Math.max(0, center - K);
        const to = Math.min(len - 1, center + K);

        // DocumentFragment 批量挂载，避免逐 page appendChild 触发布局
        const fragment = document.createDocumentFragment();
        for (let i = from; i <= to; i++) {
            const page_div = this._spawn_page_element(i, base_w);
            // overlay canvas 延迟到 _on_page_visible 创建（节省大量 getContext 开销）
            fragment.appendChild(page_div);
            pages[i]._visible_init_timeout = null;
        }

        wrapper.appendChild(fragment);

        // 页面已挂载到 DOM，缓存初始位置（首次 layout 后 offsetTop 可用）
        this._batch_read_page_positions();

        // 包裹层虚拟化：测量真实间距/内边距，改为绝对定位 + 预留总高度，
        // 远页随后在空闲清理时被彻底卸载出文档树（见 _cleanup_hidden_page_gpu）
        if (this._dom_virtualize()) {
            this._sync_layout_constants();
            this._compute_page_layout();
            this._apply_page_positions();
        }

        // 重置缩放状态，直接设置初始 transform（不触发 layout-heavy _dr_apply_scale）
        this.dr_scale = 1;
        this.dr_canvas_x = 0;
        this.dr_canvas_y = 0;
        this.dr_cached_inv_scale = 1;
        this._dr_sync_transform();
    }

    /**
     * 创建（或重建）单个页面包裹 div 及其初始图层（图片/img/tiles 容器/占位符）。
     * 被 _build_page_dom（首屏批量构建）与 _ensure_page_element（虚拟化重建）复用。
     * 注意：不负责把节点挂入文档树（由调用方追加到 fragment 或 _zoom_wrapper）。
     */
    _spawn_page_element(page_index, base_w) {
        const page_data = this.page_manager.pages_list[page_index];
            const page_div = document.createElement('div');
            page_div.className = 'doc-reader-page';
        page_div.dataset.page = page_index;
            page_data.page_element = page_div;

            // 页面基准尺寸（wrapper transform 负责缩放）
            this._set_page_box_size(page_data, base_w);
            page_div.style.touchAction = 'none';

            if (page_data.render_mode === 'pdfjs') {
                this._create_pdf_page_layers(page_data);

                const tiles_container = document.createElement('div');
                tiles_container.className = 'doc-reader-page-tiles';
                page_div.appendChild(tiles_container);
                page_data._tiles_container = tiles_container;
            } else if (page_data.loaded || page_data.image_url) {
                // 图片层（懒加载：data-src 替代 src）
                const img = document.createElement('img');
                img.alt = `第 ${page_data.page_num} 页`;
                img.loading = 'lazy';
                img.decoding = 'async';
                if (page_data.image_url) {
                    img.dataset.src = page_data.image_url;
                }
                page_div.appendChild(img);
                page_data._img_el = img;

                // Tile 容器（wrapper transform 统一缩放，tiles 不再单独 scale）
                const tiles_container = document.createElement('div');
                tiles_container.className = 'doc-reader-page-tiles';
                page_div.appendChild(tiles_container);
                page_data._tiles_container = tiles_container;
            } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'doc-reader-page-placeholder doc-reader-page-virtual-placeholder';
                placeholder.textContent = `第 ${page_data.page_num} 页`;
                page_div.appendChild(placeholder);
                page_div.classList.add('virtualized');
                page_data.is_virtualized = true;
            }
        return page_div;
        }

    /** 从已挂载布局实测页面间距与容器内边距，与 CSS 保持同步（避免 JS 常量与样式脱节） */
    _sync_layout_constants() {
        const wrap = this._zoom_wrapper;
        if (wrap) {
            const cs = getComputedStyle(wrap);
            const pad = parseFloat(cs.paddingTop);
            if (isFinite(pad) && pad > 0) this._layout_pad = pad;
            const gap = parseFloat(cs.rowGap) || parseFloat(cs.gap);
            if (isFinite(gap) && gap >= 0) this._layout_gap = gap;
        }
        const pos = this._page_positions;
        if (pos && pos.tops && pos.heights && pos.tops.length >= 2 && pos.heights[0] > 0) {
            const g = pos.tops[1] - pos.tops[0] - pos.heights[0];
            if (isFinite(g) && g >= 0) this._layout_gap = g;
        }
    }

    /** 用宽高比累计计算每页 top/height 与文档总高度（不依赖已卸载页的实时 offsetTop） */
    _compute_page_layout() {
        const pages = this.page_manager.pages_list;
        const len = pages.length;
        const base = this._get_page_base_width();
        const gap = this._layout_gap;
        const pad = this._layout_pad;
        let top = pad;
        const tops = new Array(len);
        const heights = new Array(len);
        for (let i = 0; i < len; i++) {
            const pd = pages[i];
            const aspect = this._get_page_aspect(pd);
            const h = Math.max(200, Math.round(base / aspect));
            pd._cached_top = top;
            pd._cached_h = h;
            tops[i] = top;
            heights[i] = h;
            top += h + gap;
        }
        top -= gap; // 去掉末尾多余间距
        const total = top + pad;
        this._page_positions = { tops, heights, total, stale: false };
        const wrap = this._zoom_wrapper;
        if (wrap) {
            wrap.style.position = 'relative';
            wrap.style.padding = '0';
            wrap.style.width = base + 'px';
            wrap.style.height = total + 'px';
        }
    }

    /** 把缓存坐标应用到当前已挂载的页面（绝对定位）。卸载态的页面跳过，待重建时再定位 */
    _apply_page_positions() {
        if (!this._dom_virtualize()) return;
        const pages = this.page_manager.pages_list;
        const base = this._get_page_base_width();
        for (let i = 0; i < pages.length; i++) {
            const pd = pages[i];
            if (!pd?.page_element) continue;
            const el = pd.page_element;
            el.style.position = 'absolute';
            el.style.top = (pd._cached_top || 0) + 'px';
            el.style.left = '0';
            el.style.right = 'auto';
            el.style.width = base + 'px';
        }
    }

    // ====== 页面位置缓存（避免 _check_page_visibility 中反复读 offsetTop 触发布局） ======

    /** 标记页面位置缓存为脏（页面尺寸变更后调用） */
    _invalidate_page_positions() {
        this._page_positions.stale = true;
    }

    /**
     * 批量读取所有页面在内容空间中的 top/height。
     *
     * 常规路径用 offsetTop/offsetHeight（一次布局、滚动高频零额外开销），
     * 但在面板离屏（translateY(-100%)）+ content-visibility:auto 状态下，
     * Chromium 可能返回退化值（全 0 / 未按实际内容布局），导致可见性扫描
     * 二分起点越过全部页面 → 首批渲染整体漏空（批注/DPR 需交互才恢复）。
     *
     * 因此读取后做健全性校验：非空、单调不减、末页偏移合理；
     * 不通过则回退到 getBoundingClientRect 相对 wrapper 测量
     * （强制完整布局，对任何祖先 transform/跳过渲染状态都稳健）。
     */
    _batch_read_page_positions() {
        const pages = this.page_manager.pages_list;
        const len = pages.length;
        let tops = new Array(len);
        let heights = new Array(len);

        // —— 常规路径：offset 批量读（虚拟化时用缓存坐标，已卸载页无实时 offsetTop） ——
        try {
            for (let i = 0; i < len; i++) {
                const pd = pages[i];
                if (!pd) { tops[i] = 0; heights[i] = 0; continue; }
                if (this._dom_virtualize()) {
                    tops[i] = pd._cached_top || 0;
                    heights[i] = pd._cached_h || 0;
                } else {
                    const el = pd.page_element;
                if (el) {
                    tops[i] = el.offsetTop;
                    heights[i] = el.offsetHeight;
                } else {
                    tops[i] = 0;
                    heights[i] = 0;
                }
            }
            }
        } catch (_) {
            tops = null;
        }

        // —— 健全性校验 ——
        let ok = tops !== null && len > 0;
        if (ok) {
            let prev = -1;
            for (let i = 0; i < len; i++) {
                // 每页高度必须为正，且 top 单调不减（允许 1px 误差）
                if (!(heights[i] > 0) || tops[i] < prev - 1) { ok = false; break; }
                prev = tops[i];
            }
            // 连续文档：末页偏移必须显著大于 0（全 0 即退化）
            if (ok && len >= 3 && !(tops[len - 1] > 0)) ok = false;
        }

        // —— 回退路径：rect 相对 wrapper 测量（内容空间） ——
        if (!ok) {
            const wr = this._zoom_wrapper?.getBoundingClientRect();
            if (wr) {
                const inv = 1 / (this.dr_scale || 1);
                tops = new Array(len);
                heights = new Array(len);
                for (let i = 0; i < len; i++) {
                    const el = pages[i]?.page_element;
                    if (!el) { tops[i] = 0; heights[i] = 0; continue; }
                    const r = el.getBoundingClientRect();
                    tops[i] = (r.top - wr.top) * inv;
                    heights[i] = r.height * inv;
                }
            }
        }

        this._page_positions.tops = tops || [];
        this._page_positions.heights = heights || [];
        this._page_positions.stale = false;
    }

    // ====== 懒加载（手动可见性检查，transform 替代 IntersectionObserver） ======

    _destroy_lazy_loading() {
        // 清理延迟销毁定时器
        if (this._page_visible_timeout_id !== null) {
            clearTimeout(this._page_visible_timeout_id);
            this._page_visible_timeout_id = null;
        }
    }

    /** 手动检查每页是否在视口中（用 offsetTop 数学推算，避免 getBoundingClientRect 布局抖动） */
    _check_page_visibility() {
        if (!this._scroll_container || !this.page_manager || !this._zoom_wrapper) return;

        // 安全网：页数变化（惰性加载/动态增页）时重算布局，保证 _page_positions.total
        // 与 _cached_top 覆盖全部页，移动边界与可见性扫描坐标不脱节。
        const pl = this.page_manager.pages_list;
        if (pl && pl.length && pl.length !== (this._page_positions?.tops?.length || 0)) {
            this._compute_page_layout();
            this._apply_page_positions();
        }

        this._dr_diag_sentinel('visibility');

        if (this._dr_transform_changed || !this._cached_container_rect) {
            this._ensure_container_rect();
        }
        const container_top = this._cached_container_rect.top;
        const container_bottom = this._cached_container_rect.bottom;

        const wrapper_top = this._cached_container_rect.wrapperTop;
        const s = this.dr_scale;

        let nearest_page = -1;
        let nearest_dist = Infinity;
        const viewport_center = (container_top + container_bottom) / 2;
        const viewport_height = container_bottom - container_top;

        // 滚动方向/速度感知：活动滚动时让预渲染窗口向滚动方向前倾，
        // 使即将到达的页在入场前就完成栅格化（低 DPR 预渲染），避免白屏/卡顿被用户察觉。
        const now = performance.now();
        let dir = 0;
        let moving = false;
        if (this._dr_last_vis_y !== undefined) {
            const dy = this.dr_canvas_y - this._dr_last_vis_y;
            if (dy !== 0) {
                dir = dy > 0 ? 1 : -1;
                this._dr_scroll_dir = dir;
                this._dr_scroll_vel = Math.abs(dy);
                this._dr_last_scroll_t = now;
            }
        }
        this._dr_last_vis_y = this.dr_canvas_y;
        if (now - (this._dr_last_scroll_t || 0) < 140 && (this._dr_scroll_vel || 0) > 1.5) {
            moving = true;
        }
        const ahead_screens = moving ? 4 : (this._prerender_distance || 5);
        const behind_screens = moving ? 1 : (this._prerender_distance || 5);
        const prerender_top = container_top - behind_screens * viewport_height;
        const prerender_bottom = container_bottom + ahead_screens * viewport_height;

        if (this._page_positions.stale) {
            this._batch_read_page_positions();
        }
        const total_pages = this.page_manager.pages_list.length;

        let visible_pages = [];
        let prerender_pages = [];

        // 退化防御：正常文档的扫描必然产出最近页（nearest 对所有扫描页无条件更新）。
        // 全空只可能是位置缓存失效（如面板离屏/content-visibility 未布局时读到的
        // offsetTop/Height 异常，二分起点越过全部页面）→ 强制重读位置并重扫一次。
        // 否则首批渲染整体漏空：批注/瓦片/背景全部不初始化，需用户交互才恢复。
        for (let attempt = 0; attempt < 2; attempt++) {
            const page_tops = this._page_positions.tops;
            const page_heights = this._page_positions.heights;

            // 二分查找第一个可能在预渲染范围内的页（page_bottom * s + wrapper_top > prerender_top）
            const inv_s = s || 1;
            const min_page_bottom = Math.max(0, (prerender_top - wrapper_top) * inv_s);
            let start_i = 0;
            {
                let lo = 0, hi = total_pages;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    const pb = (page_tops[mid] ?? 0) + (page_heights[mid] ?? 0);
                    if (pb < min_page_bottom) lo = mid + 1; else hi = mid;
                }
                start_i = lo;
            }

            for (let i = start_i; i < total_pages; i++) {
                const page_data = this.page_manager.pages_list[i];
                if (!page_data) continue;
                // 虚拟化下远页可能已卸载（page_element 为 null），但缓存坐标仍有效，
                // 必须继续扫描以在滚回视口时重新挂载；非虚拟化时无卸载，保持原守卫
                if (!this._dom_virtualize() && !page_data.page_element) continue;

                const page_top = page_tops[i] ?? 0;
                const page_h = page_heights[i] ?? 0;
                // 未完成布局的页（零尺寸）不参与可见性/最近页判定，避免把页码器拉到错误页
                if (!(page_h > 0)) continue;
                const page_bottom = page_top + page_h;

                const visual_top = wrapper_top + page_top * s;
                const visual_bottom = wrapper_top + page_bottom * s;

                if (visual_top > prerender_bottom) break;

                const is_intersecting = visual_bottom > container_top && visual_top < container_bottom;
                const is_in_prerender_range = visual_bottom > prerender_top && visual_top < prerender_bottom;

                if (is_intersecting) {
                    visible_pages.push(i);
                    this._on_page_visible(i);
                } else if (is_in_prerender_range && this._prerender_enabled) {
                    prerender_pages.push(i);
                    this._on_page_hidden(i);
                } else {
                    this._on_page_hidden(i);
                }

                const visual_center = (visual_top + visual_bottom) / 2;
                const dist = Math.abs(visual_center - viewport_center);
                if (dist < nearest_dist) {
                    nearest_dist = dist;
                    nearest_page = i;
                }
            }

            if (total_pages > 0 && nearest_page === -1 && attempt === 0) {
                // 首次扫描常在 transform 写入前测量容器矩形（面板离屏期），
                // 重读位置与容器矩形后即可命中；仍空则由下方 active 兜底接管
                this._batch_read_page_positions();
                this._ensure_container_rect();
                visible_pages = [];
                prerender_pages = [];
                nearest_page = -1;
                nearest_dist = Infinity;
                continue;
            }
            break;
        }

        // 终极兜底：两次扫描都空（缓存位置与真实布局在目标区域存在偏差）时，
        // 至少保证当前页进入渲染管线——否则打开后目标页批注/DPR 全部缺失，
        // 必须等用户交互触发一次成功扫描才恢复。
        if (total_pages > 0 && visible_pages.length === 0 &&
            this.active_page_index >= 0 && this.active_page_index < total_pages) {
            const act = this.active_page_index;
            if (this.page_manager.pages_list[act]?.page_element) {
                this._dr_diag('visibility-active-fallback', { page: act + 1 });
                this._on_page_visible(act);
            }
        }

        // 主动预加载 keep_distance 范围内的图片（避免滚动到时白屏）
        this._preload_nearby_images(nearest_page);

        // 触发预渲染（按距离排序，优先渲染最近的页面）
        if (prerender_pages.length > 0) {
            this._schedule_prerender(prerender_pages, nearest_page);
        }

        // 活动滚动时启动"紧急预渲染泵"：用 rAF（每帧都触发，区别于 requestIdleCallback
        // 在滚动期间会被浏览器节流/饿死）把滚动方向前方窗口内的页按低 DPR 预先栅格化，
        // 确保它们真正进入视口前已就绪，用户完全无白屏感知。静止时由上方 idle 队列兜底。
        if (moving) {
            this._dr_start_prerender_pump();
        }

        // 同步翻页器到距离视口中心最近的页。
        // 防误切护栏：扫描未发现任何可见/预渲染候选（几何瞬态，如面板离屏、
        // 容器矩形与 transform 不同步）时，nearest 不可信——此时切换 active
        // 会把"当前页"拉到文档错误端，后续 near_active 门控全部失效
        // （批注补建/预加载/预渲染都指向错误页），需交互才能恢复。
        const has_scan_candidates = visible_pages.length > 0 || prerender_pages.length > 0;
        if (nearest_page >= 0 && nearest_page !== this.active_page_index && has_scan_candidates) {
            // 远跳两样本确认：布局/变换瞬态期间几何缓存可能单帧算出错误页
            // （如 4→5 时闪 1/24）。跳变 >1 页需连续两帧一致才应用；
            // 正常滚动/拖动滚动条每帧位移 ≤1 页，不受影响
            if (Math.abs(nearest_page - this.active_page_index) > 1 &&
                nearest_page !== this._pending_far_target) {
                this._pending_far_target = nearest_page;
            } else {
                this._pending_far_target = -1;
                this.active_page_index = nearest_page;
                this.page_manager.current_index = nearest_page;
                this._dr_diag('page', {
                    to: nearest_page + 1,
                    ...(this.page_manager.pages_list[nearest_page]?.tile_renderer?.diag_content_ratio?.() || {})
                });
                this._update_page_indicator();
                this._sync_page_buttons();

                // 切换 batch_draw 的 tileRenderer 引用到新页
                // （无条件赋值：新页尚未建 tile 时置 null 也优于残留上一页引用）
                if (this.batch_draw && nearest_page < this.page_manager.pages_list.length) {
                    const pd = this.page_manager.pages_list[nearest_page];
                    this.batch_draw._tileRenderer = pd.tile_renderer || null;
                }
            }
        } else if (nearest_page === this.active_page_index) {
            // 停留在原页：清除未确认的远跳登记
            this._pending_far_target = -1;
        }

        // 去抖文档级 cleanup（滚动停止约 3 秒后释放 PDF.js 内部缓存）
        const active_folder = this._get_active_folder();
        if (active_folder?.pdfDoc?.cleanup) {
            if (this._doc_cleanup_timer !== null) {
                clearTimeout(this._doc_cleanup_timer);
            }
            this._doc_cleanup_timer = setTimeout(() => {
                this._doc_cleanup_timer = null;
                try {
                    // cleanup() 返回 Promise，悬空调用在内部取消渲染时会抛 Uncaught
                    active_folder.pdfDoc.cleanup()?.catch?.(() => {});
                } catch (_) {}
            }, 3000);
        }
    }

    /** 主动预加载 keep_distance 范围内的图片（避免滚动到时白屏） */
    _preload_nearby_images(active_page) {
        if (active_page < 0) return;
        const pages = this.page_manager.pages_list;
        const start = Math.max(0, active_page - this._image_keep_distance);
        const end = Math.min(pages.length - 1, active_page + this._image_keep_distance);

        for (let i = start; i <= end; i++) {
            if (i === active_page) continue;
            const pd = pages[i];
            if (!pd || pd.is_virtualized) continue;

            const img = pd._img_el;
            if (img && !img.hasAttribute('src') && img.dataset.src) {
                img.src = img.dataset.src;
            }

            // PDF 页面预加载
            if (!pd.loaded && this.folder_index >= 0) {
                this._load_pdf_page(i);
            }
        }
    }

    // ====== 预渲染调度 ======

    /** 调度预渲染任务（按距离排序，使用 requestIdleCallback 或 rAF） */
    _schedule_prerender(page_indices, active_page) {
        // 按距离当前页排序（优先渲染最近的页面）
        const sorted = page_indices
            .filter(i => {
                const pd = this.page_manager.pages_list[i];
                return pd && !pd.is_visible && !pd.pdf_render_promise;
            })
            .sort((a, b) => Math.abs(a - active_page) - Math.abs(b - active_page));

        // 限制预渲染队列长度（最多5页）
        this._prerender_queue = sorted.slice(0, 5);

        // 如果没有正在预渲染的任务，启动预渲染
        if (!this._is_prerendering && this._prerender_queue.length > 0) {
            this._process_prerender_queue();
        }
    }

    /** 处理预渲染队列（使用 requestIdleCallback 避免阻塞主线程） */
    _process_prerender_queue() {
        if (this._prerender_queue.length === 0 || !this._prerender_enabled) {
            this._is_prerendering = false;
            return;
        }

        this._is_prerendering = true;

        const process_next = () => {
            if (this._prerender_queue.length === 0 || !this._prerender_enabled) {
                this._is_prerendering = false;
                return;
            }

            const page_index = this._prerender_queue.shift();
            const page_data = this.page_manager.pages_list[page_index];

            // 如果页面已可见或正在渲染，跳过
            if (!page_data || page_data.is_visible || page_data.pdf_render_promise) {
                this._process_prerender_queue();
                return;
            }

            // 使用 requestIdleCallback 在空闲时预渲染
            const prerender_fn = () => {
                this._prerender_page(page_index).then(() => {
                    // 继续处理下一个
                    this._process_prerender_queue();
                }).catch((err) => {
                    // 预渲染被取消（页面转为可见、被 force 渲染接管）是预期路径：
                    // 必须捕获并继续驱动队列，否则既抛 Uncaught 又会让队列永久卡死
                    if (err?.name !== 'RenderingCancelledException') {
                        console.warn('[document_reader] 预渲染失败:', err);
                    }
                    this._process_prerender_queue();
                });
            };

            if (window.requestIdleCallback) {
                window.requestIdleCallback(prerender_fn, { timeout: 1000 });
            } else {
                // 降级：使用 setTimeout
                setTimeout(prerender_fn, 50);
            }
        };

        process_next();
    }

    /** 预渲染单个页面（PDF 渲染 / 图片预加载） */
    async _prerender_page(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data || page_data.is_visible || page_data.pdf_render_promise) return;

        // 确保页面 DOM 已创建：虚拟化下须先建外层包裹（page_element），
        // 否则 _render_pdf_page_direct 会因 page_element 为 null 直接 return（白预渲染）
        if (this._dom_virtualize()) this._ensure_page_element(page_index);
        this._ensure_page_runtime_dom(page_index);

        // 如果是 PDF 页面，提前渲染
        if (page_data.render_mode === 'pdfjs') {
            await this._render_pdf_page_direct(page_index, false, true);
        } else {
            // 图片页面：预加载图片（不初始化 tiles，留给 _on_page_visible 处理）
            const img = page_data._img_el;
            if (img && !img.hasAttribute('src') && img.dataset.src) {
                img.src = img.dataset.src;
            }
        }
    }

    /** 翻页时预渲染目标页及相邻页 */
    _prerender_for_navigation(target_index) {
        if (!this._prerender_enabled) return;

        const pages = this.page_manager.pages_list;
        const prerender_indices = [];

        // 预渲染目标页的前后各5页
        for (let offset = -5; offset <= 5; offset++) {
            const idx = target_index + offset;
            if (idx >= 0 && idx < pages.length && idx !== this.active_page_index) {
                const pd = pages[idx];
                if (pd && !pd.is_visible && !pd.pdf_render_promise) {
                    prerender_indices.push(idx);
                }
            }
        }

        if (prerender_indices.length > 0) {
            this._schedule_prerender(prerender_indices, target_index);
        }
    }

    /** 取消所有预渲染任务 */
    _cancel_prerender() {
        this._prerender_queue = [];
        this._is_prerendering = false;
        this._dr_stop_prerender_pump();
    }

    // ====== 紧急预渲染泵（滚动方向前瞻，rAF 驱动，无感知懒加载核心） ======

    /** 启动紧急预渲染泵（幂等） */
    _dr_start_prerender_pump() {
        if (this._dr_prerender_pumping || !this._prerender_enabled || this._open_prerender_locked) return;
        this._dr_prerender_pumping = true;
        this._dr_prerender_pump_tick();
    }

    /** 停止紧急预渲染泵并清理 rAF */
    _dr_stop_prerender_pump() {
        this._dr_prerender_pumping = false;
        if (this._dr_prerender_pump_raf !== null) {
            cancelAnimationFrame(this._dr_prerender_pump_raf);
            this._dr_prerender_pump_raf = null;
        }
    }

    /** 泵单帧：在滚动方向前方窗口内挑出最近一个"未渲染且未可见"的页，低 DPR 预渲染 */
    _dr_prerender_pump_tick() {
        if (!this._dr_prerender_pumping || !this._prerender_enabled) {
            this._dr_prerender_pumping = false;
            return;
        }
        // 滚动已停止（超过容差窗口）→ 交还 idle 队列兜底，停止占用 rAF
        if (performance.now() - (this._dr_last_scroll_t || 0) >= 200) {
            this._dr_prerender_pumping = false;
            return;
        }
        if (this._open_prerender_locked) {
            this._dr_prerender_pumping = false;
            return;
        }

        const pages = this.page_manager.pages_list;
        const dir = this._dr_scroll_dir || 1;
        const active = this.active_page_index;
        const span = this._prerender_urgent_span || 9;
        const step = dir > 0 ? 1 : -1;
        const lo = Math.min(active, active + dir * span);
        const hi = Math.max(active, active + dir * span);

        let target = -1;
        for (let i = active + step; i >= lo && i <= hi; i += step) {
            const pd = pages[i];
            if (!pd) continue;
            const can_pre = pd.render_mode === 'pdfjs'
                ? true
                : !!(pd._img_el && pd._img_el.dataset && pd._img_el.dataset.src);
            // 已可见/正在渲染的页跳过；未发起过渲染(pdf_render_promise 为空)的页
            // 纳入前瞻预渲染。已 loaded(缓存命中)的页同样需要预渲染——其守卫会在
            // 重复调用时安全 no-op，不会重复栅格化。
            if (can_pre && !pd.is_visible && !pd.pdf_render_promise) {
                target = i;
                break;
            }
        }

        if (target < 0) {
            // 当前窗口内无待渲染页：若仍在滚动，下一帧继续扫描（span 随 active 推进）；
            // 否则停止。用 rAF 续帧而非立即退出，覆盖"翻到新页后窗口前移"的情况。
            this._dr_prerender_pump_raf = requestAnimationFrame(() => {
                this._dr_prerender_pump_raf = null;
                this._dr_prerender_pump_tick();
            });
            return;
        }

        this._dr_prerender_pump_raf = requestAnimationFrame(() => {
            this._dr_prerender_pump_raf = null;
            this._prerender_page(target).catch(() => {}).finally(() => {
                if (this._dr_prerender_pumping) {
                    this._dr_prerender_pump_raf = requestAnimationFrame(() => {
                        this._dr_prerender_pump_raf = null;
                        this._dr_prerender_pump_tick();
                    });
                }
            });
        });
    }

    _on_page_visible(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data) return;
        page_data.is_visible = true;
        if (this._dom_virtualize()) this._ensure_page_element(page_index);
        this._ensure_page_runtime_dom(page_index);

        // 取消待销毁的 tiles（页面快速滚回可见区域时避免闪烁）
        if (this._page_visible_timeout_id !== null) {
            clearTimeout(this._page_visible_timeout_id);
            this._page_visible_timeout_id = null;
        }

        // 打开期预渲染锁：面板未激活时几何为 0，此时栅格化只会得到错位瓦片、
        // 并在面板稳定后二次重建。锁定期间只标记可见性，等 _dr_apply_scale 统一渲染。
        if (this._open_prerender_locked) return;

        if (page_data.render_mode === 'pdfjs') {
            // 自愈兜底：页面若在缓存恢复前被误标为"空页面延迟创建"，
            // 而缓存恢复后该页实际有批注，必须清除误标并允许重新初始化，
            // 否则 is_tiles_initialized=true 会让下方初始化分支永久跳过
            if (page_data._tiles_deferred && page_data.stroke_history.length > 0) {
                page_data._tiles_deferred = false;
                page_data.is_tiles_initialized = false;
            }
            if (!page_data.is_tiles_initialized) {
                // 窗口 resize 发生在该页无 tile 期间时，批注坐标仍是旧基准；
                // 先对齐布局（尺寸未变时为幂等操作）再初始化 tile，
                // 避免 tile 用新宽度而笔画坐标是旧值导致批注错位/越界不可见
                this._resize_page_layout(page_index, this._get_page_base_width());
                this._init_page_tiles(page_index);
                this._update_overlay_size(page_index);
            }
            // 背景渲染必须放在盒尺寸对齐之后：_ensure_page_runtime_dom 会把盒宽
            // 暂时置回 coord_width（旧基准，见 2471 行），先渲染会把 canvas CSS
            // 尺寸定格在旧宽度，随后 _resize_page_layout 校正盒宽后非强制渲染
            // 会被参数守卫跳过——画布比页盒窄/矮一截（部分页面长宽错位）
            this._render_pdf_page_direct(page_index);
            return;
        }

        // 懒加载图片
        const img = page_data._img_el;
        const has_img_src = img?.hasAttribute('src') && img.getAttribute('src');
        if (img && !has_img_src && img.dataset.src) {
            img.src = img.dataset.src;
            img.onload = () => {
                // 图片加载后设置页面尺寸并初始化 tiles
                page_data.page_width = img.naturalWidth || img.clientWidth;
                page_data.page_height = img.naturalHeight || img.clientHeight;
                this._refresh_page_aspect(page_data);
                this._resize_page_layout(page_index, this._get_page_base_width());
                if (!page_data.is_tiles_initialized) {
                    this._init_page_tiles(page_index);
                    this._update_overlay_size(page_index);
                }
            };
        } else if (img && has_img_src) {
            // 已有图片 → 立即初始化 tiles（无延迟，避免白屏）
            page_data.page_width = img.naturalWidth || img.clientWidth;
            page_data.page_height = img.naturalHeight || img.clientHeight;
            this._refresh_page_aspect(page_data);
            this._resize_page_layout(page_index, this._get_page_base_width());
            if (!page_data.is_tiles_initialized) {
                this._init_page_tiles(page_index);
                this._update_overlay_size(page_index);
            }
        }

        // PDF 懒加载：如果页面未加载，则加载
        if (!page_data.loaded && this.folder_index >= 0) {
            this._load_pdf_page(page_index);
        }
    }

    _on_page_hidden(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data) return;
        page_data.is_visible = false;

        // 取消待处理的初始化定时器（快速滚动跳过该页）
        if (page_data._visible_init_timeout !== null) {
            clearTimeout(page_data._visible_init_timeout);
            page_data._visible_init_timeout = null;
        }

        // 离开视口后延迟释放页面 GPU 资源（防抖动 + requestIdleCallback 降 GPU 峰值）
        if (this._page_visible_timeout_id !== null) {
            clearTimeout(this._page_visible_timeout_id);
        }
        this._page_visible_timeout_id = setTimeout(() => {
            this._page_visible_timeout_id = null;
            const destroy_fn = () => this._cleanup_hidden_page_gpu();
            if (window.requestIdleCallback) {
                window.requestIdleCallback(destroy_fn, { timeout: 2000 });
            } else {
                destroy_fn();
            }
        }, this._gpu_cleanup_delay_ms);
    }

    // ====== PDF 懒加载 ======

    async _load_pdf_page(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data || page_data.loaded) return;
        if (page_data.render_mode === 'pdfjs') {
            page_data.loaded = true;
            return this._render_pdf_page_direct(page_index);
        }
        if (page_data.loading_promise) return page_data.loading_promise;

        const folder = this._get_active_folder();
        if (!folder || !folder.pdfDoc) return;

        page_data.loading_promise = (async () => {
            const page_num = page_data.page_num;
            const doc_number = folder.docNumber ?? null;

            const { get_pdf_page_info } = await import('./document_loader.js');
            const result = await get_pdf_page_info(folder.pdfDoc, page_num, doc_number);

            // 更新页面数据
            page_data.image_url = null;
            page_data.thumbnail_url = null;
            page_data.render_mode = 'pdfjs';
            page_data.loaded = true;
            page_data.page_width = result.width;
            page_data.page_height = result.height;
            this._refresh_page_aspect(page_data);

            // 移除占位符
            const placeholder = page_data.page_element?.querySelector('.doc-reader-page-placeholder:not(.doc-reader-page-virtual-placeholder)');
            if (placeholder) {
                placeholder.remove();
            }

            page_data._img_el?.remove();
            page_data._img_el = null;
            this._create_pdf_page_layers(page_data);
            if (!page_data._tiles_container) {
                const tiles_container = document.createElement('div');
                tiles_container.className = 'doc-reader-page-tiles';
                page_data.page_element?.appendChild(tiles_container);
                page_data._tiles_container = tiles_container;
            }
            this._resize_page_layout(page_index, this._get_page_base_width());

            // 更新侧边栏中的页面数据
            if (folder.pages[page_index]) {
                folder.pages[page_index].full = null;
                folder.pages[page_index].thumbnail = null;
                folder.pages[page_index].loaded = true;
                folder.pages[page_index].width = result.width;
                folder.pages[page_index].height = result.height;
                folder.pages[page_index].renderMode = 'pdfjs';
            }

            await this._render_pdf_page_direct(page_index);
        })();

        try {
            return await page_data.loading_promise;
        } catch (error) {
            // 快速滚动时页面被虚拟化/取消渲染属预期，静默处理
            if (error?.name !== 'RenderingCancelledException') {
                console.error(`加载 PDF 页面 ${page_index + 1} 失败:`, error);
            }
        } finally {
            page_data.loading_promise = null;
        }
    }

    // ====== TileRenderer 集成 ======

    _is_page_near_active(page_index, distance) {
        if (this.active_page_index < 0) return false;
        return Math.abs(page_index - this.active_page_index) <= distance;
    }

    _cleanup_hidden_page_gpu() {
        if (!this.page_manager?.pages_list) return;

        const pages = this.page_manager.pages_list;

        // ［性能］tile 销毁仅遍历实际有 tile 的页面，跳过大量无 tile 页
        for (const i of this._pages_with_tiles) {
            const pd = pages[i];
            if (!pd || pd.is_visible || i === this.active_page_index) continue;
            if (!this._is_page_near_active(i, this._tile_keep_distance)) {
                this._destroy_page_tiles(i);
            }
        }

        // 虚拟化 / blob 释放仍需遍历全部页（可能有图片但没有 tile）
        for (let i = 0; i < pages.length; i++) {
            const pd = pages[i];
            if (!pd || pd.is_visible || i === this.active_page_index) continue;
            if (!pd.loaded && !pd.image_url) continue;

            if (this._dom_virtualize() && !this._is_page_near_active(i, this._wrapper_keep_distance)) {
                // 远于包裹窗口：释放图层/图片并彻底卸载出文档树（仅留缓存坐标），
                // 是当前标签内 DOM 节点数最小化的关键——373 页文档常态仅 ~17 个包裹常驻。
                // 仅虚拟化模式执行：非虚拟化(flex 流)下无绝对定位补偿，卸载会导致页面消失
                this._virtualize_page(i);
                this._unmount_page_element(i);
            } else if (!this._is_page_near_active(i, this._image_keep_distance)) {
                this._virtualize_page(i);
            } else if (!this._is_page_near_active(i, this._blob_keep_distance)) {
                this._release_page_blob_url(i);
            }
        }
    }

    /** 虚拟化：若页面包裹已卸载则重建并挂回文档树（仅恢复结构，图层由 _on_page_visible 初始化） */
    _ensure_page_element(page_index) {
        const pd = this.page_manager.pages_list[page_index];
        if (!pd) return null;
        if (pd.page_element) return pd.page_element;
        const base_w = this._get_page_base_width();
        const div = this._spawn_page_element(page_index, base_w);
        const wrap = this._zoom_wrapper;
        if (wrap) wrap.appendChild(div);
        div.style.position = 'absolute';
        div.style.top = (pd._cached_top || 0) + 'px';
        div.style.left = '0';
        return div;
    }

    /** 虚拟化：把页面包裹从文档树彻底卸载（保留 pd 中的坐标缓存与业务数据） */
    _unmount_page_element(page_index) {
        const pd = this.page_manager.pages_list[page_index];
        if (!pd?.page_element) return;
        if (pd.page_element.parentNode) {
            pd.page_element.parentNode.removeChild(pd.page_element);
        }
        pd.page_element = null;
        // 卸载后作废残留的渲染 promise：若页面在 _render_pdf_page_direct 的
        // rAF 让出期间被虚拟化卸载，pdf_render_promise 已被赋值为一个 resolved
        // 的空 promise；不清空会让下次重建后 2458 行的守卫直接返回旧 promise，
        // 导致该页永不再渲染（表现为滑过首屏窗口后远页永久空白）。
        // 注意 _virtualize_page 内仅当 render_mode==='pdfjs' 才走 _release_pdf_page_render
        // 清理，这里统一兜底，覆盖 _virtualize_page 因 is_visible 守卫 early-return 的分支。
        pd.pdf_render_promise = null;
    }

    _ensure_page_runtime_dom(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        const page_el = page_data?.page_element;
        if (!page_el) return;

        page_el.classList.remove('virtualized');
        page_data.is_virtualized = false;

        page_el.querySelectorAll('.doc-reader-page-virtual-placeholder').forEach(el => el.remove());

        if (page_data.render_mode === 'pdfjs') {
            // 注意：背景 canvas 的权威引用是 pdf_canvas（由 _create_pdf_page_layers 维护），
            // _pdf_canvas_el 是无人赋值的僵尸字段，勿再使用
            if (!page_data.pdf_canvas) {
                const existing = page_el.querySelector('.doc-reader-pdf-canvas');
                if (existing) page_data.pdf_canvas = existing;
                else this._create_pdf_page_layers(page_data);
            } else if (page_data.pdf_canvas.parentNode !== page_el) {
                // 归位兜底：引用仍在但已脱离页面 DOM（如虚拟化剥离），重新挂载到最底层
                page_el.prepend(page_data.pdf_canvas);
                page_data._pdf_canvas_el = page_data.pdf_canvas;
            }
            if (!page_data._tiles_container) {
                const tiles_container = document.createElement('div');
                tiles_container.className = 'doc-reader-page-tiles';
                page_el.appendChild(tiles_container);
                page_data._tiles_container = tiles_container;
            } else if (page_data._tiles_container.parentNode !== page_el) {
                // 批注容器归位：游离的容器必须重新挂载，否则批注不可见
                page_el.appendChild(page_data._tiles_container);
            }
            this._sync_page_box_to_base(page_data);
            return;
        }

        let img = page_data._img_el;
        if (!img) {
            img = document.createElement('img');
            img.alt = `第 ${page_data.page_num} 页`;
            img.loading = 'lazy';
            img.decoding = 'async';
            page_el.prepend(img);
            page_data._img_el = img;
        } else if (img.parentNode !== page_el) {
            page_el.prepend(img);
        }
        if (page_data.image_url) {
            img.dataset.src = page_data.image_url;
        }

        const existing_placeholder = page_el.querySelector('.doc-reader-page-placeholder:not(.doc-reader-page-virtual-placeholder)');
        if (!page_data.loaded && !existing_placeholder) {
            const placeholder = document.createElement('div');
            placeholder.className = 'doc-reader-page-placeholder';
            placeholder.textContent = `第 ${page_data.page_num} 页`;
            page_el.appendChild(placeholder);
        } else if (page_data.loaded && existing_placeholder) {
            existing_placeholder.remove();
        }

        if (!page_data._tiles_container) {
            const tiles_container = document.createElement('div');
            tiles_container.className = 'doc-reader-page-tiles';
            page_el.appendChild(tiles_container);
            page_data._tiles_container = tiles_container;
        } else if (page_data._tiles_container.parentNode !== page_el) {
            // 批注容器归位：游离的容器必须重新挂载，否则批注不可见
            page_el.appendChild(page_data._tiles_container);
        }

        this._sync_page_box_to_base(page_data);
    }

    /**
     * 把页盒对齐到当前基准宽。仅在宽度确实变化时写入样式——本函数在每次
     * 可见性扫描都会被调用，无条件写入会反复打脏页面位置缓存（引发全量
     * offsetTop 重读）。盒宽一律取当前基准，禁止回退 coord_width：那是批注
     * 坐标系基准，可能停留在旧窗口宽度（跨会话缓存恢复/延迟补偿中），
     * 用作盒宽会让该页保持旧尺寸且没有任何后续路径会再纠正它。
     * 盒高可能相对最新宽高比滞后，由渲染完成校验/后台回填经
     * _resize_page_layout（盒高现算）负责修正。
     */
    _sync_page_box_to_base(page_data) {
        if (!page_data?.page_element) return;
        const base_w = this._get_page_base_width();
        const cur_w = Math.round(parseFloat(page_data.page_element.style.width)) || 0;
        if (cur_w !== base_w) {
            this._set_page_box_size(page_data, base_w);
        }
    }

    _virtualize_page(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        const page_el = page_data?.page_element;
        if (!page_el || page_data.is_virtualized || page_data.is_visible) return;

        this._destroy_page_tiles(page_index);
        if (page_data.render_mode === 'pdfjs') {
            this._release_pdf_page_render(page_index);
        } else {
            this._release_page_image(page_index);
        }

        const placeholder = document.createElement('div');
        placeholder.className = 'doc-reader-page-placeholder doc-reader-page-virtual-placeholder';
        placeholder.textContent = `第 ${page_data.page_num} 页`;

        page_el.replaceChildren(placeholder);
        page_el.classList.add('virtualized');
        page_data.is_virtualized = true;

        // replaceChildren 已把背景层/批注容器整体摘出 DOM。
        // 必须置空这些引用，否则恢复路径（_ensure_page_runtime_dom）看到
        // "引用非空"会跳过重建，新批注 tile 会被渲染进游离节点——表现为翻回该页后笔迹不可见
        // （tile 内容已由上方 _destroy_page_tiles 清空，置空引用无数据丢失）
        page_data._tiles_container = null;
        page_data._img_el = null;
        page_data._pdf_canvas_el = null;
        page_data.pdf_canvas = null;
    }

    _release_page_image(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        const img = page_data?._img_el;
        if (!img || !img.hasAttribute('src')) return;

        img.onload = null;
        img.removeAttribute('src');
        // blob URL 保留在 dataset.src，页面再次可见时复用；移除 src 后浏览器可回收解码纹理。
    }

    // ====== Canvas 池（复用离屏 canvas，减少 GC 压力） ======

    _acquire_temp_canvas(width, height) {
        let canvas = this._canvas_pool.pop();
        if (!canvas) {
            canvas = document.createElement('canvas');
        }
        canvas.width = Math.ceil(width);
        canvas.height = Math.ceil(height);
        return canvas;
    }

    _release_temp_canvas(canvas) {
        if (!canvas) return;
        if (this._canvas_pool.length < this._canvas_pool_max) {
            this._canvas_pool.push(canvas);
        }
    }

    _create_pdf_page_layers(page_data) {
        const page_el = page_data?.page_element;
        if (!page_el) return;

        if (!page_el.querySelector('.doc-reader-pdf-canvas')) {
            const canvas = document.createElement('canvas');
            canvas.className = 'doc-reader-pdf-canvas';
            canvas.setAttribute('aria-label', `第 ${page_data.page_num} 页`);
            page_el.appendChild(canvas);
            page_data.pdf_canvas = canvas;
        } else {
            page_data.pdf_canvas = page_el.querySelector('.doc-reader-pdf-canvas');
        }

        // 文本层已移除，清理遗留 DOM 节点
        const existing = page_el.querySelector('.doc-reader-text-layer');
        if (existing) existing.remove();
        page_data.pdf_text_layer = null;
    }

    /**
     * 根据缩放级别和内存压力计算自适应 DPR
     * @param {number} base_dpr - 基础设备像素比
     * @param {number} scale - 当前缩放级别
     * @returns {number} 降级后的 DPR
     */
    _calculate_adaptive_dpr(base_dpr, scale, is_active_page = true) {
        if (!this._adaptive_dpr_enabled) return Math.min(base_dpr, 2);

        // 极低缩放（<0.3）时才强制降 DPR=1，避免 0.5x 附近的模糊
        if (scale < 0.3) return 1;

        // 内存压力检测：堆内存超 500MB 时降级 DPR
        if (performance.memory?.usedJSHeapSize > 500 * 1024 * 1024) return 1;

        // 非当前页只在大幅放大（>3x）且不可见时才降级
        if (!is_active_page && scale > 3) return 1;

        // 使用 ceil 语义避免向下取整导致的模糊，上限 4x 防止 OOM
        const dpr = base_dpr * scale;
        const step = 0.25;
        return Math.min(Math.ceil(dpr / step) * step, 4);
    }

    /** 计算某页当前期望的 PDF 渲染参数（渲染起点与完成后收敛检查共用，避免两处漂移） */
    _pdf_desired_render_params(page_index, page_data, is_prerender) {
        const css_w = Math.round(parseFloat(page_data.page_element.style.width)) || page_data.page_element.clientWidth || 800;
        const target_dpr = is_prerender ? 1 : this._calculate_adaptive_dpr(
            window.devicePixelRatio || window.DRAW_CONFIG?.dpr || 1,
            this.dr_scale,
            page_index === this.active_page_index
        );
        return { css_w, target_dpr };
    }

    async _render_pdf_page_direct(page_index, force = false, is_prerender = false) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data || page_data.render_mode !== 'pdfjs') return;

        // 缩放进行中不触发 PDF 重绘，由缩放结束后的批量刷新处理
        if (this._dr_is_zooming && !force) return;

        if (page_data.pdf_render_promise && !force) return page_data.pdf_render_promise;

        const folder = this._get_active_folder();
        if (!folder?.pdfDoc || !page_data.page_element) return;

        this._create_pdf_page_layers(page_data);
        const { css_w, target_dpr } = this._pdf_desired_render_params(page_index, page_data, is_prerender);
        if (!force &&
            page_data.pdf_render_css_width === css_w &&
            page_data.pdf_render_dpr === target_dpr &&
            page_data.pdf_canvas?.width > 0) {
            return;
        }

        // 渲染序列号：异步渲染期间若又启动了更新的渲染（连续缩放/可见化接管），
        // 旧结果在完成后必须丢弃——否则低分辨率的旧任务会反向覆盖新画面，
        // 或把守卫值改写成过期参数（表现为动态分辨率时好时坏、无法稳定复现）
        const my_seq = (page_data.pdf_render_seq = (page_data.pdf_render_seq || 0) + 1);

        // 记录被本次调用覆盖前的旧渲染 promise：force 路径下会 cancel 旧渲染任务，
        // 旧任务以 RenderingCancelledException reject。本调用自身用本地 const 引用其 promise，
        // 避免后续 force 调用改写 page_data.pdf_render_promise 后，原调用误 await 到新 promise、
        // 导致旧 promise 的取消异常无人捕获 → Uncaught (in promise)
        const prev_render_promise = page_data.pdf_render_promise;

        const render_promise = (async () => {
            // 并发节流：非首屏且已在途渲染达上限 → 让出主线程到下一帧再启动，
            // 摊平首屏/滚动时多页同现的渲染峰值（避免 getPage+drawImage 在主线程堆叠卡顿）
            const _is_first = this._pending_first_render && page_index === this.active_page_index;
            if (!_is_first && this._render_in_flight >= this._RENDER_MAX) {
                await new Promise(r => requestAnimationFrame(r));
                if (!this.is_open) return;
                const pd_chk = this.page_manager.pages_list[page_index];
                if (!pd_chk || pd_chk.render_mode !== 'pdfjs' || !pd_chk.page_element) {
                    // 等待期间页面被卸载：本次渲染作废。必须清空 2477 行已写入的
                    // pdf_render_promise，否则下次重建后 2458 行守卫会直接返回这个
                    // resolved 的空 promise，页面永久不渲染（远页空白的根因）。
                    page_data.pdf_render_promise = null;
                    return;
                }
            }
            this._render_in_flight++;
            try {
            if (force && page_data.pdf_render_task) {
                page_data.pdf_render_task.cancel?.();
                page_data.pdf_render_task = null;
                // 被取消的旧任务其 promise 会以 RenderingCancelledException reject；
                // 此处兜底吞掉，避免旧调用方缺失 catch 时产生 Uncaught (in promise)
                try { prev_render_promise?.catch(() => {}); } catch (_) {}
            }

            let pdf_page = this._pdf_page_cache.get(page_index);
            if (!pdf_page) {
                pdf_page = await folder.pdfDoc.getPage(page_data.page_num);
                this._pdf_page_cache.set(page_index, pdf_page);
                this._pdf_page_cache_evict();
            }
            try {
                const base_viewport = pdf_page.getViewport({ scale: 1 });
                const css_scale = css_w / base_viewport.width;
                const css_viewport = pdf_page.getViewport({ scale: css_scale });

                // 预渲染固定 1x，普通渲染沿用缓存检查阶段已算好的 target_dpr
                const render_dpr = is_prerender ? 1 : target_dpr;
                const render_viewport = pdf_page.getViewport({ scale: css_scale * render_dpr });

                page_data.page_width = base_viewport.width;
                page_data.page_height = base_viewport.height;
                this._refresh_page_aspect(page_data);

                const canvas = page_data.pdf_canvas;
                if (!canvas) return;

                const render_w = Math.ceil(render_viewport.width);
                const render_h = Math.ceil(render_viewport.height);
                const css_w_px = Math.ceil(css_viewport.width) + 'px';
                const css_h_px = Math.ceil(css_viewport.height) + 'px';

                // 离屏预渲染：先渲染到临时 canvas，保留显示 canvas 旧内容避免白屏
                const tempCanvas = this._acquire_temp_canvas(render_w, render_h);
                try {
                    const tempCtx = tempCanvas.getContext('2d', { alpha: false });
                    tempCtx.setTransform(1, 0, 0, 1, 0, 0);
                    tempCtx.fillStyle = '#fff';
                    tempCtx.fillRect(0, 0, render_w, render_h);

                    const render_task = pdf_page.render({
                        canvasContext: tempCtx,
                        viewport: render_viewport,
                        annotationMode: 0
                    });
                    page_data.pdf_render_task = render_task;
                    await render_task.promise;
                    page_data.pdf_render_task = null;

                    // 过期结果丢弃：渲染期间又启动了更新的渲染（seq 已前移）。
                    // 不换画布、不写守卫，避免旧任务反向覆盖新画面/污染守卫参数
                    if (page_data.pdf_render_seq !== my_seq) return;

                    // 页面已不在视口 → 跳过 swap，保留旧内容（后续 virtualization 会清理）
                    if (!page_data.is_visible && !is_prerender) return;

                    // 渲染完成后原子交换到显示 canvas（resize + drawImage 在同一帧完成）
                    canvas.width = render_w;
                    canvas.height = render_h;
                    const ctx = canvas.getContext('2d', { alpha: false });
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.drawImage(tempCanvas, 0, 0);
                    canvas.style.width = css_w_px;
                    canvas.style.height = css_h_px;

                    page_data.pdf_render_css_width = css_w;
                    page_data.pdf_render_dpr = target_dpr;
                    // 渲染成功：清零重试与连败计数
                    page_data._render_retry_count = 0;
                    this._note_render_success();

                    // 真实页面宽高已确定（2700 行处赋值），按真实宽高比校页盒：
                    // 导入期除首页外全部按首页尺寸估算（folder._pages_estimated），
                    // 而后台回填只处理当时已挂载的页——渲染时才发现真实比例的页，
                    // 页盒仍是估算比例，画布 CSS 却是真实比例，表现为页面下方
                    // 留白/内容越出页盒（窗口 resize 后用估算比例重算盒高会固化错位）。
                    // 走 _resize_page_layout 完成对齐：含批注纵向补偿、tile 重建与
                    // 布局重算；宽高比一致时差值 <=1px，直接跳过（幂等空操作）
                    if (!this._open_prerender_locked && this.is_open
                        && this.page_manager?.pages_list?.[page_index] === page_data
                        && page_data.page_element) {
                        const box_w = parseFloat(page_data.page_element.style.width) || 0;
                        const box_h = parseFloat(page_data.page_element.style.height) || 0;
                        const want_h = box_w > 0 ? Math.round(box_w / this._get_page_aspect(page_data)) : 0;
                        if (want_h > 0 && box_h > 0 && Math.abs(box_h - want_h) > 1) {
                            this._resize_page_layout(page_index, this._get_page_base_width());
                        }
                    }

                    // 首屏 DOM 加载完成：当前活动页真正渲染到显示 canvas 后，
                    // 隐藏阅读器内加载层（满足"等待 DOM 加载成功才算加载成功"）
                    if (this._pending_first_render && page_index === this.active_page_index) {
                        this._pending_first_render = false;
                        this._hide_reader_loading();
                    }

                    // 收敛检查：异步渲染期间缩放继续变化 → 参数已过期，
                    // 安排一次跟进重渲染（参数一致时空转，连续缩放由 zooming 门控拦截）
                    if (!is_prerender && !this._dr_is_zooming) {
                        const want = this._pdf_desired_render_params(page_index, page_data, false);
                        if (want.css_w !== css_w || want.target_dpr !== target_dpr) {
                            requestAnimationFrame(() => {
                                if (!this.is_open || this._dr_is_zooming) return;
                                if (this.page_manager.pages_list[page_index] !== page_data) return;
                                if (page_data.render_mode !== 'pdfjs') return;
                                this._render_pdf_page_direct(page_index);
                            });
                        }
                    }
                } finally {
                    // 确保 tempCanvas 始终归还池中，避免泄露
                    this._release_temp_canvas(tempCanvas);
                }
            } finally {
                // 缓存页不 cleanup，保持内部数据热就绪；移除缓存时才释放
            }
            } finally {
                this._render_in_flight--;
            }
        })();
        page_data.pdf_render_promise = render_promise;

        try {
            // 必须 await 本地 render_promise 而非 page_data.pdf_render_promise：
            // 后者可能在并发 force 调用中被改写，届时本调用会误 await 到新 promise、
            // 导致自身 render_promise 的渲染取消异常（RenderingCancelledException）无人捕获
            return await render_promise;
        } catch (error) {
            if (error?.name !== 'RenderingCancelledException') {
                console.error(`直接渲染 PDF 页面 ${page_index + 1} 失败:`, error);
                // 高负载/worker 异常时渲染可能瞬态失败；不恢复会让已清空的画布永远白屏
                this._handle_render_failure(page_index);
            }
        } finally {
            // 仅当仍指向本调用创建的 promise 时才清空，避免覆盖并发 force 调用写入的新 promise
            if (page_data.pdf_render_promise === render_promise) {
            page_data.pdf_render_promise = null;
        }
    }
    }

    /** 渲染成功：清除该页重试计数与全局连败计数 */
    _note_render_success() {
        this._render_fail_streak = 0;
    }

    /**
     * 渲染失败恢复：
     * 1) 每页最多自动重试 2 次（250ms / 800ms 退避，force 绕过内容缓存守卫）
     * 2) 全局连续失败 ≥4 次 → 视为文档解析态/worker 异常，自动按 reloadPath 重载文档并强刷可见页
     */
    _handle_render_failure(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data || !this.is_open) return;

        this._render_fail_streak++;
        const retries = page_data._render_retry_count || 0;
        if (retries < 2) {
            page_data._render_retry_count = retries + 1;
            const delay = retries === 0 ? 250 : 800;
            setTimeout(() => {
                if (!this.is_open) return;
                const pd = this.page_manager.pages_list[page_index];
                if (!pd?.page_element) return;
                // force=true：失败后 pdf_render_css_width 等守卫值仍是旧成功的，
                // 非 force 会误判"内容有效"直接跳过，导致白屏固化
                this._render_pdf_page_direct(page_index, true);
            }, delay);
            return;
        }
        page_data._render_retry_count = 0;

        if (this._render_fail_streak >= 4 && !this._reloading_doc) {
            this._reload_active_doc();
        }
    }

    // ====== 阅读器内加载层（打开 / 切标签） ======

    /**
     * 显示阅读器内加载层。挂在 #documentReaderPanel 上（而非 scroll container）：
     * open() 内的 _build_page_dom 会清空 scroll container，若挂容器上会被脱离文档树；
     * 面板不被重建，加载层得以贯穿"打开文档 → 构建 DOM → 首屏渲染"全程。
     * 视觉复用 .loading-overlay（深色半透明遮罩 + 居中圆角黑框 + 旋转 spinner），
     * 仅经 .reader-loading-overlay 把定位限定在阅读器面板内，不盖首页/工具栏。
     */
    _show_reader_loading() {
        const panel = document.getElementById('documentReaderPanel');
        if (!panel) return;
        // 残留引用已脱离文档树（如旧 open 中途被新 open 覆盖）→ 重建，避免加载层静默失效
        if (this._reader_loading_el && !this._reader_loading_el.isConnected) {
            this._reader_loading_el.remove();
            this._reader_loading_el = null;
        }
        if (this._reader_loading_el) return;
        const el = document.createElement('div');
        el.className = 'loading-overlay reader-loading-overlay';
        el.innerHTML = '<div class="loading-content">'
            + '<div class="loading-spinner"></div>'
            + '<div class="loading-message">'
            + (window.i18n?.format_translate('loading.rendering') || '正在加载...')
            + '</div></div>';
        panel.appendChild(el);
        this._reader_loading_el = el;
    }

    _hide_reader_loading() {
        if (this._open_loading_timer) {
            clearTimeout(this._open_loading_timer);
            this._open_loading_timer = null;
        }
        if (this._reader_loading_el) {
            this._reader_loading_el.remove();
            this._reader_loading_el = null;
        }
    }

    /**
     * 后台并行回填剩余页真实尺寸：导入期仅读取首页真实尺寸（其余按首页估算），
     * 首屏即时渲染后，此处流式读取第 2..N 页真实宽高比并一次性重排 + 按真实尺寸重渲染活动页。
     * 与"打开流程"并行：首屏不等待全部页元数据读取完成。
     * 仅当 folder._pages_estimated 为真（即导入期采用了估算）时由 open() 调用。
     */
    async _stream_remaining_page_dims() {
        const folder = this._active_folder;
        const pdfDoc = folder?.pdfDoc;
        const pm = this.page_manager;
        if (!pdfDoc || !pm || pm.pages_list.length <= 1) return;
        const total = pm.pages_list.length;
        const BATCH = 8;
        let dirty = false;
        for (let s = 1; s < total; s += BATCH) {
            if (!this.is_open || this.page_manager !== pm || this._active_folder !== folder) return;
            const end = Math.min(s + BATCH, total);
            let results;
            try {
                const { get_pdf_page_info } = await import('./document_loader.js');
                results = await Promise.all(
                    Array.from({ length: end - s }, (_, k) => get_pdf_page_info(pdfDoc, s + k + 1, folder.docNumber))
                );
            } catch (_) {
                results = null;
            }
            if (!results || !this.is_open || this.page_manager !== pm || this._active_folder !== folder) return;
            for (let k = 0; k < results.length; k++) {
                const i = s + k;
                const info = results[k];
                if (!info) continue;
                const pd = pm.pages_list[i];
                if (!pd) continue;
                if (pd.page_width === info.width && pd.page_height === info.height) continue;
                pd.page_width = info.width;
                pd.page_height = info.height;
                pd.aspect_ratio = (info.width && info.height) ? info.width / info.height : (pd.aspect_ratio || 0.70710678);
                if (folder.pages && folder.pages[i]) {
                    folder.pages[i].width = info.width;
                    folder.pages[i].height = info.height;
                }
                // 已挂载的页面走完整 resize：宽高比修正必须同时纵向补偿批注坐标、
                // 重建 tile 并重算布局——裸 _set_page_box_size 只改盒尺寸，会让
                // 已有 tile/批注停留在旧比例坐标系（渲染出的画布与批注互相错位）。
                // 未挂载页在重挂载时按真实 aspect 重建（_resize_page_layout 内部守卫）
                this._resize_page_layout(i, this._get_page_base_width());
                dirty = true;
            }
            await new Promise(r => requestAnimationFrame(r));
        }
        if (dirty && this.is_open && this.page_manager === pm && this._active_folder === folder) {
            // 绝对定位下尺寸变化需手动平移后续页：一次性重排修正所有 offsetTop
            if (this._dom_virtualize()) {
                this._compute_page_layout();
                this._apply_page_positions();
            }
            // 活动页按真实尺寸重渲染（若此前用估算尺寸）
            const act = this.active_page_index;
            if (act >= 0 && act < total) this._resize_page_layout(act, this._get_page_base_width());
        }
    }

    /** 阅读器内轻量提示（底部居中，自动消失） */
    _show_reader_toast(msg, duration = 2600) {
        try {
            let el = document.getElementById('drReaderToast');
            if (!el) {
                el = document.createElement('div');
                el.id = 'drReaderToast';
                el.className = 'dr-reader-toast';
                document.body.appendChild(el);
            }
            el.textContent = msg;
            el.classList.add('show');
            clearTimeout(this._toast_timer);
            this._toast_timer = setTimeout(() => el.classList.remove('show'), duration);
        } catch (_) {}
    }

    /**
     * 连续渲染失败后的自愈：销毁当前 pdfDoc 并按 reloadPath 重新加载，
     * 使所有页的渲染缓存失效后强刷可见页。批注在内存中不受影响。
     */
    async _reload_active_doc() {
        if (this._reloading_doc || !this.is_open) return;
        const folder = this._get_active_folder();
        const translate = (key, fallback) => window.i18n?.format_translate(key) || fallback;

        if (!folder?.reloadPath) {
            this._render_fail_streak = 0;
            this._show_reader_toast(translate('reader.recoverFailed', '页面渲染异常，请关闭后重新打开该文档'), 3600);
            return;
        }

        this._reloading_doc = true;
        this._show_reader_toast(translate('reader.recovering', '检测到渲染异常，正在自动恢复…'), 8000);
        try {
            try { await folder.pdfDoc?.destroy?.(); } catch (_) {}
            folder.pdfDoc = null;

            const ok = await window.main_ensure_folder_doc?.(folder);
            if (!ok || !this.is_open) return;

            // 渲染缓存守卫失效化 + 清空残缺画布，强制全部重建
            for (const pd of this.page_manager.pages_list) {
                pd.pdf_render_css_width = null;
                pd.pdf_render_dpr = null;
                pd._render_retry_count = 0;
            }

            this._pending_far_target = -1;
            this._check_page_visibility();

            // 显式强刷可见页（含活动页），不依赖下一次滚动事件
            const visible_indexes = [];
            const pages_list = this.page_manager.pages_list;
            for (let i = 0; i < pages_list.length; i++) {
                if (pages_list[i]?.is_visible) visible_indexes.push(i);
            }
            if (visible_indexes.length === 0 && this.active_page_index >= 0) {
                visible_indexes.push(this.active_page_index);
            }
            for (const i of visible_indexes) {
                this._render_pdf_page_direct(i, true);
            }

            this._render_fail_streak = 0;
            this._show_reader_toast(translate('reader.recovered', '已恢复'), 1800);
        } catch (e) {
            console.error('[document_reader] 自动恢复失败:', e);
            this._render_fail_streak = 0;
            this._show_reader_toast(translate('reader.recoverFailed', '页面渲染异常，请关闭后重新打开该文档'), 3600);
        } finally {
            this._reloading_doc = false;
        }
    }

    /** 空闲时间预加载附近页面的 PDFPage 到缓存，减少后续滚动/缩放时的 getPage() 延迟 */
    _idle_preload_pages(center_page) {
        const folder = this._get_active_folder();
        if (!folder?.pdfDoc?.getPage) return;

        const preload_fn = () => {
            const total = this.page_manager?.pages_list?.length || 0;
            if (total === 0) return;

            const radius = 10; // 前后各 10 页，共 21 页
            const start = Math.max(0, center_page - radius);
            const end = Math.min(total - 1, center_page + radius);
            const pages_to_load = [];
            for (let i = start; i <= end; i++) {
                if (!this._pdf_page_cache.has(i)) {
                    const pd = this.page_manager.pages_list[i];
                    if (pd?.render_mode === 'pdfjs') {
                        pages_to_load.push(i);
                    }
                }
            }

            // 分批加载，每批并发 3 个，避免阻塞主线程
            const batch_size = 3;
            const load_batch = async (indices) => {
                for (let i = 0; i < indices.length; i += batch_size) {
                    const batch = indices.slice(i, i + batch_size);
                    await Promise.all(batch.map(async (idx) => {
                        if (this._pdf_page_cache.has(idx)) return;
                        if (!this.is_open) return;
                        const pd = this.page_manager.pages_list[idx];
                        if (!pd) return;
                        try {
                            const pdf_page = await folder.pdfDoc.getPage(pd.page_num);
                            if (this.is_open) {
                                this._pdf_page_cache.set(idx, pdf_page);
                                this._pdf_page_cache_evict();
                            } else {
                                pdf_page.cleanup?.();
                            }
                        } catch (_) {
                            // 单个页面加载失败不影响其他页
                        }
                    }));
                }
            };

            load_batch(pages_to_load);
        };

        if (window.requestIdleCallback) {
            this._preload_idle_id = window.requestIdleCallback(preload_fn, { timeout: 3000 });
        } else {
            this._preload_idle_id = setTimeout(preload_fn, 500);
        }
    }

    _release_pdf_page_render(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data) return;

        if (page_data.pdf_render_task) {
            page_data.pdf_render_task.cancel?.();
            page_data.pdf_render_task = null;
            // 兜底吞掉被取消任务 promise 的预期 reject（见 _render_pdf_page_direct 同类处理）
            try { page_data.pdf_render_promise?.catch(() => {}); } catch (_) {}
        }
        if (page_data.pdf_canvas) {
            page_data.pdf_canvas.width = 0;
            page_data.pdf_canvas.height = 0;
        }
        page_data.pdf_render_css_width = 0;
        // 关键：必须清空渲染守卫 promise，否则页面被虚拟化卸载后重建时，
        // _render_pdf_page_direct 会因 pdf_render_promise 残留（truthy）而直接
        // return 旧 promise、跳过重新栅格化 → 已浏览/翻回的页永久空白（下滑翻页失效）
        page_data.pdf_render_promise = null;

        // 释放缓存的 PDFPage 对象
        const cached = this._pdf_page_cache.get(page_index);
        if (cached) {
            cached.cleanup?.();
            this._pdf_page_cache.delete(page_index);
        }
    }

    /** LRU 驱逐：超出上限时清理最久未访问的 PDFPage */
    _pdf_page_cache_evict() {
        while (this._pdf_page_cache.size > this._pdf_page_cache_max) {
            const oldest_key = this._pdf_page_cache.keys().next().value;
            const oldest = this._pdf_page_cache.get(oldest_key);
            oldest?.cleanup?.();
            this._pdf_page_cache.delete(oldest_key);
        }
    }

    _release_page_blob_url(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data || page_data.is_visible || page_index === this.active_page_index) return;
        if (page_data.render_mode === 'pdfjs') return;

        const image_url = page_data.image_url;
        const thumbnail_url = page_data.thumbnail_url;
        if (!image_url && !thumbnail_url) return;

        const revoke_urls = new Set();
        if (image_url?.startsWith('blob:')) revoke_urls.add(image_url);
        if (thumbnail_url?.startsWith('blob:')) revoke_urls.add(thumbnail_url);
        if (revoke_urls.size === 0) return;

        const img = page_data._img_el;
        if (img) {
            img.onload = null;
            img.removeAttribute('src');
            img.removeAttribute('data-src');
        }

        const sidebar_img = document.querySelector(`#drPageSidebar .dr-page-sidebar-thumb[data-page="${page_index}"]`);
        if (sidebar_img) {
            sidebar_img.removeAttribute('src');
            sidebar_img.classList.add('is-loading');
            sidebar_img.closest('.dr-page-sidebar-item')?.classList.add('loading');
        }

        revoke_urls.forEach(url => URL.revokeObjectURL(url));

        page_data.image_url = null;
        page_data.thumbnail_url = null;
        page_data.loaded = false;

        const folder_page = this._get_active_folder()?.pages?.[page_index];
        if (folder_page) {
            folder_page.full = null;
            folder_page.thumbnail = null;
            folder_page.loaded = false;
        }

        const has_placeholder = page_data.page_element?.querySelector('.doc-reader-page-placeholder');
        if (page_data.page_element && !has_placeholder) {
            const placeholder = document.createElement('div');
            placeholder.className = 'doc-reader-page-placeholder';
            placeholder.textContent = `第 ${page_data.page_num} 页`;
            page_data.page_element.appendChild(placeholder);
        }
    }

    _get_page_base_width() {
        if (!this._scroll_container) return 800;
        return Math.max(200, this._scroll_container.clientWidth - 32);
    }

    _refresh_page_aspect(page_data) {
        if (!page_data?.page_width || !page_data.page_height) return;
        page_data.aspect_ratio = page_data.page_width / page_data.page_height;
    }

    _get_page_aspect(page_data) {
        const ratio = page_data?.aspect_ratio;
        return (ratio && ratio > 0 && isFinite(ratio)) ? ratio : 0.70710678;
    }

    _set_page_box_size(page_data, width) {
        if (!page_data?.page_element) return;
        const safe_w = Math.max(200, Math.round(width));
        const aspect = this._get_page_aspect(page_data);
        const safe_h = Math.max(200, Math.round(safe_w / aspect));

        page_data.page_element.style.width = safe_w + 'px';
        page_data.page_element.style.height = safe_h + 'px';

        // 页面尺寸变更影响所有后续页面的 offsetTop，标记缓存脏
        this._invalidate_page_positions();

        const img = page_data._img_el;
        if (img) {
            img.style.width = '100%';
            img.style.height = '100%';
        }

        if (page_data.pdf_canvas) {
            page_data.pdf_canvas.style.width = '100%';
            page_data.pdf_canvas.style.height = '100%';
        }

        const tiles_container = page_data._tiles_container;
        if (tiles_container) {
            tiles_container.style.width = safe_w + 'px';
            tiles_container.style.height = safe_h + 'px';
        }
    }

    // ====== 窗口/容器尺寸响应 ======
    //
    // ResizeObserver 观测 #docReaderScrollContainer（窗口拖拽/最大化/贴靠、面板
    // 显隐、筛选栏换行等所有几何变化来源统一覆盖），拆成双通道：
    //  - 轻量通道（rAF 合帧）：失效几何缓存 + _dr_apply_scale 幂等校正，
    //    拖拽中的每一帧都保持页面不错位（纯数学计算，不触发布局）。
    //  - 重量通道（180ms 防抖）：overlay canvas 重分配 + 全量重布局（页盒尺寸、
    //    批注坐标缩放、tile 重建）。拖动期间反复重分配全屏 GPU 纹理会卡死
    //    （历史问题），且动画中间尺寸上的重算结果必然被下一帧推翻，故延后到
    //    尺寸稳定后一次完成。
    // 阅读器关闭期间的窗口 resize 无观测在跑（close 断开观测器），由此产生的
    // 几何偏差在下次 open 时由 _last_resize_base_w = -1 强制全量重布局对齐。

    _setup_container_resize_observer() {
        this._teardown_container_resize_observer();
        if (!this._scroll_container) return;
        if (typeof ResizeObserver !== 'undefined') {
            this._container_resize_observer = new ResizeObserver(() => {
                if (!this.is_open) return;
                // observe() 的首次回调报告的是当前尺寸：与上次重布局基准一致时
                // （正常重开场景）直接跳过，避免打开流程中被插入冗余重布局；
                // 尺寸确实变化（如关闭期间窗口被调整）则照常进入响应管线
                if (this._get_page_base_width() === this._last_resize_base_w
                    && this._scroll_container.clientHeight === this._last_resize_container_h) return;
                this._on_reader_geometry_changed();
            });
            this._container_resize_observer.observe(this._scroll_container);
        } else {
            // 极旧 WebView 回退：window resize 事件近似覆盖
            this._legacy_resize_handler = () => {
                if (this.is_open) this._on_reader_geometry_changed();
            };
            window.addEventListener('resize', this._legacy_resize_handler);
        }
    }

    _teardown_container_resize_observer() {
        if (this._container_resize_observer) {
            try { this._container_resize_observer.disconnect(); } catch (_) {}
            this._container_resize_observer = null;
        }
        if (this._legacy_resize_handler) {
            window.removeEventListener('resize', this._legacy_resize_handler);
            this._legacy_resize_handler = null;
        }
        if (this._resize_light_raf !== null) {
            cancelAnimationFrame(this._resize_light_raf);
            this._resize_light_raf = null;
        }
        if (this._resize_heavy_timer !== null) {
            clearTimeout(this._resize_heavy_timer);
            this._resize_heavy_timer = null;
        }
        if (this._resize_retry_timer !== null) {
            clearTimeout(this._resize_retry_timer);
            this._resize_retry_timer = null;
        }
    }

    _on_reader_geometry_changed() {
        // 轻量通道：每帧最多一次，拖拽/动画期间保持视觉正确
        if (this._resize_light_raf === null) {
            this._resize_light_raf = requestAnimationFrame(() => {
                this._resize_light_raf = null;
                if (!this.is_open) return;
                this._cached_container_rect = null;
                if (this._page_positions) this._page_positions.stale = true;
                this._dr_apply_scale();
            });
        }
        // 重量通道：防抖到尺寸稳定后全量重布局
        if (this._resize_heavy_timer !== null) clearTimeout(this._resize_heavy_timer);
        this._resize_heavy_timer = setTimeout(() => {
            this._resize_heavy_timer = null;
            this._run_heavy_reader_resize();
        }, 180);
    }

    _run_heavy_reader_resize() {
        if (!this.is_open) return;
        // 最小化/最大化过渡（~300ms 动画）期间尺寸是中间态，跳过并延后重试，
        // 过渡结束后（_windowTransitioning 复位）必定补一次重布局
        if (window.main_is_window_transitioning?.()) {
            if (this._resize_retry_timer !== null) clearTimeout(this._resize_retry_timer);
            this._resize_retry_timer = setTimeout(() => {
                this._resize_retry_timer = null;
                this._run_heavy_reader_resize();
            }, 250);
            return;
        }
        this._sync_reader_overlay_size();
        this._handle_reader_resize();
    }

    _sync_reader_overlay_size() {
        if (!this.batch_draw?._overlayCanvas) return;
        const overlay = this.batch_draw._overlayCanvas;
        const overlay_dpr = this.batch_draw._calc_overlay_dpr(this.dr_scale || 1);
        this.batch_draw._overlayDpr = overlay_dpr;
        const target_w = Math.ceil(window.innerWidth * overlay_dpr);
        const target_h = Math.ceil(window.innerHeight * overlay_dpr);
        if (overlay.width !== target_w || overlay.height !== target_h) {
            overlay.width = target_w;
            overlay.height = target_h;
            overlay.style.width = window.innerWidth + 'px';
            overlay.style.height = window.innerHeight + 'px';
        }
    }

    _handle_reader_resize() {
        if (!this.is_open || !this._zoom_wrapper || !this._scroll_container) return;
        // 过渡期守卫由调用方 _run_heavy_reader_resize 负责（含延后重试），
        // 此处仅做纯粹的布局对齐

        const new_w = this._get_page_base_width();
        const new_h = this._scroll_container.clientHeight;

        // 宽高均未变化时无需任何重布局（open 后的强制对齐/动画校正常为此情形）
        if (new_w === this._last_resize_base_w && new_h === this._last_resize_container_h) {
            this._cached_container_rect = null;
            this._dr_apply_scale();
            return;
        }

        // 宽度不变（仅高度变化）不影响页面布局：移动边界与可见域随视口更新即可
        if (new_w === this._last_resize_base_w) {
            this._last_resize_container_h = new_h;
            this._cached_container_rect = null;
            this._dr_apply_scale();
            return;
        }
        this._last_resize_base_w = new_w;
        this._last_resize_container_h = new_h;

        const active = this.page_manager.pages_list[this.active_page_index]
            || this.page_manager.get_current_page();
        const active_offset = active?.page_element
            ? active.page_element.offsetTop * this.dr_scale + this.dr_canvas_y
            : null;

        const pages = this.page_manager.pages_list;

        // ① 全部页统一更新 DOM box 尺寸（纯 style 赋值，单次 O(n) 遍历，不触发布局）
        //    不覆盖 coord_width/coord_height —— 留给 _resize_page_layout 判断尺寸变化
        for (let i = 0; i < pages.length; i++) {
            const pd = pages[i];
            if (!pd?.page_element) continue;
            this._set_page_box_size(pd, new_w);
        }

        // ② 仅对已有 tile 的页执行完整 resize（含注解缩放 + tile 重建 + 重绘）。
        //    bulk=true：跳过每页的全文档布局重算，避免 O(n²) 卡死，布局在 ③ 仅重算一次。
        //    必须遍历快照：_resize_page_layout 内部 destroy(delete)+init(add) 会改写
        //    _pages_with_tiles 本身，对 Set 边删边加会让元素回到迭代末尾被再次访问
        //    （经典 Set 死循环，打开文档即冻结）
        for (const i of [...this._pages_with_tiles]) {
            this._resize_page_layout(i, new_w, true);
        }

        // ③ 虚拟化：所有页尺寸更新后，全文档布局（绝对坐标/总高度）仅重算一次 O(n)，保证滚动锚点正确
        if (this._dom_virtualize()) {
            this._compute_page_layout();
            this._apply_page_positions();
        }

        // ④ 以活动页为锚点修正滚动偏移（必须依赖 ③ 之后的新 offsetTop）
        if (active?.page_element && active_offset !== null) {
            this.dr_canvas_y = active_offset - active.page_element.offsetTop * this.dr_scale;
        }

        // 容器 rect 缓存失效，下次 _check_page_visibility 重新获取
        this._cached_container_rect = null;

        this._dr_apply_scale();
    }

    /**
     * 单页布局重算——页大小的唯一权威入口。
     *
     * 尺寸模型（三个坐标系，职责分明）：
     *  - 页盒 style.width/height：视觉尺寸 = 基准宽 ÷ 当前最佳宽高比，由本函数现算；
     *  - coord_width/height：批注坐标系基准，只在 tile 真正初始化时确立，
     *    刻意滞后于页盒——与新页盒的差值就是批注的一次性补偿比例；
     *  - aspect_ratio/page_width/page_height：文档数据，渲染完成/后台回填时更新。
     *
     * 关键约束：盒高必须用当前 aspect_ratio 现算，禁止回读 style.height——
     * style 是上一次应用的产物，比例更新后回读会把过期值当成目标，触发
     * "无变化"提前返回，页盒永久停留旧比例（resize 后部分页面长宽错误的根源）。
     */
    _resize_page_layout(page_index, new_w, bulk = false) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?.page_element) return;

        // 权威现算：与 _set_page_box_size 内部公式逐字一致（含 200 下限），
        // 保证 box_ok 判定与应用结果零偏差
        const safe_w = Math.max(200, Math.round(new_w));
        const new_h = Math.max(200, Math.round(safe_w / this._get_page_aspect(page_data)));

        const el = page_data.page_element;
        const cur_style_w = Math.round(parseFloat(el.style.width)) || 0;
        const cur_style_h = Math.round(parseFloat(el.style.height)) || 0;
        const box_ok = cur_style_w === safe_w && cur_style_h === new_h;

        // 批注坐标系旧基准：未初始化过 tile 的页为 0，此时 style 值不代表
        // 坐标基准（没有批注需要补偿），禁止把 style 当作 old 值参与缩放
        const old_w = page_data.coord_width || 0;
        const old_h = page_data.coord_height || 0;
        const coords_ok = old_w === safe_w && old_h === new_h;

        // 应用新盒尺寸（幂等；比例修正也随这次写入完成）
        this._set_page_box_size(page_data, safe_w);

        if (!coords_ok && old_w > 0 && old_h > 0) {
            this._scale_page_annotations(page_data, safe_w / old_w, new_h / old_h);
        }
        page_data.coord_width = safe_w;
        page_data.coord_height = new_h;

        // 盒尺寸与批注坐标基准均已对齐：无需销毁/重建 tile 或重渲染 PDF 背景
        // （open() 末尾的强制对齐/重复可见性扫描常为此情形，属幂等空操作）
        if (box_ok && coords_ok) return;

        // 旧 tile 始终销毁（轻量 CPU 清理），但仅对可见/附近页重建新 tile（避免 GPU 纹理无效分配）
        if (page_data.is_tiles_initialized) {
            this._destroy_page_tiles(page_index);
        }
        if (page_data.is_visible || this._is_page_near_active(page_index, this._tile_keep_distance)) {
            this._init_page_tiles(page_index);
            if (page_data.render_mode === 'pdfjs' && page_data.is_visible) {
                this._render_pdf_page_direct(page_index, true);
            }
            this._update_overlay_size(page_index);
        }

        // 虚拟化：单页尺寸变化后（图片加载/宽高比变化）重算绝对坐标，
        // 否则后续页 top 不平移会重叠/错位（flex 流原本自动完成，绝对定位需手动）。
        // bulk 模式由 _handle_reader_resize 在全部页更新后统一重算一次，避免 O(n²)
        if (!bulk && this._dom_virtualize()) {
            this._compute_page_layout();
            this._apply_page_positions();
        }
    }

    _scale_page_annotations(page_data, sx, sy) {
        if (!page_data || sx === 1 && sy === 1) return;
        const page_index = page_data.index;
        this._dr_diag('scale', {
            page: page_index + 1,
            sx: +sx.toFixed(3),
            sy: +sy.toFixed(3),
            hist: page_data.stroke_history.length
        });
        // 单次调用内去重：同一 stroke 对象会同时出现在页面历史与全局命令栈中，
        // 只能缩放一次。注意不能用跨调用持久的 WeakSet——
        // 一旦某次调用部分应用（如旧版会把其他页的命令也缩放），错误会被永久锁死无法纠正
        const seen = new Set();
        const scale_stroke = (stroke) => {
            if (!stroke || seen.has(stroke)) return;
            seen.add(stroke);
            const sw = (sx + sy) / 2;
            if (Array.isArray(stroke.points)) {
                for (const p of stroke.points) {
                    if (typeof p.fromX === 'number') p.fromX *= sx;
                    if (typeof p.toX === 'number') p.toX *= sx;
                    if (typeof p.fromY === 'number') p.fromY *= sy;
                    if (typeof p.toY === 'number') p.toY *= sy;
                }
            }
            if (stroke.bounds) {
                if (typeof stroke.bounds.minX === 'number') stroke.bounds.minX *= sx;
                if (typeof stroke.bounds.maxX === 'number') stroke.bounds.maxX *= sx;
                if (typeof stroke.bounds.minY === 'number') stroke.bounds.minY *= sy;
                if (typeof stroke.bounds.maxY === 'number') stroke.bounds.maxY *= sy;
            }
            if (typeof stroke.lineWidth === 'number') stroke.lineWidth *= sw;
            if (typeof stroke.eraserSize === 'number') stroke.eraserSize *= sw;
            if (typeof stroke.eraserSizeRaw === 'number') stroke.eraserSizeRaw *= sw;
            if (Array.isArray(stroke.storedWidths)) {
                stroke.storedWidths = stroke.storedWidths.map(w => typeof w === 'number' ? w * sw : w);
            }
        };
        const scale_command = (cmd) => {
            if (!cmd) return;
            // 仅处理属于当前缩放页的命令。全局 undo/redo 栈跨页共享，
            // 其他页的笔画坐标基准未变，必须由其自身页面的 resize 流程负责，
            // 否则会把别的页笔画缩放错（翻回该页时批注错位/越界不可见）
            if (typeof cmd.page_index === 'number' && cmd.page_index !== page_index) return;
            scale_stroke(cmd.stroke);
            if (Array.isArray(cmd.savedStrokeHistory)) cmd.savedStrokeHistory.forEach(scale_stroke);
            if (Array.isArray(cmd.beforeStrokes)) cmd.beforeStrokes.forEach(scale_stroke);
            if (Array.isArray(cmd.afterStrokes)) cmd.afterStrokes.forEach(scale_stroke);
        };

        page_data.stroke_history.forEach(scale_stroke);

        history_state.undo_list.forEach(scale_command);
        history_state.redo_list.forEach(scale_command);
    }

    /** 确保页面 tile 已初始化（延迟创建的页面在首次绘制前调用） */
    _ensure_page_tiles(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?._tiles_deferred) return;
        page_data._tiles_deferred = false;
        page_data.is_tiles_initialized = false;
        page_data._tiles_force = true;
        this._init_page_tiles(page_index);
        page_data._tiles_force = false;
    }

    _init_page_tiles(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data || page_data.is_tiles_initialized) return;

        // 无批注时延迟创建 tile（节省 GPU 显存和 DOM 节点），首次落笔时真正初始化。
        // 但缓存尚未恢复时禁止该判定：二次打开时可见性检查可能早于缓存 IPC 完成，
        // 若此时把"批注暂为空"的页面标记为 deferred+initialized，
        // 后续所有初始化入口（_on_page_visible/inputDown 门控）都会被
        // is_tiles_initialized=true 挡住，已恢复的批注将永远不可见（只能靠落笔解锁）
        if (page_data.stroke_history.length === 0 && !page_data._tiles_force) {
            if (!this._cache_ready) return;
            page_data.is_tiles_initialized = true;
            page_data._tiles_deferred = true;
            return;
        }

        const tiles_container = page_data._tiles_container;
        if (!tiles_container) return;

        // tile 坐标系使用页面的 CSS 宽度（固定基准，wrapper transform 负责缩放）
        const page_el = page_data.page_element;
        const tile_w = Math.round(parseFloat(page_el.style.width) || page_el.clientWidth || 800);
        const tile_h = Math.round(parseFloat(page_el.style.height) || page_el.clientHeight || (tile_w / this._get_page_aspect(page_data)));

        tiles_container.style.width = tile_w + 'px';
        tiles_container.style.height = tile_h + 'px';
        page_data.coord_width = tile_w;
        page_data.coord_height = tile_h;

        const tile_renderer = new TileRenderer({
            canvasW: tile_w,
            canvasH: tile_h,
            strokeHistoryRef: page_data.stroke_history,
            getVisibleRect: () => this._get_page_visible_rect(page_index),
            skipBaseCache: true
        });

        tile_renderer.init_tiles(tiles_container, this.dr_scale || 1);
        page_data.tile_renderer = tile_renderer;
        page_data.is_tiles_initialized = true;
        this._pages_with_tiles.add(page_index);

        // 注入 tile 层诊断钩子（localStorage.drDiag=1 时启用详细日志）
        if (this._diag_verbose === undefined) {
            try { this._diag_verbose = localStorage.getItem('drDiag') === '1'; } catch (_) { this._diag_verbose = false; }
        }
        if (this._diag_verbose) {
            tile_renderer.diag_hook = (e, d) => this._dr_diag('tr-' + e, d);
        }

        // 当前活动页的 tile 就绪后立即接上 batch_draw，
        // 避免落笔/擦除期间引用悬空（延迟创建场景下此前为 null）
        if (this.batch_draw && page_index === this.active_page_index) {
            this.batch_draw._tileRenderer = tile_renderer;
        }

        // 初始化 batch_draw（如果还没有初始化）
        if (!this.batch_draw) {
            this._init_batch_draw();
        }

        this._render_page_strokes(page_index);
    }

    _init_batch_draw() {
        // 创建覆盖层用于实时预览（固定在视口中央，不跟随滚动）
        const overlay_canvas = document.createElement('canvas');
        overlay_canvas.className = 'doc-reader-overlay-global';
        overlay_canvas.style.position = 'fixed';
        overlay_canvas.style.top = '0';
        overlay_canvas.style.left = '0';
        overlay_canvas.style.pointerEvents = 'none';
        overlay_canvas.style.zIndex = '100';

        // 先创建 batch_draw 实例，复用 DPR 计算逻辑
        this.batch_draw = new window.RealtimeBatchDrawManager();
        // 阅读器为多页架构：_tileRenderer 必须始终指向当前页的渲染器，
        // 禁止回退到主画布渲染器（否则擦除会误伤主画布/其他页笔迹）
        this.batch_draw.fallbackToMain = false;
        const init_overlay_dpr = this.batch_draw._calc_overlay_dpr(this.dr_scale || 1);

        // 设置初始尺寸为视口大小（含 DPR，确保清晰）
        overlay_canvas.width = Math.ceil(window.innerWidth * init_overlay_dpr);
        overlay_canvas.height = Math.ceil(window.innerHeight * init_overlay_dpr);
        overlay_canvas.style.width = window.innerWidth + 'px';
        overlay_canvas.style.height = window.innerHeight + 'px';

        document.body.appendChild(overlay_canvas);

        const overlay_ctx = overlay_canvas.getContext('2d');
        overlay_ctx.imageSmoothingEnabled = false;

        // 初始化 batch_draw
        this.batch_draw._overlayDpr = init_overlay_dpr;
        this.batch_draw._overlayCanvas = overlay_canvas;
        this.batch_draw._overlayCtx = overlay_ctx;
        this.batch_draw._overlayTransformScale = 0;
        this.batch_draw._overlayTransformX = 0;
        this.batch_draw._overlayTransformY = 0;
        this.batch_draw._overlay_cached_rect_left = null;
        this.batch_draw._overlay_cached_rect_top = null;
        // 预览层变换以"当前页内容原点的实时屏幕位置"为锚（页面 rect），
        // 自动包含滚动、缩放与容器偏移；随 active 页切换自动跟随
        this.batch_draw.set_transform_provider(() => {
            const page_data = this.page_manager.pages_list[this.active_page_index];
            const r = page_data?.page_element?.getBoundingClientRect();
            return {
                scale: this.dr_scale || 1,
                originX: r ? r.left : 0,
                originY: r ? r.top : 0
            };
        });

        if (window.DRAW_CONFIG.frameRateMode) {
            this.batch_draw.batch_draw_update_frame_rate(window.DRAW_CONFIG.frameRateMode);
        }
    }

    _destroy_page_tiles(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data) return;

        if (page_data.tile_renderer) {
            // 显式清空每个 tile canvas 的 context，释放 GPU 纹理
            for (const info of page_data.tile_renderer.tileInfos || []) {
                if (info.ctx) {
                    info.ctx.clearRect(0, 0, info.canvas?.width || 0, info.canvas?.height || 0);
                }
                if (info.canvas) {
                    info.canvas.width = 0;
                    info.canvas.height = 0;
                }
            }
            page_data.tile_renderer.destroy();
            page_data.tile_renderer = null;
        }

        // 清理历史版本可能已创建的 per-page overlay canvas，避免滚动大量页面后驻留纹理
        if (page_data.overlay_canvas) {
            const ctx = page_data.overlay_canvas.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, page_data.overlay_canvas.width, page_data.overlay_canvas.height);
            }
            page_data.overlay_canvas.width = 0;
            page_data.overlay_canvas.height = 0;
            if (page_data.overlay_canvas.parentNode) {
                page_data.overlay_canvas.parentNode.removeChild(page_data.overlay_canvas);
            }
        }
        page_data.overlay_canvas = null;
        page_data.overlay_ctx = null;
        page_data._overlay_cached_w = 0;
        page_data._overlay_cached_h = 0;

        const tiles_container = page_data._tiles_container;
        if (tiles_container) tiles_container.innerHTML = '';
        page_data.is_tiles_initialized = false;
        this._pages_with_tiles.delete(page_index);
        this._dr_diag('destroy', { page: page_index + 1, hist: page_data.stroke_history.length });
    }

    _destroy_all_tiles() {
        for (let i = 0; i < this.page_manager.pages_list.length; i++) {
            this._destroy_page_tiles(i);
        }
    }

    /** 刷新容器矩形缓存（可见性判定与 tile 可见键共用的唯一入口） */
    _ensure_container_rect() {
        const cr = this._scroll_container?.getBoundingClientRect();
        const wr = this._zoom_wrapper?.getBoundingClientRect();
        this._cached_container_rect = cr ? { top: cr.top, bottom: cr.bottom, left: cr.left, right: cr.right, wrapperTop: wr?.top ?? 0 } : null;
        this._dr_transform_changed = false;
    }

    _get_page_visible_rect(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?.page_element) {
            return { x: 0, y: 0, width: page_data?.page_width || 800, height: page_data?.page_height || 600 };
        }
        const rect = page_data.page_element.getBoundingClientRect();
        // 复用 _check_page_visibility 的容器缓存，避免每页强制 layout。
        // transform 变更（缩放/平移）后必须刷新：过期矩形会让 DPR 重建算出
        // 错误的可见 tile 键集合，导致真正可见的 tile 得不到重建而空白
        if (this._dr_transform_changed || !this._cached_container_rect) {
            this._ensure_container_rect();
        }
        const container_rect = this._cached_container_rect;
        if (!container_rect) {
            return { x: 0, y: 0, width: rect.width, height: rect.height };
        }

        const visible_left = Math.max(0, container_rect.left - rect.left);
        const visible_top = Math.max(0, container_rect.top - rect.top);
        const visible_right = Math.min(rect.width, container_rect.right - rect.left);
        const visible_bottom = Math.min(rect.height, container_rect.bottom - rect.top);

        // 几何异常兜底：面板滑入动画中间态/缓存与新测量错位时交集可能为空，
        // 若照实返回空矩形，瓦片会被"清空后不回填"（批注空白、动态 DPR 失效）。
        // 此时按整页处理：宁可多渲染，绝不空白。
        if (!(visible_right > visible_left && visible_bottom > visible_top)) {
            const w = rect.width > 0 ? rect.width : (page_data.coord_width || 800);
            const h = rect.height > 0 ? rect.height : Math.round(w / this._get_page_aspect(page_data));
            return { x: 0, y: 0, width: w, height: h };
        }

        const inv = this.dr_cached_inv_scale || 1;

        return {
            x: visible_left * inv,
            y: visible_top * inv,
            width: (visible_right - visible_left) * inv,
            height: (visible_bottom - visible_top) * inv
        };
    }

    _update_overlay_size(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?.overlay_canvas || !page_data.page_element) return;

        const rect = page_data.page_element.getBoundingClientRect();
        const w = Math.ceil(rect.width);
        const h = Math.ceil(rect.height);

        // 缓存尺寸，避免重复 resize 触发 GPU 纹理重建
        if (page_data._overlay_cached_w === w && page_data._overlay_cached_h === h) return;
        page_data._overlay_cached_w = w;
        page_data._overlay_cached_h = h;

        // overlay 仅用于实时预览，DPR=1 足够，节省 GPU 显存
        page_data.overlay_canvas.width = w;
        page_data.overlay_canvas.height = h;
        page_data.overlay_canvas.style.width = w + 'px';
        page_data.overlay_canvas.style.height = h + 'px';
        page_data.overlay_ctx.imageSmoothingEnabled = false;
    }

    // ====== 批注渲染 ======

    _render_page_strokes(page_index) {
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data?.tile_renderer) return;

        page_data.tile_renderer._strokeHistoryRef = page_data.stroke_history;

        // 无笔画时跳过全量重建，减少 GPU 开销（skipBaseCache=true 时 tiles 只有笔画内容）
        if (page_data.stroke_history.length === 0) {
            return;
        }

        this._dr_diag('rerender', { page: page_index + 1, hist: page_data.stroke_history.length });
        page_data.tile_renderer.mark_strokes_changed();
        page_data.tile_renderer.mark_all();
        page_data.tile_renderer.rebuild_all();
        // 像素探针：确认恢复的批注确实落到 tile
        this._dr_diag('probe-render', {
            page: page_index + 1,
            ...page_data.tile_renderer.diag_content_ratio()
        });
    }

    async _render_all_strokes(bounds) {
        const page = this.page_manager.get_current_page();
        if (!page || !page.tile_renderer) return;

        const orig_scale = window.state?.scale;
        if (window.state) window.state.scale = this.dr_scale;

        window.main_reset_context_state?.();
        page.tile_renderer._strokeHistoryRef = page.stroke_history;
        page.tile_renderer.mark_strokes_changed();

        // 优先只重建脏区域涉及的 tiles
        if (bounds && isFinite(bounds.minX) && isFinite(bounds.minY) &&
            isFinite(bounds.maxX) && isFinite(bounds.maxY)) {
            const infos = page.tile_renderer.infos_for_segment(
                bounds.minX, bounds.minY, bounds.maxX, bounds.maxY
            );
            for (const info of infos) {
                page.tile_renderer.dirty.add(info.key);
            }
        } else {
            page.tile_renderer.mark_all();
        }

        try {
            page.tile_renderer.rebuild_all();
        } finally {
            if (window.state) window.state.scale = orig_scale;
        }
    }

    // ====== 绘制事件 ======

    _setup_events() {
        if (!this._scroll_container) return;

        const input = new InputSource(this._scroll_container);
        this._input_source = input;
        input.attach();

        // ====== 输入事件（绘制、手掌擦除、拖拽平移） ======
        input.on('inputDown', async (ev) => {
            if (!this.is_open) return;
            this._dr_cancel_momentum();

            // 起笔即收纳笔工具面板（选色框/橡皮框）：
            // pointerdown 被 preventDefault 后不产生兼容 mousedown，
            // 面板的"点击外部关闭"在触屏/手写笔下不会触发
            window.main_hide_pen_control_panel?.();

            // 缩放中不处理任何状态切换，直到手势结束重置
            if (this.dr_is_scaling) return;

            // 非第一指不处理（后续手指留给 PinchZoomSourceV2）
            if (input.activeCount > 1) return;

            // 页面选择
            const target = ev.originEvent?.target?.closest?.('.doc-reader-page');
            if (!target) return;
            const page_index = parseInt(target.dataset.page);
            if (isNaN(page_index)) return;

            const page_data = this.page_manager.pages_list[page_index];
            if (!page_data?.is_tiles_initialized) {
                this._on_page_visible(page_index);
            }

            this.active_page_index = page_index;
            this.page_manager.switch_page(page_index);

            this._update_page_indicator();
            this._sync_page_buttons();

            // 拖拽平移（move 模式）
            if (this.draw_mode === 'move') {
                this.dr_is_dragging = true;
                this._dragFingerId = ev.id;
                this.dr_start_drag_x = ev.position.x - this.dr_canvas_x;
                this.dr_start_drag_y = ev.position.y - this.dr_canvas_y;
                this._dr_last_canvas_x = this.dr_canvas_x;
                this._dr_last_canvas_y = this.dr_canvas_y;
                this._dr_gesture_vx = 0;
                this._dr_gesture_vy = 0;
                this._dr_enable_smooth_transform();
                return;
            }

            // 批注 / 擦除模式
            if (this.draw_mode === 'comment' || this.draw_mode === 'eraser') {
                this.is_drawing = true;
                if (this._scroll_container) {
                    this._scroll_container.style.touchAction = 'none';
                }
                const rect = target.getBoundingClientRect();
                this.draw_canvas_rect = rect;
                const inv = this.dr_cached_inv_scale;
                this.last_x = (ev.position.x - rect.left) * inv;
                this.last_y = (ev.position.y - rect.top) * inv;
                this._ensure_page_tiles(this.active_page_index);
                // tile 就绪后再绑定（延迟创建的页此时才有 tile_renderer）
                if (this.batch_draw) {
                    this.batch_draw._tileRenderer = page_data.tile_renderer || null;
                }
                this._start_stroke(this.draw_mode === 'comment' ? 'draw' : 'erase');
                if (this.draw_mode === 'eraser') {
                    this._show_eraser_hint();
                    this._update_eraser_hint_position(ev.position.x, ev.position.y);
                }
            }
        });

        input.on('inputMove', async (ev) => {
            if (!this.is_open) return;

            // 拖拽平移
            if (this.dr_is_dragging) {
                // 缩放进行中：拖拽与缩放锚点冲突，完全交由 pinch 处理位置
                if (this.dr_is_scaling) return;

                this.dr_canvas_x = ev.position.x - this.dr_start_drag_x;
                this.dr_canvas_y = ev.position.y - this.dr_start_drag_y;
                this._dr_update_canvas_position();
                this._dr_update_gesture_velocity();
                // 脏检查 + rAF 节流
                if (this._dr_last_transform.x !== this.dr_canvas_x ||
                    this._dr_last_transform.y !== this.dr_canvas_y ||
                    this._dr_last_transform.scale !== this.dr_scale) {
                    this._dr_sync_transform_schedule(this.dr_canvas_x, this.dr_canvas_y, this.dr_scale);
                }
                return;
            }

            if (!this.is_drawing || this.active_page_index < 0) return;

            this.current_pressure = ev.originEvent?.pressure || 0.5;

            if (this.draw_mode === 'eraser') {
                this._update_eraser_hint_position(ev.position.x, ev.position.y);
            }

            const page_data = this.page_manager.pages_list[this.active_page_index];
            if (!page_data?.page_element) return;

            const rect = this.draw_canvas_rect || page_data.page_element.getBoundingClientRect();
            const inv = this.dr_cached_inv_scale;
            // 用缓存的 rect 做边界检测，避免 elementFromPoint 触发 hit-test
            const px = ev.position.x, py = ev.position.y;
            if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) {
                this.is_drawing = false;
                this.draw_canvas_rect = null;
                await this._submit_stroke();
                return;
            }
            const x = (ev.position.x - rect.left) * inv;
            const y = (ev.position.y - rect.top) * inv;
            const dx = x - this.last_x;
            const dy = y - this.last_y;

            if (dx * dx + dy * dy > 1) {
                this._save_stroke_point(this.last_x, this.last_y, x, y, this.current_pressure);
                if (this.batch_draw) {
                    // draw 仅绘制到 overlay，无需 tile_renderer；erase 仍需 tile 命中计算
                    if (this.cached_draw_type === 'draw' || page_data.tile_renderer) {
                    this.batch_draw.batch_draw_create_command(
                        this.cached_draw_type, this.last_x, this.last_y, x, y,
                        this.cached_draw_color, this.cached_draw_line_width
                    );
                }
                }
                this.last_x = x;
                this.last_y = y;
            }
        });

        input.on('inputUp', async (ev) => {
            if (this.dr_is_dragging) {
                // 缩放进行中：拖拽位置已不准确，跳过 momentum 避免抖动
                if (this.dr_is_scaling) {
                    this.dr_is_dragging = false;
                    this._dr_schedule_disable_smooth_transform();
                    return;
                }
                this.dr_is_dragging = false;
                if (this.draw_mode === 'move' && (Math.abs(this._dr_gesture_vx) > 2 || Math.abs(this._dr_gesture_vy) > 2)) {
                    this._dr_update_move_bound();
                    this._dr_update_canvas_position();
                    this._dr_start_momentum();
                } else {
                    this._dr_schedule_disable_smooth_transform();
                    this._check_page_visibility();
                }
                return;
            }

            if (!this.is_drawing) return;
            this.is_drawing = false;
            this.draw_canvas_rect = null;
            if (this.draw_mode === 'eraser') this._hide_eraser_hint();
            await this._submit_stroke();
        });

        // ====== 两指捏合缩放（V2 增量式算法，中点锚点） ======
        const pinch = new PinchZoomSourceV2(input);
        this._pinch_source = pinch;
        pinch.startDelayMs = (this.draw_mode !== 'move') ? 200 : 0;

        pinch.onPinchStarted = () => {
            if (!this.is_open) return;

            this._dr_cancel_momentum();
            this._dr_last_canvas_x = this.dr_canvas_x;
            this._dr_last_canvas_y = this.dr_canvas_y;
            this._dr_gesture_vx = 0;
            this._dr_gesture_vy = 0;

            // 取消当前笔画
            if (this.is_drawing) {
                this.is_drawing = false;
                this.draw_canvas_rect = null;
                this._submit_stroke();
                if (this.batch_draw) {
                    this.batch_draw.batch_draw_delete_all();
                }
            }

            this.dr_is_scaling = true;
            // 不立即杀死拖拽：fingers 可能在 tolerance 阈值内，
            // 让原始拖拽手指继续移动直到收到第一个缩放 delta
            this.dr_start_scale = this.dr_scale;
            this._pinchProcessedFirstDelta = false;

            // 缩放边界阻尼器：消除贴墙时的触控噪声"呼吸"抖动
            this._dr_zoom_damper ??= new ZoomWallDamper();
            this._dr_zoom_damper.reset(this.dr_scale, this.dr_min_scale, this.dr_max_scale);

            // 以两指中点为缩放中心（替代只用 finger0，两指操作更自然）
            const positions = input.getActivePositions();
            if (positions.length >= 2) {
                const midX = (positions[0].x + positions[1].x) / 2;
                const midY = (positions[0].y + positions[1].y) / 2;
                this.dr_start_finger0_cx = (midX - this.dr_canvas_x) / this.dr_scale;
                this.dr_start_finger0_cy = (midY - this.dr_canvas_y) / this.dr_scale;
            }
            this.dr_start_canvas_x = this.dr_canvas_x;
            this.dr_start_canvas_y = this.dr_canvas_y;

            this._dr_enable_smooth_transform();
            this._dr_set_zooming();
        };

        pinch.onPinchDelta = (ev) => {
            if (!this.is_open || !this.dr_is_scaling) return;

            // 收到第一个缩放 delta：结束拖拽，切换到缩放模式
            if (!this._pinchProcessedFirstDelta) {
                this._pinchProcessedFirstDelta = true;
                this.dr_is_dragging = false;
                // 此时手指可能已移动，以当前中点为基准重算缩放中心
                this.dr_start_finger0_cx = (ev.centerX - this.dr_canvas_x) / this.dr_scale;
                this.dr_start_finger0_cy = (ev.centerY - this.dr_canvas_y) / this.dr_scale;
                this.dr_start_scale = this.dr_scale;
            }

            // V2: 增量式缩放（中点锚点）+ 边界阻尼（贴墙吸收噪声，累计越界 2% 才脱离）
            this.dr_scale = this._dr_zoom_damper.update(ev.scale);
            this.dr_cached_inv_scale = 1 / this.dr_scale;
            if (this.batch_draw) {
                this.batch_draw._overlay_cached_rect_left = null;
                this.batch_draw._overlay_cached_rect_top = null;
            }
            this.dr_canvas_x = ev.centerX - this.dr_start_finger0_cx * this.dr_scale;
            this.dr_canvas_y = ev.centerY - this.dr_start_finger0_cy * this.dr_scale;

            // 同步到 window.state（供 batch_draw overlay 变换使用）
            if (window.state) {
                window.state.scale = this.dr_scale;
                window.state.canvasX = this.dr_canvas_x;
                window.state.canvasY = this.dr_canvas_y;
            }

            this._dr_update_move_bound();
            this._dr_update_canvas_position();

            // 弹性 overscroll（仅显示层）
            const mb = this.dr_move_bound;
            this._dr_is_overscrolling = false;
            let display_x = this.dr_canvas_x;
            let display_y = this.dr_canvas_y;

            if (this.dr_canvas_x < mb.min_x) {
                display_x = mb.min_x + (this.dr_canvas_x - mb.min_x) * 0.3;
                this._dr_is_overscrolling = true;
            } else if (this.dr_canvas_x > mb.max_x) {
                display_x = mb.max_x + (this.dr_canvas_x - mb.max_x) * 0.3;
                this._dr_is_overscrolling = true;
            }

            if (this.dr_canvas_y < mb.min_y) {
                display_y = mb.min_y + (this.dr_canvas_y - mb.min_y) * 0.3;
                this._dr_is_overscrolling = true;
            } else if (this.dr_canvas_y > mb.max_y) {
                display_y = mb.max_y + (this.dr_canvas_y - mb.max_y) * 0.3;
                this._dr_is_overscrolling = true;
            }

            if (this._dr_is_overscrolling) {
                this._dr_overscroll_display_x = display_x;
                this._dr_overscroll_display_y = display_y;
            }

            this._dr_set_zooming();
            this._dr_update_gesture_velocity();

            // rAF 节流更新 transform（缩放中跳过 tile/overlay，仅写 DOM）
            this._dr_sync_transform_schedule(display_x, display_y, this.dr_scale);
        };

        pinch.onPinchCompleted = () => {
            if (!this.is_open) return;
            this.dr_is_scaling = false;
            this._dr_cancel_zoom_debounce();

            // 没有处理过缩放 delta（误触或两指平移刚过 tolerance 但未缩放）
            // 拖拽状态未丢失，无需额外处理
            if (!this._pinchProcessedFirstDelta) {
                this._pinchProcessedFirstDelta = false;
                this._dragFingerId = null;
                // 缩放结束后：如果剩一指且在 move 模式，继续拖拽
                if (input.activeCount === 1 && this.draw_mode === 'move') {
                    const ev = input.activeEvents[0];
                    if (ev) {
                        this.dr_is_dragging = true;
                        this.dr_start_drag_x = ev.position.x - this.dr_canvas_x;
                        this.dr_start_drag_y = ev.position.y - this.dr_canvas_y;
                    }
                }
                return;
            }
            this._pinchProcessedFirstDelta = false;

            // 缩放结束后：如果剩一指且在 move 模式，继续拖拽
            if (input.activeCount === 1 && this.draw_mode === 'move') {
                const ev = input.activeEvents[0];
                if (ev) {
                    this.dr_is_dragging = true;
                    this.dr_start_drag_x = ev.position.x - this.dr_canvas_x;
                    this.dr_start_drag_y = ev.position.y - this.dr_canvas_y;
                }
            } else if (input.activeCount === 0) {
                if (this._dr_is_overscrolling) {
                    this._dr_is_overscrolling = false;
                    const mb = this.dr_move_bound;
                    const snap_x = Math.max(mb.min_x, Math.min(mb.max_x, this._dr_overscroll_display_x));
                    const snap_y = Math.max(mb.min_y, Math.min(mb.max_y, this._dr_overscroll_display_y));
                    this.dr_canvas_x = snap_x;
                    this.dr_canvas_y = snap_y;
                    if (this._zoom_wrapper) {
                        this._zoom_wrapper.style.transitionDuration = '250ms';
                        this._zoom_wrapper.classList.add('smooth-transform');
                    }
                    this._dr_apply_scale();
                    if (this._zoom_wrapper) {
                        setTimeout(() => {
                            this._zoom_wrapper.classList.remove('smooth-transform');
                            this._zoom_wrapper.style.transitionDuration = '';
                        }, 250);
                    }
                    this._dr_schedule_disable_smooth_transform();
                } else if (Math.abs(this._dr_gesture_vx) > 2 || Math.abs(this._dr_gesture_vy) > 2) {
                    this._dr_update_move_bound();
                    this._dr_update_canvas_position();
                    this._dr_start_momentum();
                } else {
                    this._check_page_visibility();
                    this._dr_schedule_disable_smooth_transform();
                }
            }
        };

        // ====== 滚轮缩放（独立于 gesture 模块） ======
        this._bound_dr_handle_wheel = (e) => this._dr_handle_wheel(e);
        this._scroll_container.addEventListener('wheel', this._bound_dr_handle_wheel, { passive: false });
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
        if (this._bound_dr_handle_wheel) {
            this._scroll_container?.removeEventListener('wheel', this._bound_dr_handle_wheel);
            this._bound_dr_handle_wheel = null;
        }
    }

    _setup_keyboard_events() {
        this._bound_handle_keydown = (e) => this._handle_keydown(e);
        document.addEventListener('keydown', this._bound_handle_keydown);
    }

    _handle_keydown(e) {
        if (!this.is_open) return;

        // 设置面板作为伪标签覆盖在阅读器上方时，忽略阅读器快捷键：
        // 否则 Esc 会误关底层文档、翻页/缩放键会操作被遮挡的阅读器并劫持设置页滚动
        const settings_panel_el = document.getElementById('settingsPanel');
        if (settings_panel_el && settings_panel_el.style.display === 'flex') return;

        // 输入框聚焦时跳过快捷键（避免干扰页面跳转输入）
        const active_tag = document.activeElement?.tagName;
        const is_input_focused = active_tag === 'INPUT' || active_tag === 'TEXTAREA';

        if (e.key === 'Escape') {
            e.preventDefault();
            // 若页面跳转输入框聚焦，由输入框自身处理 Escape
            if (is_input_focused && document.activeElement?.classList?.contains('dr-page-jump-input')) return;
            this.close();
        }

        // Ctrl+0 / Cmd+0 重置缩放
        if ((e.ctrlKey || e.metaKey) && e.key === '0') {
            e.preventDefault();
            if (this.dr_scale !== 1 || this.dr_canvas_x !== 0 || this.dr_canvas_y !== 0) {
                this.dr_scale = 1;
                this.dr_canvas_x = 0;
                this.dr_canvas_y = 0;
                this._dr_apply_scale();
            }
            return;
        }

        if (is_input_focused) return;

        // Home → 第一页，End → 最后一页
        if (e.key === 'Home') {
            e.preventDefault();
            this._scroll_to_page(0);
            this.page_manager.current_index = 0;
            this.active_page_index = 0;
            this._update_page_indicator();
            this._sync_page_buttons();
            return;
        }
        if (e.key === 'End') {
            e.preventDefault();
            const last = this.page_manager.get_page_count() - 1;
            this._scroll_to_page(last);
            this.page_manager.current_index = last;
            this.active_page_index = last;
            this._update_page_indicator();
            this._sync_page_buttons();
            return;
        }

        // PageUp / ArrowUp / ArrowLeft → 上一页，PageDown / ArrowDown / ArrowRight → 下一页
        if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault();
            this.handle_page_nav_prev();
            return;
        }
        if (e.key === 'PageDown' || e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault();
            this.handle_page_nav_next();
            return;
        }

        // +/- 缩放（0.15 步长）
        if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            this._dr_zoom_by_step(0.15);
            return;
        }
        if (e.key === '-' || e.key === '_') {
            e.preventDefault();
            this._dr_zoom_by_step(-0.15);
            return;
        }
    }

    /** 以视口中心为基准缩放指定步长 */
    _dr_zoom_by_step(delta) {
        const new_s = Math.max(this.dr_min_scale, Math.min(this.dr_max_scale, this.dr_scale + delta));
        if (new_s === this.dr_scale) return;

        const ratio = new_s / this.dr_scale;
        const cx = this._scroll_container?.clientWidth / 2 || 0;
        const cy = this._scroll_container?.clientHeight / 2 || 0;

        this.dr_canvas_x = cx - (cx - this.dr_canvas_x) * ratio;
        this.dr_canvas_y = cy - (cy - this.dr_canvas_y) * ratio;
        this.dr_scale = new_s;
        this._dr_apply_scale();
    }

    // ====== 笔画生命周期 — 复制自 main.js ======

    _start_stroke(type) {
        const DRAW_CONFIG = window.DRAW_CONFIG;
        const baseEraserSize = DRAW_CONFIG.eraserSize;
        this.current_stroke = {
            type: type,
            points: [],
            color: type === 'draw' ? DRAW_CONFIG.penColor : '#000000',
            lineWidth: type === 'draw' ? DRAW_CONFIG.penWidth : baseEraserSize,
            eraserSize: baseEraserSize,
            eraserSizeRaw: DRAW_CONFIG.eraserSize,
            eraserShape: 'square',
            scale: 1,
            bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
            variableWidths: [],
            _cache_uid: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        this.current_pressure = 0.5;
        this.current_line_width = DRAW_CONFIG.penWidth;
        this.last_line_width = DRAW_CONFIG.penWidth;

        this.cached_draw_type = type;
        this.cached_draw_color = type === 'draw' ? DRAW_CONFIG.penColor : '#000000';
        this.cached_draw_line_width = type === 'draw' ? DRAW_CONFIG.penWidth : baseEraserSize;

        if (this.batch_draw) {
            this.batch_draw.batch_draw_init_start();
        }
    }

    _save_stroke_point(from_x, from_y, to_x, to_y, pressure) {
        const stroke = this.current_stroke;
        if (!stroke) return;

        const bounds = stroke.bounds;
        if (from_x < bounds.minX) bounds.minX = from_x;
        if (to_x < bounds.minX) bounds.minX = to_x;
        if (from_y < bounds.minY) bounds.minY = from_y;
        if (to_y < bounds.minY) bounds.minY = to_y;
        if (from_x > bounds.maxX) bounds.maxX = from_x;
        if (to_x > bounds.maxX) bounds.maxX = to_x;
        if (from_y > bounds.maxY) bounds.maxY = from_y;
        if (to_y > bounds.maxY) bounds.maxY = to_y;

        let currentWidth = stroke.lineWidth;
        const DRAW_CONFIG = window.DRAW_CONFIG;

        if (stroke.type === 'draw') {
            this.current_pressure = pressure;
            this.last_line_width = this.current_line_width;
            currentWidth = stroke.lineWidth * (0.9 + pressure * 0.2);
            this.current_line_width = currentWidth;
            this.cached_draw_line_width = DRAW_CONFIG.penWidth;
        } else if (stroke.type === 'erase') {
            this.cached_draw_line_width = DRAW_CONFIG.eraserSize;
        }

        stroke.variableWidths.push(currentWidth);

        stroke.points.push({ fromX: from_x, fromY: from_y, toX: to_x, toY: to_y });
    }

    async _submit_stroke() {
        if (this.current_stroke && this.current_stroke.points.length > 0) {
            if (this.batch_draw) {
                this.batch_draw.batch_draw_handle_flush();
                const penMode = window.get_pen_effect_mode ? window.get_pen_effect_mode() : 'off';
                if (penMode === 'limited' && this.batch_draw._storedWidths.length > 0) {
                    const baseW = this.current_stroke.lineWidth || 5;
                    this.batch_draw._apply_speed_taper(this.batch_draw._storedWidths, this.current_stroke.points, baseW);
                }
                const stored_widths = this.batch_draw._storedWidths;
                if (stored_widths &&
                    stored_widths.length === this.current_stroke.points.length) {
                    this.current_stroke.storedWidths = [...stored_widths];
                }
            }

            const page = this.page_manager.get_current_page();
            if (page) {
                const hw = Math.max(this.current_stroke.lineWidth || 5, this.current_stroke.eraserSize || 5) / 2;
                const raw = this.current_stroke.bounds;
                const stroke_bounds = raw ? {
                    minX: raw.minX - hw, minY: raw.minY - hw,
                    maxX: raw.maxX + hw, maxY: raw.maxY + hw
                } : null;
                const cmd = new DrawCommand({
                    stroke: this.current_stroke,
                    strokeHistoryRef: page.stroke_history,
                    redrawFn: () => this._render_all_strokes(stroke_bounds)
                });
                cmd.page_index = this.active_page_index;
                await history_execute_command(cmd, false);
                this._trim_undo_stack();
                this._dr_diag('submit', {
                    page: this.active_page_index + 1,
                    type: this.current_stroke.type,
                    hist: page.stroke_history.length,
                    tr: !!page.tile_renderer
                });

                if (page.tile_renderer) {
                    const tr = page.tile_renderer;
                    tr._strokeHistoryRef = page.stroke_history;
                    const orig_scale = window.state?.scale;
                    if (window.state) window.state.scale = this.dr_scale;
                    tr.add_stroke(this.current_stroke);
                    if (window.state) window.state.scale = orig_scale;
                    this._dr_diag('probe-submit', {
                        page: this.active_page_index + 1,
                        ...tr.diag_content_ratio()
                    });
                } else if (page._tiles_deferred) {
                    // 延迟创建的 tile 在落笔后初始化
                    this._ensure_page_tiles(this.active_page_index);
                    if (page.tile_renderer) {
                        page.tile_renderer._strokeHistoryRef = page.stroke_history;
                        const orig_scale = window.state?.scale;
                        if (window.state) window.state.scale = this.dr_scale;
                        page.tile_renderer.add_stroke(this.current_stroke);
                        if (window.state) window.state.scale = orig_scale;
                    }
                }
            }
        }

        this.current_stroke = null;
        if (this.batch_draw) {
            await this.batch_draw.batch_draw_handle_end();
            this.batch_draw.batch_draw_delete_all();
        }
        this._update_button_status();
    }

    // ====== 撤销与清空 ======

    /** 裁剪全局 undo 栈至 _max_history_steps 上限 */
    _trim_undo_stack() {
        history_trim_undo_front(this._max_history_steps);
    }

    async handle_undo() {
        if (!history_validate_undo()) return;
        if (this.is_drawing) return;

        // 检查栈顶命令所属页面，若与当前页不同则先切换
        const top_cmd = history_peek_undo();
        if (top_cmd && typeof top_cmd.page_index === 'number' &&
            top_cmd.page_index !== this.active_page_index) {
            this.active_page_index = top_cmd.page_index;
            this.page_manager.current_index = top_cmd.page_index;
            await this._scroll_to_page(top_cmd.page_index);
            this._update_page_indicator();
            this._sync_page_buttons();
        }

        this._diag_suppress = true;
        try {
            await history_handle_undo();
        } finally {
            this._diag_suppress = false;
        }
        this._dr_diag('undo', { page: this.active_page_index + 1 });
        this._update_button_status();
    }

    async handle_clear() {
        if (this.is_drawing) return;

        const page = this.page_manager.get_current_page();
        if (!page || page.stroke_history.length === 0) return;

        const cmd = new ClearCommand({
            savedStrokeHistory: [...page.stroke_history],
            savedBaseImageURL: null,
            strokeHistoryRef: page.stroke_history,
            baseImageURLRef: {
                get value() { return null; },
                set value(v) {}
            },
            baseImageObjRef: {
                get value() { return null; },
                set value(v) {}
            },
            redrawFn: () => this._render_all_strokes(),
            loadBaseImageFn: () => Promise.resolve()
        });
        cmd.page_index = this.active_page_index;
        this._diag_suppress = true;
        try {
            await history_execute_command(cmd, false);
        } finally {
            this._diag_suppress = false;
        }
        this._dr_diag('clear', { page: this.active_page_index + 1 });
        this._trim_undo_stack();

        this._update_button_status();
    }

    // ====== 页面导航 ======

    async handle_page_nav_prev() {
        if (this.is_drawing) return;
        await this._submit_stroke();
        const moved = this.page_manager.nav_prev();
        if (moved) {
            await this._scroll_to_page(this.page_manager.current_index);
            this._update_page_indicator();
            this._sync_page_buttons();
            this._update_button_status();
        }
    }

    async handle_page_nav_next() {
        if (this.is_drawing) return;
        await this._submit_stroke();
        const moved = this.page_manager.nav_next();
        if (moved) {
            await this._scroll_to_page(this.page_manager.current_index);
            this._update_page_indicator();
            this._sync_page_buttons();
            this._update_button_status();
        }
    }

    async _scroll_to_page(page_index) {
        if (!this._scroll_container || !this._zoom_wrapper) return;
        const page_data = this.page_manager.pages_list[page_index];
        if (!page_data) return;

        // 候选2 懒建 DOM：open 时仅构建近活动页 ±K 的包裹，翻页目标可能尚未建。
        // 必须在滚动前确保目标页元素存在——否则视图永不移动，_check_page_visibility
        // 也不会把目标页纳入可见范围，导致"无法翻到下一页"（死锁：不滚动→永不可见→永建）。
        // 虚拟化模式按需懒建，非虚拟化模式 open 时已全量构建（page_element 必然存在）。
        let page_el = page_data.page_element;
        if (!page_el && this._dom_virtualize()) {
            page_el = this._ensure_page_element(page_index);
        }
        if (!page_el) return;

        const container = this._scroll_container;
        const s = this.dr_scale;

        // 用缓存布局坐标（_cached_top/_cached_h，所有页在 _compute_page_layout 均算好）
        // 计算页面中心，独立于页面是否已栅格化——避免依赖 offsetTop/offsetHeight
        // （未渲染时可能为 0）导致居中错位；虚拟化下 div 以 absolute top 定位，两者等价。
        const page_top = (page_data._cached_top != null) ? page_data._cached_top : page_el.offsetTop;
        const page_h = (page_data._cached_h != null) ? page_data._cached_h : page_el.offsetHeight;
        const page_center_y = page_top + page_h / 2;
        const viewport_center_y = container.clientHeight / 2;

        // 设置 canvas_y 使页面中心居中视口（无需动画，_dr_apply_scale 会 clamp 边界）
        this.dr_canvas_x = 0;
        this.dr_canvas_y = viewport_center_y - page_center_y * s;
        this._dr_apply_scale();

        // 翻页后预渲染相邻页面
        this._prerender_for_navigation(page_index);
    }

    _update_page_indicator() {
        const el = this._el_page_indicator || document.getElementById('drPageIndicator');
        if (el) {
            el.textContent = `${this.page_manager.current_index + 1} / ${this.page_manager.get_page_count()}`;
        }
        // 翻页/滚动改变当前页 → 防抖保存阅读位置
        this._schedule_annotation_save();
    }

    /** 点击页码指示器时显示页码跳转输入框 */
    _show_page_jump_input() {
        const el = document.getElementById('drPageIndicator');
        if (!el || el.querySelector('input')) return;

        const max_page = this.page_manager.get_page_count();
        const current_page = this.page_manager.current_index + 1;

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'dr-page-jump-input';
        input.min = 1;
        input.max = max_page;
        input.value = current_page;
        input.setAttribute('aria-label', '跳转页码');

        el.textContent = '';
        el.appendChild(input);
        input.focus();
        input.select();

        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            input.removeEventListener('keydown', key_handler);
            input.removeEventListener('blur', blur_handler);
        };

        const jump_to_page = (page_num) => {
            cleanup();
            const index = page_num - 1;
            if (index >= 0 && index < max_page) {
                this.page_manager.current_index = index;
                this.active_page_index = index;
                this._scroll_to_page(index);
                this._sync_page_buttons();
            }
            this._update_page_indicator();
        };

        const key_handler = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const val = parseInt(input.value, 10);
                if (!isNaN(val)) jump_to_page(val);
                else this._update_page_indicator();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cleanup();
                this._update_page_indicator();
            }
        };

        const blur_handler = () => {
            // 延迟执行，避免与 keydown Enter 冲突
            setTimeout(() => {
                if (cleaned) return;
                const val = parseInt(input.value, 10);
                if (!isNaN(val)) jump_to_page(val);
                else this._update_page_indicator();
            }, 100);
        };

        input.addEventListener('keydown', key_handler);
        input.addEventListener('blur', blur_handler);
    }

    _sync_page_buttons() {
        const prev = this._el_prev_btn || document.getElementById('drPagePrev');
        const next = this._el_next_btn || document.getElementById('drPageNext');
        if (prev) prev.disabled = this.page_manager.current_index <= 0;
        if (next) next.disabled = this.page_manager.current_index >= this.page_manager.get_page_count() - 1;
    }

    // ====== 工具栏切换 ======

    _switch_toolbar(reader_active) {
        const toolbar = document.getElementById('drToolbar');
        
        if (toolbar) {
            toolbar.style.display = reader_active ? '' : 'none';
        }
    }

    // ====== 工具栏事件 ======

    _setup_toolbar_events() {
        const minimize_btn = document.getElementById('drBtnMinimize');
        if (minimize_btn) {
            minimize_btn.addEventListener('click', async () => {
                if (window.__TAURI__?.window?.getCurrentWindow) {
                    window.main_hide_window?.();
                }
            });
        }

        this._el_prev_btn = document.getElementById('drPagePrev');
        this._el_next_btn = document.getElementById('drPageNext');
        if (this._el_prev_btn) this._el_prev_btn.addEventListener('click', () => this.handle_page_nav_prev());
        if (this._el_next_btn) this._el_next_btn.addEventListener('click', () => this.handle_page_nav_next());

        this._el_page_indicator = document.getElementById('drPageIndicator');
        if (this._el_page_indicator) {
            this._el_page_indicator.style.cursor = 'pointer';
            this._el_page_indicator.addEventListener('click', () => this._toggle_page_sidebar());
            this._el_page_indicator.addEventListener('dblclick', () => this._show_page_jump_input());
        }

        this._el_move_btn = document.getElementById('drBtnMove');
        this._el_comment_btn = document.getElementById('drBtnComment');
        this._el_eraser_btn = document.getElementById('drBtnEraser');
        this._el_undo_btn = document.getElementById('drBtnUndo');

        if (this._el_move_btn) this._el_move_btn.addEventListener('click', () => this._set_draw_mode('move'));
        if (this._el_comment_btn) this._el_comment_btn.addEventListener('click', () => {
            const btn = this._el_comment_btn || document.getElementById('drBtnComment');
            if (this.draw_mode === 'comment') {
                if (window.main_show_pen_control_panel && btn) {
                    window.main_show_pen_control_panel(btn, 'comment');
                }
            } else {
                this._set_draw_mode('comment');
            }
        });
        if (this._el_eraser_btn) this._el_eraser_btn.addEventListener('click', () => {
            const btn = this._el_eraser_btn || document.getElementById('drBtnEraser');
            if (this.draw_mode === 'eraser') {
                if (window.main_show_pen_control_panel && btn) {
                    window.main_show_pen_control_panel(btn, 'eraser');
                }
            } else {
                this._set_draw_mode('eraser');
            }
        });
        if (this._el_undo_btn) this._el_undo_btn.addEventListener('click', () => this.handle_undo());

        const bb_btn = document.getElementById('drBtnBlackboard');
        if (bb_btn) {
            bb_btn.addEventListener('click', async () => {
                const bb = await window.blackboard_ensure_loaded(document.body);
                if (bb && !bb.is_open) {
                    bb.open();
                }
            });
        }

        this._update_minimize_btn_visibility();
    }

    async _update_minimize_btn_visibility() {
        const minimize_btn = document.getElementById('drBtnMinimize');
        if (!minimize_btn) return;
        try {
            const result = await window.__TAURI__?.core?.invoke('settings_fetch_all');
            if (result?.settings?.docReaderShowMinimize === false) {
                minimize_btn.style.display = 'none';
            }
        } catch (_) {}
    }

    async _set_draw_mode(mode) {
        if (this.is_drawing) {
            this.is_drawing = false;
            if (this.current_stroke) {
                await this._submit_stroke();
            }
            if (this.batch_draw) {
                this.batch_draw.batch_draw_delete_all();
            }
        }

        this.draw_mode = mode;

        const move = this._el_move_btn || document.getElementById('drBtnMove');
        const comment = this._el_comment_btn || document.getElementById('drBtnComment');
        const eraser = this._el_eraser_btn || document.getElementById('drBtnEraser');

        if (move) move.classList.toggle('active', mode === 'move');
        if (comment) comment.classList.toggle('active', mode === 'comment');
        if (eraser) eraser.classList.toggle('active', mode === 'eraser');

        // 无原生滚动条，touch-action 仅用于控制双指手势由 touch handler 接管
        if (this._scroll_container) {
            this._scroll_container.style.touchAction = 'none';
        }

        if (mode !== 'eraser') {
            this._hide_eraser_hint();
        }
    }

    // ====== 橡皮擦提示 ======

    _create_eraser_hint() {
        // 移除旧的橡皮擦提示（如果有）
        if (this._eraser_hint && this._eraser_hint.parentNode) {
            this._eraser_hint.parentNode.removeChild(this._eraser_hint);
        }

        // 创建文档阅读器专用的橡皮擦提示元素
        this._eraser_hint = document.createElement('div');
        this._eraser_hint.className = 'eraser-hint';
        this._eraser_hint.style.width = (window.DRAW_CONFIG?.eraserSize || 15) + 'px';
        this._eraser_hint.style.height = (window.DRAW_CONFIG?.eraserSize || 15) + 'px';
        this._scroll_container.appendChild(this._eraser_hint);
    }

    _show_eraser_hint() {
        if (!this._eraser_hint) return;
        // 提示圆圈是屏幕像素，实际擦除直径 = 内容尺寸 × 当前缩放，
        // 必须乘 scale 才能与真实擦除范围一致
        const eraser_size = (window.DRAW_CONFIG?.eraserSize || 15) * (this.dr_scale || 1);
        this._eraser_hint.style.width = eraser_size + 'px';
        this._eraser_hint.style.height = eraser_size + 'px';
        this._eraser_hint.classList.add('active');
    }

    _hide_eraser_hint() {
        if (!this._eraser_hint) return;
        this._eraser_hint.classList.remove('active');
        if (this._eraser_hint_raf_id !== null) {
            cancelAnimationFrame(this._eraser_hint_raf_id);
            this._eraser_hint_raf_id = null;
        }
        this._eraser_hint_pending_pos = null;
    }

    _update_eraser_hint_position(clientX, clientY) {
        if (!this._eraser_hint) return;
        this._eraser_hint_pending_pos = { clientX, clientY };
        if (this._eraser_hint_raf_id !== null) return;

        this._eraser_hint_raf_id = requestAnimationFrame(() => {
            this._eraser_hint_raf_id = null;
            if (!this._eraser_hint_pending_pos) return;
            const pos = this._eraser_hint_pending_pos;
            this._eraser_hint_pending_pos = null;

            // 尺寸：内容尺寸 × 当前缩放（与实际擦除直径一致）
            const eraser_size = (this.cached_draw_line_width || window.DRAW_CONFIG?.eraserSize || 15)
                * (this.dr_scale || 1);
            this._eraser_hint.style.width = eraser_size + 'px';
            this._eraser_hint.style.height = eraser_size + 'px';

            // 定位：以提示元素的真实包含块（offsetParent，即面板）为基准。
            // 之前减容器矩形，但容器无 position、不构成包含块，
            // 容器在面板内的 padding 会造成恒定 ~16px 偏移
            const op = this._eraser_hint.offsetParent;
            let x, y;
            if (op) {
                const opr = op.getBoundingClientRect();
                x = pos.clientX - opr.left;
                y = pos.clientY - opr.top;
            } else if (this._scroll_container) {
                if (!this._cached_container_rect) {
                    const cr = this._scroll_container.getBoundingClientRect();
                    const wr = this._zoom_wrapper?.getBoundingClientRect();
                    this._cached_container_rect = { top: cr.top, bottom: cr.bottom, left: cr.left, wrapperTop: wr?.top ?? 0 };
                }
                x = pos.clientX - this._cached_container_rect.left;
                y = pos.clientY - this._cached_container_rect.top;
            } else {
                return;
            }
            this._eraser_hint.style.left = x + 'px';
            this._eraser_hint.style.top = y + 'px';
            this._eraser_hint.style.transform = 'translate(-50%, -50%)';
        });
    }

    // ====== 页面侧边栏 ======

    _toggle_page_sidebar() {
        const existing_sidebar = document.getElementById('drPageSidebar');
        if (existing_sidebar) {
            existing_sidebar.remove();
            return;
        }

        const sidebar = document.createElement('div');
        sidebar.id = 'drPageSidebar';
        sidebar.className = 'dr-page-sidebar';

        const pages = this.page_manager.pages_list;
        const current_index = this.page_manager.current_index;

        // 创建头部
        const header = document.createElement('div');
        header.className = 'dr-page-sidebar-header';
        header.textContent = `页面 (${current_index + 1}/${pages.length})`;
        sidebar.appendChild(header);

        // 创建内容区域
        const content = document.createElement('div');
        content.className = 'dr-page-sidebar-content';

        const use_virtual_sidebar = pages.length > this._sidebar_virtual_threshold;
        if (use_virtual_sidebar) {
            content.classList.add('virtualized');
        } else {
            pages.forEach((page, index) => {
                content.appendChild(this._create_page_sidebar_item(page, index, current_index));
            });
        }

        sidebar.appendChild(content);
        document.body.appendChild(sidebar);
        if (use_virtual_sidebar) {
            this._setup_virtual_page_sidebar(content, pages, current_index);
        } else {
            this._setup_page_sidebar_thumbnail_loading(content);
        }

        // 绑定点击事件
        content.addEventListener('click', (event) => {
            const item = event.target.closest('.dr-page-sidebar-item');
            if (!item || !content.contains(item)) return;
            const page_index = parseInt(item.dataset.page);
            this._scroll_to_page(page_index);
            this.page_manager.current_index = page_index;
            this.active_page_index = page_index;
            this._update_page_indicator();
            this._sync_page_buttons();
            sidebar.remove();
        });

        // 点击外部关闭
        const close_handler = (e) => {
            if (!sidebar.contains(e.target) && e.target.id !== 'drPageIndicator') {
                sidebar.remove();
                document.removeEventListener('click', close_handler);
            }
        };
        setTimeout(() => document.addEventListener('click', close_handler), 100);
    }

    _create_page_sidebar_item(page, index, current_index) {
        const is_active = index === current_index;
        const page_label = `第 ${page.page_num || index + 1} 页`;
        const item = document.createElement('div');
        item.className = `dr-page-sidebar-item ${is_active ? 'active' : ''}`;
        item.dataset.page = index;

        const thumbnail_src = page.image_url || page.thumbnail_url;
        let thumb_el;
        if (thumbnail_src) {
            const img = document.createElement('img');
            img.className = 'dr-page-sidebar-thumb';
            img.dataset.page = index;
            img.src = thumbnail_src;
            img.alt = page_label;
            img.loading = 'lazy';
            thumb_el = img;
        } else if (page.render_mode === 'pdfjs') {
            const canvas = document.createElement('canvas');
            canvas.className = 'dr-page-sidebar-thumb dr-page-sidebar-pdf-thumb is-loading';
            canvas.dataset.page = index;
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', page_label);
            thumb_el = canvas;
            item.classList.add('loading');
        } else {
            thumb_el = document.createElement('div');
            thumb_el.className = 'dr-page-sidebar-thumb is-loading';
            thumb_el.dataset.page = index;
            thumb_el.setAttribute('role', 'img');
            thumb_el.setAttribute('aria-label', page_label);
            item.classList.add('loading');
        }

        const label = document.createElement('span');
        label.textContent = page_label;

        item.appendChild(thumb_el);
        item.appendChild(label);
        return item;
    }

    _setup_virtual_page_sidebar(content, pages, current_index) {
        let render_raf = null;
        const render_window = () => {
            render_raf = null;
            const item_h = this._sidebar_item_height;
            const viewport_h = content.clientHeight || 480;
            const start = Math.max(0, Math.floor(content.scrollTop / item_h) - this._sidebar_overscan);
            const end = Math.min(
                pages.length,
                Math.ceil((content.scrollTop + viewport_h) / item_h) + this._sidebar_overscan
            );

            const spacer = document.createElement('div');
            spacer.className = 'dr-page-sidebar-virtual-spacer';
            spacer.style.height = `${pages.length * item_h}px`;

            for (let i = start; i < end; i++) {
                const item = this._create_page_sidebar_item(pages[i], i, current_index);
                item.style.top = `${i * item_h}px`;
                item.style.height = `${item_h - 6}px`;
                spacer.appendChild(item);
            }

            content.replaceChildren(spacer);
            this._setup_page_sidebar_thumbnail_loading(content);
        };

        const schedule_render = () => {
            if (render_raf !== null) return;
            render_raf = requestAnimationFrame(render_window);
        };

        content.addEventListener('scroll', schedule_render, { passive: true });
        content.scrollTop = Math.max(0, current_index * this._sidebar_item_height - this._sidebar_item_height);
        render_window();
    }

    _setup_page_sidebar_thumbnail_loading(content) {
        const unloaded_imgs = Array.from(content.querySelectorAll('.dr-page-sidebar-thumb.is-loading'));
        if (unloaded_imgs.length === 0) return;

        // 优先加载可见页面和当前活动页面附近的缩略图
        const priority_imgs = unloaded_imgs
            .filter(img => {
                const page_index = parseInt(img.dataset.page);
                const page = this.page_manager.pages_list[page_index];
                return page?.is_visible || page_index === this.active_page_index;
            })
            .sort((a, b) => {
                const ai = parseInt(a.dataset.page);
                const bi = parseInt(b.dataset.page);
                return Math.abs(ai - this.active_page_index) - Math.abs(bi - this.active_page_index);
            });

        // 批量加载优先图片（限制并发数为3）
        const max_concurrent = 3;
        let loading_count = 0;
        const load_next = () => {
            while (loading_count < max_concurrent && priority_imgs.length > 0) {
                const img = priority_imgs.shift();
                loading_count++;
                this._load_page_sidebar_thumbnail(parseInt(img.dataset.page), img).finally(() => {
                    loading_count--;
                    load_next();
                });
            }
        };
        load_next();

        const deferred_imgs = unloaded_imgs.filter(img => !priority_imgs.includes(img));
        if (deferred_imgs.length === 0) return;

        if (!window.IntersectionObserver) {
            // 不支持IntersectionObserver时，加载前8个
            deferred_imgs.slice(0, 8).forEach(img => {
                this._load_page_sidebar_thumbnail(parseInt(img.dataset.page), img);
            });
            return;
        }

        // 断开前一个 observer（防止多次打开侧边栏导致泄漏）
        if (this._thumbnail_observer) {
            this._thumbnail_observer.disconnect();
            this._thumbnail_observer = null;
        }
        // 使用IntersectionObserver加载可见区域的缩略图
        this._thumbnail_observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                const img = entry.target;
                this._thumbnail_observer?.unobserve(img);
                this._load_page_sidebar_thumbnail(parseInt(img.dataset.page), img);
            }
        }, {
            root: content,
            rootMargin: '200px 0px', // 增加预加载区域
            threshold: 0.01
        });

        deferred_imgs.forEach(img => this._thumbnail_observer.observe(img));
    }

    async _load_page_sidebar_thumbnail(page_index, img) {
        const page = this.page_manager.pages_list[page_index];
        if (!page || !img) return;

        // 检查缓存
        if (this._sidebar_thumbnail_cache.has(page_index)) {
            const cached_url = this._sidebar_thumbnail_cache.get(page_index);
            this._set_sidebar_thumbnail_src(img, page_index, cached_url);
            return;
        }

        if (page.render_mode === 'pdfjs') {
            if (img.dataset.rendered === 'true') return;
            if (page.sidebar_thumbnail_loading) return;

            page.sidebar_thumbnail_loading = true;
            try {
                await this._render_page_sidebar_pdf_thumbnail(page_index, img);
            } catch (error) {
                // 快速滚动时缩略图渲染被取消属预期，静默处理
                if (error?.name !== 'RenderingCancelledException') {
                    console.error(`渲染 PDF 缩略图 ${page_index + 1} 失败:`, error);
                }
                // 失败时移除加载态，避免无限 shimmer 动画常驻消耗 GPU
                img.classList.remove('is-loading');
                img.closest('.dr-page-sidebar-item')?.classList.remove('loading');
            } finally {
                page.sidebar_thumbnail_loading = false;
            }
            return;
        }

        const existing_src = page.image_url || page.thumbnail_url;
        if (existing_src) {
            this._set_sidebar_thumbnail_src(img, page_index, existing_src);
            return;
        }
        if (page.sidebar_thumbnail_loading) return;

        page.sidebar_thumbnail_loading = true;
        try {
            await this._load_pdf_page(page_index);
            const loaded_src = page.image_url || page.thumbnail_url;
            if (loaded_src) {
                this._update_page_sidebar_thumbnail(page_index, loaded_src);
            }
        } catch (error) {
            console.error(`加载侧边栏原图 ${page_index + 1} 失败:`, error);
            // 失败时移除加载态，避免无限 shimmer 动画常驻消耗 GPU
            img.classList.remove('is-loading');
            img.closest('.dr-page-sidebar-item')?.classList.remove('loading');
        } finally {
            page.sidebar_thumbnail_loading = false;
        }
    }

    async _render_page_sidebar_pdf_thumbnail(page_index, canvas) {
        const page = this.page_manager.pages_list[page_index];
        const folder = this._get_active_folder();
        if (!page || !folder?.pdfDoc || !canvas || canvas.tagName !== 'CANVAS') return;

        // 检查缓存
        if (this._sidebar_thumbnail_cache.has(page_index)) {
            const cached_url = this._sidebar_thumbnail_cache.get(page_index);
            this._set_sidebar_thumbnail_src(canvas, page_index, cached_url);
            return;
        }

        let pdf_page = this._pdf_page_cache.get(page_index);
        if (!pdf_page) {
            pdf_page = await folder.pdfDoc.getPage(page.page_num);
            this._pdf_page_cache.set(page_index, pdf_page);
            this._pdf_page_cache_evict();
        }
        try {
            const base_viewport = pdf_page.getViewport({ scale: 1 });
            // 使用更小的渲染尺寸以提高性能
            const css_w = Math.max(120, Math.round(canvas.clientWidth || canvas.closest('.dr-page-sidebar-item')?.clientWidth || 180));
            const css_h = Math.round(css_w * 9 / 16);
            const dpr = Math.min(window.devicePixelRatio || window.DRAW_CONFIG?.dpr || 1, 2);
            const canvas_w = Math.ceil(css_w * dpr);
            const canvas_h = Math.ceil(css_h * dpr);
            const page_scale = Math.min(canvas_w / base_viewport.width, canvas_h / base_viewport.height);
            const viewport = pdf_page.getViewport({ scale: page_scale });
            const offset_x = Math.round((canvas_w - viewport.width) / 2);
            const offset_y = Math.round((canvas_h - viewport.height) / 2);

            canvas.width = canvas_w;
            canvas.height = canvas_h;
            canvas.style.width = '100%';
            canvas.style.height = css_h + 'px';

            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas_w, canvas_h);

            const task = pdf_page.render({
                canvasContext: ctx,
                viewport,
                transform: [1, 0, 0, 1, offset_x, offset_y]
            });
            await task.promise;

            // 将渲染结果转换为blob URL并缓存
            const blob_url = await new Promise(resolve => {
                canvas.toBlob(blob => {
                    if (blob) {
                        resolve(URL.createObjectURL(blob));
                    } else {
                        resolve(null);
                    }
                }, 'image/jpeg', 0.7);
            });

            if (blob_url) {
                this._sidebar_thumbnail_cache.set(page_index, blob_url);
                this._sidebar_thumbnail_cache_evict();
                // 使用缓存的blob URL替换canvas
                this._set_sidebar_thumbnail_src(canvas, page_index, blob_url);
            } else {
                canvas.dataset.rendered = 'true';
                canvas.classList.remove('is-loading');
                canvas.closest('.dr-page-sidebar-item')?.classList.remove('loading');
            }
        } finally {
            // 只在非缓存页 cleanup（缓存页保持内部数据就绪）
            if (!this._pdf_page_cache.has(page_index)) {
                pdf_page.cleanup?.();
            }
        }
    }

    _update_page_sidebar_thumbnail(page_index, src) {
        const img = document.querySelector(`#drPageSidebar .dr-page-sidebar-thumb[data-page="${page_index}"]`);
        if (!img || !src) return;
        this._set_sidebar_thumbnail_src(img, page_index, src);
    }

    _set_sidebar_thumbnail_src(thumb_el, page_index, src) {
        if (!thumb_el || !src) return;
        let img = thumb_el;
        if (thumb_el.tagName !== 'IMG') {
            img = document.createElement('img');
            img.className = 'dr-page-sidebar-thumb';
            img.dataset.page = page_index;
            img.alt = `第 ${page_index + 1} 页`;
            img.loading = 'lazy';
            thumb_el.replaceWith(img);
        }
        img.src = src;
        img.classList.remove('is-loading');
        img.closest('.dr-page-sidebar-item')?.classList.remove('loading');
    }

    _release_sidebar_thumbnail_cache() {
        // 释放所有缓存的blob URL
        for (const blob_url of this._sidebar_thumbnail_cache.values()) {
            if (blob_url && blob_url.startsWith('blob:')) {
                URL.revokeObjectURL(blob_url);
            }
        }
        this._sidebar_thumbnail_cache.clear();
    }

    /** LRU 驱逐：超出上限时撤销最旧缩略图的 blob URL */
    _sidebar_thumbnail_cache_evict() {
        while (this._sidebar_thumbnail_cache.size > this._sidebar_thumbnail_cache_max) {
            const oldest_key = this._sidebar_thumbnail_cache.keys().next().value;
            const blob_url = this._sidebar_thumbnail_cache.get(oldest_key);
            if (blob_url && blob_url.startsWith('blob:')) {
                URL.revokeObjectURL(blob_url);
            }
            this._sidebar_thumbnail_cache.delete(oldest_key);
        }
    }

    // ====== 缩放与 LOD ======

    /** 计算平移边界：缩放后内容是否超出视口，决定可拖动范围 */
    _dr_update_move_bound() {
        if (!this._zoom_wrapper || !this._scroll_container) return;
        const wrapper = this._zoom_wrapper;
        const container = this._scroll_container;
        const mb = this.dr_move_bound;
        const s = this.dr_scale;

        // 每帧最多读一次 DOM 布局属性（避免 momentum/pinch 期间 layout thrashing）
        const now = performance.now();
        if (!this._dr_mb_dom_cache || now - this._dr_mb_dom_time > 16) {
            // 内容高度/宽度用权威布局值，不依赖 wrapper.scrollHeight：
            // flex 容器 + 绝对定位子项下 scrollHeight 可能不撑满显式 height（浏览器实现相关），
            // 会让移动边界被错误 clamp 到初始懒建窗口（≈±K 页），表现为"只能在前几页滑动、
            // 无法翻到下一页"。_page_positions.total 由 _compute_page_layout 按全文档页坐标算好，
            // 与 DOM/CSS 是否正确渲染无关，移动范围始终是完整文档。
            const pos = this._page_positions;
            const content_total = (pos && isFinite(pos.total) && pos.total > 0) ? pos.total : wrapper.scrollHeight;
            const content_w = this._get_page_base_width() || wrapper.scrollWidth;
            this._dr_mb_dom_cache = {
                cw: content_w,
                ch: content_total,
                vw: container.clientWidth,
                vh: container.clientHeight
            };
            this._dr_mb_dom_time = now;
        }
        const { cw: content_w, ch: content_h, vw: viewport_w, vh: viewport_h } = this._dr_mb_dom_cache;

        const needRecompute = this._dr_mb_cache_cw !== content_w ||
            this._dr_mb_cache_ch !== content_h ||
            this._dr_mb_cache_vw !== viewport_w ||
            this._dr_mb_cache_vh !== viewport_h;
        if (needRecompute) {
            this._dr_mb_cache_cw = content_w;
            this._dr_mb_cache_ch = content_h;
            this._dr_mb_cache_vw = viewport_w;
            this._dr_mb_cache_vh = viewport_h;
        }
        // scale 每帧变化时仍需重算 bounds，但跳过 DOM 读取（数学计算极快）

        // X 方向：内容 + padding 始终居中
        const bounded_w = content_w * s;
        if (bounded_w >= viewport_w) {
            mb.min_x = -(bounded_w - viewport_w);
            mb.max_x = 0;
        } else {
            mb.min_x = (viewport_w - bounded_w) / 2;
            mb.max_x = (viewport_w - bounded_w) / 2;
        }

        // Y 方向
        const bounded_h = content_h * s;
        if (bounded_h >= viewport_h) {
            mb.min_y = -(bounded_h - viewport_h);
            mb.max_y = 0;
        } else {
            mb.min_y = (viewport_h - bounded_h) / 2;
            mb.max_y = (viewport_h - bounded_h) / 2;
        }
    }

    /** 将 canvas_x/y 钳制在 move_bound 内 */
    _dr_update_canvas_position() {
        const eps = 0.001;
        const mb = this.dr_move_bound;
        this.dr_canvas_x = Math.max(mb.min_x - eps, Math.min(mb.max_x + eps, this.dr_canvas_x));
        this.dr_canvas_y = Math.max(mb.min_y - eps, Math.min(mb.max_y + eps, this.dr_canvas_y));
    }

    /** 仅同步 transform（无 LOD 更新，用于高频拖拽） */
    _dr_sync_transform() {
        if (!this._zoom_wrapper) return;
        this._zoom_wrapper.style.transform = 'translate3d(' + this.dr_canvas_x + 'px, ' + this.dr_canvas_y + 'px, 0) scale(' + this.dr_scale + ')';
        this._dr_transform_changed = true;
    }

    /** rAF 节流版 sync_transform：合并多帧调用，每帧最多一次 DOM 写入 */
    _dr_sync_transform_schedule(x, y, scale) {
        this._dr_pending_transform = { x, y, scale };
        if (this._dr_transform_raf_id === null) {
            this._dr_transform_raf_id = requestAnimationFrame(() => {
                const pt = this._dr_pending_transform;
                this._dr_pending_transform = null;
                this._dr_transform_raf_id = null;
                if (pt && this._zoom_wrapper) {
                    this._zoom_wrapper.style.transform = 'translate3d(' + pt.x + 'px, ' + pt.y + 'px, 0) scale(' + pt.scale + ')';
                    this._dr_last_transform.x = pt.x;
                    this._dr_last_transform.y = pt.y;
                    this._dr_last_transform.scale = pt.scale;
                    this._dr_transform_changed = true;
                    // 平移中同步刷新可见性：新进入视口的页立即触发 _on_page_visible
                    // 建瓦片（_on_page_visible 对已初始化页有 is_tiles_initialized 守卫，
                    // 仅新可见页有开销）。缩放进行中跳过，避免与缩放结束批量刷新冲突。
                    if (!this._dr_is_zooming) {
                        this._check_page_visibility();
                    }
                }
            });
        }
    }

    /** 应用当前缩放比到 wrapper transform + TileRenderer LOD */
    _dr_apply_scale() {
        const s = this.dr_scale;
        this.dr_cached_inv_scale = 1 / s;

        // 使 overlay 缓存失效
        if (this.batch_draw) {
            this.batch_draw._overlay_cached_rect_left = null;
            this.batch_draw._overlay_cached_rect_top = null;
        }

        this._dr_update_move_bound();
        this._dr_update_canvas_position();
        this._dr_sync_transform();

        // 缩放进行中跳过 tile DPR 更新和可见页重绘，由缩放结束后批量刷新
        if (this._dr_is_zooming) return;

        // 仅遍历已初始化 tile 的页面（跳过无 tile 页面，200+ 页文档性能提升显著）
        for (const i of this._pages_with_tiles) {
            const pd = this.page_manager.pages_list[i];
            if (pd && (pd.is_visible || this._is_page_near_active(i, this._tile_keep_distance))) {
                pd.tile_renderer.update_visible_tile_dpr(s, false, true);
            }
        }

        // 更新 active 页面的 overlay 尺寸（getBoundingClientRect 已包含 transform 缩放）
        if (this.active_page_index >= 0) {
            this._update_overlay_size(this.active_page_index);
        }

        // 缩放/平移后检查页面可见性（已优化为纯数学计算，不触发每页布局）
        this._check_page_visibility();
    }

    /** 标记缩放进行中，延迟 300ms 后触发批量重绘 */
    _dr_set_zooming() {
        if (!this._dr_is_zooming) {
            this._dr_is_zooming = true;
            if (this.batch_draw) {
                this.batch_draw.hide_overlay();
            }
        }
        if (this._zoom_complete_timer !== null) clearTimeout(this._zoom_complete_timer);
        this._zoom_complete_timer = setTimeout(() => {
            this._zoom_complete_timer = null;
            this._dr_is_zooming = false;
            if (this.batch_draw) {
                this.batch_draw.show_overlay();
            }
            // 缩放结束后批量重绘可见页 + 更新 tile DPR
            this._check_page_visibility();
            for (const i of this._pages_with_tiles) {
                const pd = this.page_manager.pages_list[i];
                if (pd && (pd.is_visible || this._is_page_near_active(i, this._tile_keep_distance))) {
                    pd.tile_renderer?.update_visible_tile_dpr(this.dr_scale, false, true);
                }
            }
            // PDF 背景：按新缩放刷新可见页分辨率（非强制；守卫过滤参数未变化的页）
            const pages = this.page_manager.pages_list;
            const lo = Math.max(0, this.active_page_index - this._image_keep_distance);
            const hi = Math.min(pages.length - 1, this.active_page_index + this._image_keep_distance);
            for (let i = lo; i <= hi; i++) {
                const pd = pages[i];
                if (pd?.is_visible && pd.render_mode === 'pdfjs') {
                    this._render_pdf_page_direct(i);
                }
            }
        }, 150);
    }

    /** 撤销、翻页等操作应强制立即重绘，取消缩放延迟 */
    _dr_cancel_zoom_debounce() {
        if (this._zoom_complete_timer !== null) {
            clearTimeout(this._zoom_complete_timer);
            this._zoom_complete_timer = null;
        }
        // 因缩放而隐藏的 overlay 需在此恢复，否则触控捏合（取消 150ms 定时器）
        // 后 overlay 会永久保持 hidden，导致之后书写无实时预览
        if (this._dr_is_zooming) {
        this._dr_is_zooming = false;
            if (this.batch_draw) {
                this.batch_draw.show_overlay();
            }
        }
    }
    _dr_enable_smooth_transform() {
        if (this._smooth_transform_timeout_id !== null) {
            clearTimeout(this._smooth_transform_timeout_id);
            this._smooth_transform_timeout_id = null;
        }
        if (this._zoom_wrapper) {
            this._zoom_wrapper.classList.add('smooth-transform');
        }
    }

    /** 延迟移除 will-change: transform（交互结束后 150ms 释放 GPU 资源） */
    _dr_schedule_disable_smooth_transform() {
        if (this._smooth_transform_timeout_id !== null) {
            clearTimeout(this._smooth_transform_timeout_id);
        }
        this._smooth_transform_timeout_id = setTimeout(() => {
            this._smooth_transform_timeout_id = null;
            if (this._zoom_wrapper) {
                this._zoom_wrapper.classList.remove('smooth-transform');
            }
        }, 150);
    }

    // ====== 惯性系统 ======

    _dr_cancel_momentum() {
        if (this._dr_momentum_raf !== null) {
            cancelAnimationFrame(this._dr_momentum_raf);
            this._dr_momentum_raf = null;
        }
    }

    _dr_start_momentum() {
        if (window.DRAW_CONFIG && !window.DRAW_CONFIG.momentumEnabled) return;
        this._dr_cancel_momentum();
        if (this._dr_momentum_raf !== null) return;
        this._dr_momentum_raf = requestAnimationFrame(() => this._dr_momentum_tick());
    }

    _dr_momentum_tick() {
        let vx = this._dr_gesture_vx;
        let vy = this._dr_gesture_vy;
        const speed = Math.sqrt(vx * vx + vy * vy);
        const friction = 0.85 - 0.20 * Math.exp(-speed / 8);
        vx *= friction;
        vy *= friction;
        this._dr_gesture_vx = vx;
        this._dr_gesture_vy = vy;

        const prevX = this.dr_canvas_x;
        const prevY = this.dr_canvas_y;
        this.dr_canvas_x += vx;
        this.dr_canvas_y += vy;

        this._dr_update_canvas_position();

        // 边界碰撞处理：速度归零（防止贴边滑行）
        if (this.dr_canvas_x === prevX && vx !== 0) {
            this._dr_gesture_vx = 0;
            vx = 0;
        }
        if (this.dr_canvas_y === prevY && vy !== 0) {
            this._dr_gesture_vy = 0;
            vy = 0;
        }

        if (Math.abs(vx) > 0.5 || Math.abs(vy) > 0.5) {
            this._dr_sync_transform();
            this._dr_momentum_raf = requestAnimationFrame(() => this._dr_momentum_tick());
        } else {
            this._dr_momentum_raf = null;
            // 延迟重量操作到浏览器空闲时，避免最后一帧 jank
            const doFinal = () => {
                this._dr_apply_scale();
                this._dr_schedule_disable_smooth_transform();
                this._check_page_visibility();
            };
            if (window.requestIdleCallback) {
                window.requestIdleCallback(doFinal, { timeout: 500 });
            } else {
                doFinal();
            }
        }
    }

    _dr_update_gesture_velocity() {
        const dx = this.dr_canvas_x - this._dr_last_canvas_x;
        const dy = this.dr_canvas_y - this._dr_last_canvas_y;
        const alpha = 0.5;
        this._dr_gesture_vx = this._dr_gesture_vx * (1 - alpha) + dx * alpha;
        this._dr_gesture_vy = this._dr_gesture_vy * (1 - alpha) + dy * alpha;
        this._dr_last_canvas_x = this.dr_canvas_x;
        this._dr_last_canvas_y = this.dr_canvas_y;
    }

    /** 滚轮缩放（以鼠标位置为中心，rAF 节流重计算） */
    _dr_handle_wheel(e) {
        if (!this.is_open) return;
        if (this.is_drawing) return;

        if (e.ctrlKey) {
            // Ctrl+滚轮 = 缩放
            e.preventDefault();

            const max_s = this.dr_max_scale;
            const min_s = this.dr_min_scale;
            const delta = e.deltaY > 0 ? -0.15 : 0.15;
            const new_s = Math.max(min_s, Math.min(max_s, this.dr_scale + delta));

            if (new_s !== this.dr_scale) {
                const old_s = this.dr_scale;
                const ratio = new_s / old_s;

                if (!this._cached_container_rect) {
                    const cr = this._scroll_container.getBoundingClientRect();
                    const wr = this._zoom_wrapper?.getBoundingClientRect();
                    this._cached_container_rect = { top: cr.top, bottom: cr.bottom, left: cr.left, wrapperTop: wr?.top ?? 0 };
                }
                const container_rect = this._cached_container_rect;
                const mouse_x = e.clientX - container_rect.left;
                const mouse_y = e.clientY - container_rect.top;

                this.dr_canvas_x = mouse_x - (mouse_x - this.dr_canvas_x) * ratio;
                this.dr_canvas_y = mouse_y - (mouse_y - this.dr_canvas_y) * ratio;
                this.dr_scale = new_s;
                this.dr_cached_inv_scale = 1 / new_s;
                if (this.batch_draw) {
                    this.batch_draw._overlay_cached_rect_left = null;
                    this.batch_draw._overlay_cached_rect_top = null;
                }

                this._dr_enable_smooth_transform();
                this._dr_set_zooming();

                if (this._wheel_raf_id !== null) {
                    cancelAnimationFrame(this._wheel_raf_id);
                }
                this._wheel_raf_id = requestAnimationFrame(() => {
                    this._wheel_raf_id = null;
                    this._dr_apply_scale();
                    this._dr_schedule_disable_smooth_transform();
                });
            }
        } else {
            // 普通滚轮 = 上下平移（clamp 由 rAF 中 _dr_apply_scale 处理，避免同步布局）
            e.preventDefault();
            const scroll_speed = 2;
            this.dr_canvas_y -= e.deltaY * scroll_speed;

            this._dr_enable_smooth_transform();
            if (this._wheel_raf_id !== null) {
                cancelAnimationFrame(this._wheel_raf_id);
            }
            this._wheel_raf_id = requestAnimationFrame(() => {
                this._wheel_raf_id = null;
                this._dr_apply_scale();
                this._dr_schedule_disable_smooth_transform();
            });
        }
    }

    // ====== 按钮状态 ======

    _update_button_status() {
        const btn = this._el_undo_btn || document.getElementById('drBtnUndo');
        if (btn) btn.disabled = !history_validate_undo();
    }
}

const documentReaderManager = new DocumentReaderManager();
window.documentReaderManager = documentReaderManager;
export default documentReaderManager;
