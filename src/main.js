/**
 * ViewPDF 主逻辑 —— PDF阅读器及批注应用核心
 * 架构: 图像层(img) + 批注层(canvas)，批注系统含笔画记录/压缩/撤销
 * 性能: RAF批量绘制减少重绘；Blob URL替代Data URL节省内存
 */

import './modules/canvas/batch-draw.js';
import ThemeManager from './themes/theme.js';
import {
    history_execute_command,
    DrawCommand,
    ClearCommand,
    SnapshotCommand,
    history_validate_undo,
    history_handle_undo,
    history_delete_all,
    history_validate_compact,
    history_fetch_undo_stack,
    history_fetch_commands_to_compact,
    history_format_compact,
    MAX_HISTORY_STEPS
} from './modules/history.js';
import { DocLoader } from './modules/pdf/document_loader.js';
import { resetContextState, updateContextState } from './modules/canvas/context-state.js';
import { renderStrokesToContext, getPenEffectMode } from './modules/canvas/stroke-renderer.js';
import { createHistoryCompactor } from './modules/canvas/history-compactor.js';

// === 全局变量 ===
let last_canvas_transform = { x: null, y: null, scale: null };


// === PDF.js 配置 ===
function main_init_pdfjs() {
    return DocLoader.init_pdfjs();
}

async function main_wait_pdfjs(maxWait = 5000) {
    return DocLoader.wait_pdfjs(maxWait);
}

// === 全局配置 ===

const DRAW_CONFIG = {
    penColor: null,
    penWidth: 5,
    penSizePresets: [2, 5, 10, 15, 21],
    eraserSize: 15,
    eraserSizePresets: [5, 15, 25, 38, 50],
    palmEraserEnabled: false,
    palmEraserSize: 60,
    momentumEnabled: false,
    minScale: 0.5,
    maxScale: 3,
    maxScaleImage: 4,
    canvasW: 1000,
    canvasH: 600,
    screenW: 0,
    screenH: 0,
    dprLimit: 2,
    dpr: 1,
    dynamicDprEnabled: true,
    dprMin: 1,
    dprMax: 4,
    dprStep: 0.25,
    imageSmoothingQuality: 'high',
    baseDpr: window.devicePixelRatio || 1,
    canvasBgColor: '#2a2a2a',
    penColors: [
        '#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4',
        '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#f43f5e',
        '#14b8a6', '#64748b', '#1e293b', '#000000', '#ffffff'
    ],
    penSmoothness: 0.8,
    penEffectMode: 'limited',
    penMinWidthRatio: 0.4,
    gestureFrameDelta: 60
};

// 选中第一号颜色作为默认笔色
if (DRAW_CONFIG.penColor === null && DRAW_CONFIG.penColors.length > 0) {
    DRAW_CONFIG.penColor = DRAW_CONFIG.penColors[0];
}

// 将配置暴露到全局，供 batch-draw.js 使用
window.DRAW_CONFIG = DRAW_CONFIG;

// 应用 DPR 限制（0=自动无限制）
function main_calc_capped_dpr(rawDpr, limit) {
    return limit > 0 ? Math.min(rawDpr, limit) : rawDpr;
}
window.main_calc_capped_dpr = main_calc_capped_dpr;

function main_fetch_safe_scale() {
    return Math.max(0.001, state.scale || 1);
}
window.main_fetch_safe_scale = main_fetch_safe_scale;

// === 钢笔笔锋效果管理器 ===
// 使用曲面细分算法，根据速度和压感动态调整线宽
// 效果分级: full(完整) | limited(限制) | off(关闭)

class RealPenManager {
    constructor() {
        this.tessellator = null;
        this.cached_tessellated = new WeakMap();
    }

    init_tessellator() {
        if (!this.tessellator && window.penTessellator) {
            this.tessellator = window.penTessellator;
        }
    }
    
    reset() {
        this.cached_tessellated = new WeakMap();
        this.init_tessellator();
    }
    
    update_position(x, y, timestamp) {
        return 0;
    }
    
    calc_line_width(baseWidth, velocity, pressure = 0.5) {
        const speedScale = Math.max(0.4, Math.min(2.5, baseWidth / 4));
        const maxSpeed = 2.5 * speedScale;
        const minSpeed = 0.2 * speedScale;
        const clamped = Math.max(0, Math.min(1, (velocity - minSpeed) / (maxSpeed - minSpeed)));
        const eased = clamped * clamped * (3 - 2 * clamped);
        const speedFactor = 1 - eased * 0.75;
        const pressureFactor = 0.85 + (pressure * 0.3);
        return baseWidth * speedFactor * pressureFactor;
    }

    build_tessellated_stroke(stroke, mode = null) {
        this.init_tessellator();
        if (!this.tessellator) return null;
        
        const effect_mode = mode || DRAW_CONFIG.penEffectMode || 'off';
        if (effect_mode === 'off') return null;
        
        if (this.cached_tessellated.has(stroke)) {
            return this.cached_tessellated.get(stroke);
        }
        
        const points = stroke.points;
        const base_width = stroke.lineWidth || DRAW_CONFIG.penWidth;
        const color = stroke.color || DRAW_CONFIG.penColor;
        const storedWidths = stroke.storedWidths;
        
        if (!points || points.length < 1) return null;

        // 有存储宽度时：直接构建 segments，绕过 tessellator 的速度重算
        // 存储宽度来自 batch-draw 的实时计算（含真实指针时序），确保与预览完全一致
        if (storedWidths && storedWidths.length === points.length) {
            const raw = [{ x: points[0].fromX, y: points[0].fromY }];
            for (let i = 0; i < points.length; i++) {
                raw.push({ x: points[i].toX, y: points[i].toY });
            }
            if (raw.length < 2) return null;

            const segments = [];
            for (let i = 0; i < storedWidths.length; i++) {
                segments.push({
                    x1: raw[i].x, y1: raw[i].y,
                    x2: raw[i + 1].x, y2: raw[i + 1].y,
                    line_width: storedWidths[i]
                });
            }

            const result = { segments, color };
            if (result) {
                this.cached_tessellated.set(stroke, result);
            }
            return result;
        }

        // 无存储宽度：走标准 tessellator 速度重算路径
        const raw = [{ x: points[0].fromX, y: points[0].fromY }];
        for (let i = 0; i < points.length; i++) {
            raw.push({ x: points[i].toX, y: points[i].toY });
        }
        if (raw.length < 2) return null;

        const filtered = [raw[0]];
        for (let i = 1; i < raw.length; i++) {
            const prev = filtered[filtered.length - 1];
            const curr = raw[i];
            const dx = curr.x - prev.x;
            const dy = curr.y - prev.y;
            if (dx * dx + dy * dy >= 1) {
                filtered.push(curr);
            }
        }
        if (filtered.length < 2) return null;

        const input_points = filtered;
        if (input_points.length < 2) return null;

        // limited 模式回退：使用常量宽度，不经过速度重算
        if (effect_mode === 'limited') {
            const segments = [];
            for (let i = 0; i < input_points.length - 1; i++) {
                segments.push({
                    x1: input_points[i].x, y1: input_points[i].y,
                    x2: input_points[i + 1].x, y2: input_points[i + 1].y,
                    line_width: base_width
                });
            }
            if (segments.length > 0) {
                const result = { segments, color };
                this.cached_tessellated.set(stroke, result);
                return result;
            }
            return null;
        }

        const stroke_data = [];
        for (let i = 0; i < input_points.length; i++) {
            if (i === 0) {
                stroke_data.push({ fromX: input_points[i].x, fromY: input_points[i].y, toX: input_points[i].x, toY: input_points[i].y });
            } else {
                const prev = input_points[i - 1];
                stroke_data.push({ fromX: prev.x, fromY: prev.y, toX: input_points[i].x, toY: input_points[i].y });
            }
        }

        const result = this.tessellator.tessellator_build_stroke_from_stroke_data(
            { points: stroke_data, lineWidth: base_width, color },
            { density: 1, noStartTaper: stroke.noStartTaper }
        );
        
        if (result) {
            this.cached_tessellated.set(stroke, result);
        }
        return result;
    }

    render_tessellated_stroke(ctx, tessellated_stroke, scaleRatio = 1) {
        this.init_tessellator();
        if (!this.tessellator || !tessellated_stroke) return false;
        
        this.tessellator.tessellator_render_stroke(ctx, tessellated_stroke, scaleRatio);
        return true;
    }
    
    invalidate_cache() {
        this.cached_tessellated = new WeakMap();
    }
}

const realPenManager = new RealPenManager();

function main_stroke_clone(strokes, deep = false) {
    if (!strokes || strokes.length === 0) return [];
    if (deep) {
        return strokes.map(stroke => ({
            type: stroke.type,
            points: stroke.points ? stroke.points.map(p => ({ ...p })) : [],
            color: stroke.color,
            lineWidth: stroke.lineWidth,
            eraserSize: stroke.eraserSize,
            eraserSizeRaw: stroke.eraserSizeRaw,
            scale: stroke.scale,
            bounds: stroke.bounds ? { ...stroke.bounds } : undefined,
            variableWidths: stroke.variableWidths ? [...stroke.variableWidths] : null,
            storedWidths: stroke.storedWidths ? [...stroke.storedWidths] : undefined,
            noStartTaper: stroke.noStartTaper,
            savedStrokeHistory: stroke.savedStrokeHistory ? main_stroke_clone(stroke.savedStrokeHistory, true) : undefined,
            savedBaseImageURL: stroke.savedBaseImageURL
        }));
    }
    return strokes.map(stroke => ({
        type: stroke.type,
        points: stroke.points,
        color: stroke.color,
        lineWidth: stroke.lineWidth,
        eraserSize: stroke.eraserSize,
        eraserSizeRaw: stroke.eraserSizeRaw,
        scale: stroke.scale,
        bounds: stroke.bounds,
        variableWidths: stroke.variableWidths,
        storedWidths: stroke.storedWidths,
        noStartTaper: stroke.noStartTaper,
        savedStrokeHistory: stroke.savedStrokeHistory,
        savedBaseImageURL: stroke.savedBaseImageURL
    }));
}

function main_main_stroke_clone_deep(strokes) {
    return main_stroke_clone(strokes, true);
}

// StrokeQuadTree —— 四叉树空间索引，用于快速查找与脏区域相交的笔画
class StrokeQuadTree {
    constructor(boundary, capacity = 8, maxDepth = 6, depth = 0) {
        this.boundary = boundary;
        this.capacity = capacity;
        this.maxDepth = maxDepth;
        this.depth = depth;
        this.strokes = [];
        this.children = null;
    }
    
    insert(stroke) {
        if (!stroke.bounds) return false;
        
        if (!this.intersects(stroke.bounds)) return false;
        
        if (this.children) {
            return this.insert_to_children(stroke);
        }
        
        this.strokes.push(stroke);
        
        if (this.strokes.length > this.capacity && this.depth < this.maxDepth) {
            this.subdivide();
        }
        
        return true;
    }
    
    insert_to_children(stroke) {
        let inserted = false;
        for (const child of this.children) {
            if (child.insert(stroke)) {
                inserted = true;
            }
        }
        return inserted;
    }
    
    subdivide() {
        const { x, y, width, height } = this.boundary;
        const hw = width / 2;
        const hh = height / 2;
        
        this.children = [
            new StrokeQuadTree({ x, y, width: hw, height: hh }, this.capacity, this.maxDepth, this.depth + 1),
            new StrokeQuadTree({ x: x + hw, y, width: hw, height: hh }, this.capacity, this.maxDepth, this.depth + 1),
            new StrokeQuadTree({ x, y: y + hh, width: hw, height: hh }, this.capacity, this.maxDepth, this.depth + 1),
            new StrokeQuadTree({ x: x + hw, y: y + hh, width: hw, height: hh }, this.capacity, this.maxDepth, this.depth + 1)
        ];
        
        for (const stroke of this.strokes) {
            this.insert_to_children(stroke);
        }
        this.strokes = [];
    }
    
    query(range, found = new Set()) {
        if (!this.intersects(range)) return found;
        
        for (const stroke of this.strokes) {
            if (this.stroke_intersects(stroke, range)) {
                found.add(stroke);
            }
        }
        
        if (this.children) {
            for (const child of this.children) {
                child.query(range, found);
            }
        }
        
        return found;
    }
    
    intersects(bounds) {
        const padding = 5;
        const bMinX = bounds.minX != null ? bounds.minX : bounds.x;
        const bMaxX = bounds.maxX != null ? bounds.maxX : bounds.x + bounds.width;
        const bMinY = bounds.minY != null ? bounds.minY : bounds.y;
        const bMaxY = bounds.maxY != null ? bounds.maxY : bounds.y + bounds.height;
        return !(bMaxX + padding < this.boundary.x ||
                 bMinX - padding > this.boundary.x + this.boundary.width ||
                 bMaxY + padding < this.boundary.y ||
                 bMinY - padding > this.boundary.y + this.boundary.height);
    }
    
    stroke_intersects(stroke, range) {
        if (!stroke.bounds) return true;
        const padding = Math.max(stroke.lineWidth || 5, stroke.eraserSize || 5);
        return !(stroke.bounds.maxX + padding < range.x ||
                 stroke.bounds.minX - padding > range.x + range.width ||
                 stroke.bounds.maxY + padding < range.y ||
                 stroke.bounds.minY - padding > range.y + range.height);
    }
    
    clear() {
        this.strokes = [];
        this.children = null;
    }
    
    build(strokes) {
        this.clear();
        for (const stroke of strokes) {
            this.insert(stroke);
        }
    }
}

// 全局四叉树索引
let strokeQuadTree = null;

// === 全局状态 ===

let state = {
    drawMode: 'move',
    isDrawing: false,
    isDragging: false,
    isScaling: false,
    isZooming: false,         // 双指缩放进行中，用于延迟 tile/overlay 更新
    canvasX: 0,
    canvasY: 0,
    scale: 1,
    lastX: 0,
    lastY: 0,
    startDragX: 0,
    startDragY: 0,
    _pinchResidualDrag: false,
    _pinchResidualDragFingerId: null,
    startScale: 1,
    startDistanceSq: 0,
    startScaleX: 0,
    startScaleY: 0,
    startCanvasX: 0,
    startCanvasY: 0,
    startFinger0CX: 0,
    startFinger0CY: 0,

    // 弹性 overscroll 状态
    _isOverscrolling: false,
    _overscrollDisplayX: 0,
    _overscrollDisplayY: 0,

    // 惯性（动量）系统
    _gestureVx: 0,
    _gestureVy: 0,
    _lastCanvasX: 0,
    _lastCanvasY: 0,
    _momentumRaf: null,

    strokeHistory: [],
    baseImageURL: null,
    baseImageObj: null,
    baseImageLoadId: 0,
    currentStroke: null,
    moveBound: {
        minX: 0, maxX: 0,
        minY: 0, maxY: 0
    },
    currentImage: null,
    imageList: [],
    currentImageIndex: -1,
    fileList: [],
    currentFolderIndex: -1,
    currentFolderPageIndex: -1,
    pdfDocuments: new Map(),
    loadedPages: new Set(),
    currentPressure: 0.5,
    currentVelocity: 0,
    currentLineWidth: 0,
    lastLineWidth: 0,
    settingsOpen: false
};

const MAX_PDF_CACHE = 10;

// === 源ID管理系统 ===
// 统一管理所有源（摄像头、图片、文档）的缩放和批注数据

let sourceIdCounters = {
    pic: 0,
    doc: 0
};

function main_calculate_md5(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const original_len = data.length;
    const padded_len = (((original_len + 8) >> 6) + 1) << 6;
    const buffer = new Uint8Array(padded_len);
    buffer.set(data);
    buffer[original_len] = 0x80;

    const bit_len = original_len * 8;
    for (let i = 0; i < 8; i++) {
        buffer[padded_len - 8 + i] = Math.floor(bit_len / Math.pow(256, i)) & 0xff;
    }

    const shifts = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const table = Array.from({ length: 64 }, (_, i) =>
        Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
    );

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    const add32 = (a, b) => (a + b) >>> 0;
    const left_rotate = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;

    for (let offset = 0; offset < padded_len; offset += 64) {
        const m = new Uint32Array(16);
        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            m[i] = (buffer[j] | (buffer[j + 1] << 8) | (buffer[j + 2] << 16) | (buffer[j + 3] << 24)) >>> 0;
        }

        let a = a0;
        let b = b0;
        let c = c0;
        let d = d0;

        for (let i = 0; i < 64; i++) {
            let f;
            let g;
            if (i < 16) {
                f = (b & c) | (~b & d);
                g = i;
            } else if (i < 32) {
                f = (d & b) | (~d & c);
                g = (5 * i + 1) % 16;
            } else if (i < 48) {
                f = b ^ c ^ d;
                g = (3 * i + 5) % 16;
            } else {
                f = c ^ (b | ~d);
                g = (7 * i) % 16;
            }
            const tmp = d;
            d = c;
            c = b;
            b = add32(b, left_rotate(add32(add32(a, f >>> 0), add32(table[i], m[g])), shifts[i]));
            a = tmp;
        }

        a0 = add32(a0, a);
        b0 = add32(b0, b);
        c0 = add32(c0, c);
        d0 = add32(d0, d);
    }

    const word_to_hex = (word) => {
        let out = '';
        for (let i = 0; i < 4; i++) {
            out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
        }
        return out;
    };

    return word_to_hex(a0) + word_to_hex(b0) + word_to_hex(c0) + word_to_hex(d0);
}

let currentSourceId = null;

let sourceDataStore = {};

const MAX_SOURCE_CACHE = 50;

// 生成源ID
function main_create_source_id(type, pageIndex = null) {
    if (type === 'cam') {
        return 'cam';
    } else if (type === 'pic') {
        sourceIdCounters.pic++;
        return `pic-${sourceIdCounters.pic}`;
    } else if (type === 'doc') {
        if (pageIndex !== null && pageIndex !== undefined) {
            return `doc-${sourceIdCounters.doc}-${pageIndex}`;
        } else {
            console.error('[错误] main_create_source_id: 文档类型必须提供pageIndex参数');
            sourceIdCounters.doc++;
            return `doc-${sourceIdCounters.doc}-unknown`;
        }
    }
    
    console.error(`[错误] main_create_source_id: 未知的类型参数: ${type}`);
    return `unknown-${Date.now()}`;
}

// 保存当前源数据
function main_save_current_source_data() {
    if (!currentSourceId) return;
    
    const keys = Object.keys(sourceDataStore);
    if (keys.length >= MAX_SOURCE_CACHE && !sourceDataStore[currentSourceId]) {
        let oldestKey = null;
        let oldestTime = Infinity;
        
        for (const key of keys) {
            if (sourceDataStore[key].timestamp < oldestTime) {
                oldestTime = sourceDataStore[key].timestamp;
                oldestKey = key;
            }
        }
        
        if (oldestKey) {
            delete sourceDataStore[oldestKey];
            console.log(`[源管理] 缓存已满,移除最旧的源: ${oldestKey}`);
        }
    }
    
    sourceDataStore[currentSourceId] = {
        scale: state.scale,
        canvasX: state.canvasX,
        canvasY: state.canvasY,
        strokeHistory: main_main_stroke_clone_deep(state.strokeHistory),
        baseImageURL: state.baseImageURL,
        timestamp: Date.now()
    };
    
    console.log(`[源管理] 保存数据: ${currentSourceId}, 缩放: ${state.scale.toFixed(2)}, 笔画: ${state.strokeHistory.length}`);
}

// 加载指定源数据
function main_load_source_data(sourceId) {
    if (!sourceId) {
        console.warn('[源管理] main_load_source_data: sourceId为空,跳过加载');
        return;
    }
    
    const data = sourceDataStore[sourceId];
    if (data) {
        state.scale = data.scale || 1;
        state.canvasX = data.canvasX || -(DRAW_CONFIG.canvasW - DRAW_CONFIG.screenW) / 2;
        state.canvasY = data.canvasY || -(DRAW_CONFIG.canvasH - DRAW_CONFIG.screenH) / 2;
        state.strokeHistory = main_main_stroke_clone_deep(data.strokeHistory || []);
        state.baseImageURL = data.baseImageURL || null;
        state.baseImageObj = null;
        history_delete_all();
        
        data.timestamp = Date.now();
        
        console.log(`[源管理] 加载数据: ${sourceId}, 缩放: ${state.scale.toFixed(2)}, 笔画: ${state.strokeHistory.length}`);
    } else {
        // 新源，使用默认值
        state.scale = 1;
        state.canvasX = -(DRAW_CONFIG.canvasW - DRAW_CONFIG.screenW) / 2;
        state.canvasY = -(DRAW_CONFIG.canvasH - DRAW_CONFIG.screenH) / 2;
        state.strokeHistory = [];
        state.baseImageURL = null;
        state.baseImageObj = null;
        history_delete_all();
        
        console.log(`[源管理] 新源初始化: ${sourceId}`);
    }
    
    currentSourceId = sourceId;
}

// 切换到新源：保存当前源 → 加载目标源 → 重绘 → 刷新UI
async function main_update_source(newSourceId) {
    main_save_current_source_data();
    main_load_source_data(newSourceId);
    main_delete_draw_canvas();
    if (state.strokeHistory.length > 0) {
        await main_render_all_strokes();
    }
    main_update_move_bound();
    main_update_canvas_position();
    main_update_canvas_transform();
    main_update_history_button_status();
}

let dom = {};  // DOM 元素引用缓存

// 将 dom 暴露到全局，供 batch-draw.js 使用
window.dom = dom;
window.state = state;

const historyCompactor = createHistoryCompactor({
    state,
    cloneStrokeDeep: (strokes) => main_main_stroke_clone_deep(strokes),
    fetchOffscreenCanvas: () => main_fetch_offscreen_canvas(),
    releaseOffscreenCanvas: (c) => main_release_offscreen_canvas(c),
    renderAllStrokes: (bounds) => main_render_all_strokes(bounds),
    loadBaseImage: (url) => main_load_base_image(url),
    safeScaleFn: main_fetch_safe_scale,
    penManager: () => realPenManager,
    historyValidateCompact: history_validate_compact,
    historyFetchUndoStack: history_fetch_undo_stack,
    historyFetchCommandsToCompact: history_fetch_commands_to_compact,
    historyFormatCompact: history_format_compact,
    SnapshotCommand,
});

let cachedCanvasRect = null;
let cachedVisibleRect = null;
let cachedVisibleRectScale = null;
let cachedVisibleRectX = null;
let cachedVisibleRectY = null;

const OFFSCREEN_MAX_PHYSICAL = 3840;
const OFFSCREEN_POOL_MAX = 2;
const OFFSCREEN_POOL_IDLE_MS = 30000;
const _offscreenPool = [];
let _offscreenPoolTimer = null;

function main_clear_offscreen_pool() {
    for (const entry of _offscreenPool) {
        entry.canvas = null;
        entry.ctx = null;
    }
    _offscreenPool.length = 0;
}

function main_schedule_offscreen_pool_evict() {
    clearTimeout(_offscreenPoolTimer);
    _offscreenPoolTimer = setTimeout(() => {
        _offscreenPoolTimer = null;
        main_clear_offscreen_pool();
    }, OFFSCREEN_POOL_IDLE_MS);
}

function main_fetch_offscreen_canvas() {
    clearTimeout(_offscreenPoolTimer);
    let w = DRAW_CONFIG.canvasW * DRAW_CONFIG.dpr;
    let h = DRAW_CONFIG.canvasH * DRAW_CONFIG.dpr;
    if (w > OFFSCREEN_MAX_PHYSICAL || h > OFFSCREEN_MAX_PHYSICAL) {
        const s = OFFSCREEN_MAX_PHYSICAL / Math.max(w, h);
        w = Math.round(w * s);
        h = Math.round(h * s);
    }
    let entry;
    for (let i = _offscreenPool.length - 1; i >= 0; i--) {
        if (_offscreenPool[i].canvas.width >= w && _offscreenPool[i].canvas.height >= h) {
            entry = _offscreenPool.splice(i, 1)[0];
            break;
        }
    }
    if (!entry) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { alpha: true });
        entry = { canvas, ctx };
    }
    entry.canvas.width = w;
    entry.canvas.height = h;
    entry.ctx.setTransform(1, 0, 0, 1, 0, 0);
    entry.ctx.scale(w / DRAW_CONFIG.canvasW, h / DRAW_CONFIG.canvasH);
    return entry;
}

function main_release_offscreen_canvas(offscreen) {
    if (_offscreenPool.length < OFFSCREEN_POOL_MAX) {
        _offscreenPool.push(offscreen);
    }
    main_schedule_offscreen_pool_evict();
}

function main_delete_cached_rect() {
    cachedCanvasRect = null;
}

function main_fetch_cached_canvas_rect() {
    if (!cachedCanvasRect) {
        cachedCanvasRect = dom.canvasContainer.getBoundingClientRect();
    }
    return cachedCanvasRect;
}

// 监听系统关联打开的PDF文件
function main_setup_pdf_file_open() {
    if (!window.__TAURI__) {
        console.log('非 Tauri 环境，跳过文件打开监听');
        return;
    }
    
    console.log('开始注册文件打开事件监听...');
    
    const { listen } = window.__TAURI__.event;
    
    listen('file-opened', (event) => {
        console.log('========== 收到文件打开事件 ==========');
        console.log('完整事件对象:', JSON.stringify(event, null, 2));
        console.log('Payload 类型:', typeof event.payload);
        console.log('Payload 内容:', event.payload);
        
        let filePath = event.payload;
        
        if (typeof filePath === 'string') {
            if (filePath.startsWith('file://')) {
                filePath = decodeURIComponent(filePath.replace('file://', ''));
            }
            console.log('最终文件路径:', filePath);
            main_load_pdf_from_path(filePath, true);
        } else {
            console.error('无法解析文件路径，payload:', event.payload);
            main_show_error_dialog(
                window.i18n?.format_translate('errors.fileError') || '文件错误',
                window.i18n?.format_translate('errors.fileParseError') || '无法解析文件路径'
            );
        }
    }).then(() => {
        console.log('file-opened 事件监听注册成功');
    }).catch(err => {
        console.error('注册 file-opened 事件监听失败:', err);
    });
    
    listen('opener://open-file', (event) => {
        console.log('========== 收到 opener 事件 ==========');
        console.log('完整事件对象:', JSON.stringify(event, null, 2));
        
        let filePath = null;
        
        if (typeof event.payload === 'string') {
            filePath = event.payload;
        } else if (event.payload && typeof event.payload === 'object') {
            filePath = event.payload.path || event.payload.url || event.payload.filePath || event.payload.uri;
        }
        
        if (filePath) {
            if (filePath.startsWith('file://')) {
                filePath = decodeURIComponent(filePath.replace('file://', ''));
            }
            console.log('最终文件路径:', filePath);
            main_load_pdf_from_path(filePath, true);
        }
    }).catch(err => {
        console.log('opener 事件监听可选:', err);
    });
    
    listen('settings-changed', (event) => {
        const settings = event.payload;
        console.log('收到设置更改通知:', settings);
        
        if (settings.dynamicDprEnabled !== undefined) {
            DRAW_CONFIG.dynamicDprEnabled = settings.dynamicDprEnabled;
        }
        if (settings.dprMin !== undefined) {
            DRAW_CONFIG.dprMin = settings.dprMin;
        }
        if (settings.dprMax !== undefined) {
            DRAW_CONFIG.dprMax = settings.dprMax;
        }
        if (settings.dprStep !== undefined) {
            DRAW_CONFIG.dprStep = settings.dprStep;
        }
        if (settings.overlayDpr !== undefined) {
            DRAW_CONFIG.overlayDpr = settings.overlayDpr;
        }
        if (settings.dynamicDprEnabled !== undefined || settings.dprMin !== undefined ||
            settings.dprMax !== undefined || settings.dprStep !== undefined ||
            settings.overlayDpr !== undefined) {
            if (window.tileRenderer) {
                window.tileRenderer.update_visible_tile_dpr(state.scale, true, true);
            }
            if (window.batchDrawManager) {
                window.batchDrawManager.update_overlay_dpr(state.scale, true);
            }
            // 同步阅读器和黑板
            window.sync_all_overlay_dpr?.();
        }

        if (settings.penColors && Array.isArray(settings.penColors)) {
            DRAW_CONFIG.penColors = settings.penColors.map(color => {
                if (typeof color === 'object' && color.r !== undefined) {
                    return main_calc_rgb_to_hex(color.r, color.g, color.b);
                }
                return color;
            });
            main_update_color_buttons();
            console.log('画笔颜色已更改:', DRAW_CONFIG.penColors);
        }
        
        if (settings.penWidth !== undefined) {
            DRAW_CONFIG.penWidth = settings.penWidth;
        }
        if (settings.eraserSize !== undefined) {
            DRAW_CONFIG.eraserSize = settings.eraserSize;
            if (window.blackboardManager?.drawing_engine) {
                window.blackboardManager.drawing_engine.refresh_eraser_hint_size();
            }
        }
        
        if (settings.penSizePresets && Array.isArray(settings.penSizePresets)) {
            DRAW_CONFIG.penSizePresets = settings.penSizePresets;
            console.log('画笔预设已更改:', settings.penSizePresets);
        }
        
        if (settings.eraserSizePresets && Array.isArray(settings.eraserSizePresets)) {
            DRAW_CONFIG.eraserSizePresets = settings.eraserSizePresets;
            if (window.blackboardManager?.drawing_engine) {
                window.blackboardManager.drawing_engine.refresh_eraser_hint_size();
            }
            console.log('橡皮擦预设已更改:', settings.eraserSizePresets);
        }
        
        if (settings.theme !== undefined) {
            ThemeManager.theme_update_active(settings.theme).then(() => {
                const canvasBgColor = ThemeManager.theme_fetch_canvas_bg_color();
                DRAW_CONFIG.canvasBgColor = canvasBgColor;
                main_update_canvas_bg_color(canvasBgColor);
                
                console.log('主题已更改:', settings.theme);
            });
        }


        if (settings.penMinWidthRatio !== undefined && DRAW_CONFIG.developerMode) {
            DRAW_CONFIG.penMinWidthRatio = settings.penMinWidthRatio;
        }
        if (settings.maxScaleImage !== undefined && DRAW_CONFIG.developerMode) {
            DRAW_CONFIG.maxScaleImage = settings.maxScaleImage;
        }
        if (settings.gestureFrameDelta !== undefined && DRAW_CONFIG.developerMode) {
            DRAW_CONFIG.gestureFrameDelta = settings.gestureFrameDelta;
        }

        // 性能监视器动态开关（仅在开发者模式下生效）
        if (settings.perfMonitorEnabled !== undefined && DRAW_CONFIG.developerMode) {
            DRAW_CONFIG.perfMonitorEnabled = settings.perfMonitorEnabled;
            const interval = settings.perfMonitorInterval || 200;
            if (settings.perfMonitorEnabled) {
                if (!window.perfMonitor) {
                    import('./modules/developer/perf-monitor.js').then(mod => {
                        window.perfMonitor = mod;
                        mod.perf_monitor_init(interval);
                    }).catch(e => {
                        console.error('动态加载 perf monitor 失败:', e);
                    });
                } else {
                    window.perfMonitor.perf_monitor_set_enabled(true, interval);
                }
            } else {
                if (window.perfMonitor) {
                    window.perfMonitor.perf_monitor_set_enabled(false);
                }
            }
        } else if (settings.perfMonitorInterval !== undefined && DRAW_CONFIG.developerMode && window.perfMonitor) {
            // 仅更新频率（不改变开关状态）
            window.perfMonitor.perf_monitor_set_interval(settings.perfMonitorInterval);
        }
    }).catch(err => {
        console.error('settings-changed 事件监听失败:', err);
    });
    
}

async function main_render_pdf_pages_lazy(pdf, totalPages, initialPages = 3, docNumber = null) {
    return DocLoader.render_pdf_pages_lazy(pdf, totalPages, initialPages, docNumber);
}

const PDF_INITIAL_RENDER_PAGES = 20;

async function main_load_pdf_from_path(filePath, autoOpen = false) {
    if (currentSourceId) {
        main_save_current_source_data();
    }
    
    console.log('开始加载文件:', filePath);
    
    const fileName_lower = filePath.toLowerCase();
    const isWord = fileName_lower.endsWith('.docx') || fileName_lower.endsWith('.doc');
    
    // 检查是否已打开
    function main_check_file_open(md5) {
        const found = state.fileList.findIndex(f => f && f.fileMd5 === md5);
        if (found !== -1) {
            console.log('文件已打开，切换到已有标签:', found);
            if (autoOpen) {
                main_switch_to_tab(found);
            }
            return true;
        }
        return false;
    }
    
    if (isWord) {
        main_show_loading_overlay(window.i18n?.format_translate('loading.detectingOffice') || '正在检测 Office 软件...');
        
        const { invoke } = window.__TAURI__.core;
        const { fs } = window.__TAURI__;
        
        let detection;
        try {
            detection = await invoke('office_detect_all');
            console.log('Office 检测结果:', detection);
            if (detection.recommended === 'None') {
                main_hide_loading_overlay();
                main_show_error_dialog(
                    window.i18n?.format_translate('errors.officeNotInstalled') || 'Office 未安装',
                    window.i18n?.format_translate('errors.officeNotInstalledDesc') || '未检测到可用的 Office 软件\n\n请安装以下软件之一：\n• Microsoft Word\n• WPS Office\n• LibreOffice\n\n或将 Word 文档另存为 PDF 后导入'
                );
    
                return;
            }
        } catch (e) {
            main_hide_loading_overlay();
            console.log('检测 Office 失败:', e);
            main_show_error_dialog(
                window.i18n?.format_translate('errors.officeDetectFailed') || '检测失败',
                window.i18n?.format_translate('errors.officeDetectFailedDesc') || '检测 Office 软件失败，请重试'
            );

            return;
        }
        
        main_update_loading_progress(window.i18n?.format_translate('loading.readingFile') || '正在读取文件...');
        
        let fileData;
        try {
            fileData = await fs.readFile(filePath);
        } catch (readError) {
            main_hide_loading_overlay();
            console.error('文件读取失败:', readError);
            main_show_error_dialog(
                window.i18n?.format_translate('errors.readFailed') || '读取失败',
                window.i18n?.format_translate('errors.readFailedDesc') || '无法读取文件'
            );

            return;
        }
        
        let uint8Array;
        if (Array.isArray(fileData)) {
            uint8Array = new Uint8Array(fileData);
        } else {
            uint8Array = new Uint8Array(fileData);
        }
        
        console.log('文件大小:', uint8Array.length, '字节');
        const fileMd5 = main_calculate_md5(uint8Array);
        if (main_check_file_open(fileMd5)) {
            main_hide_loading_overlay();
            return;
        }
        
        main_update_loading_progress(window.i18n?.format_translate('loading.processingWord') || '正在处理 Word 文档...');
        
        const fileName = filePath.split(/[\\/]/).pop();
        const fileDataForConvert = Array.from(uint8Array);
        fileData = null;
        uint8Array = null;
        
        let pdfPath = null;
        try {
            pdfPath = await invoke('office_convert_docx_to_pdf_bytes', {
                fileData: fileDataForConvert,
                fileName: fileName,
                fileMd5: fileMd5
            });
            console.log('Word 文档已转换为 PDF:', pdfPath);
        } catch (convertError) {
            main_hide_loading_overlay();
            console.error('Word 转换失败:', convertError);
            const errorMsg = String(convertError);
            let friendlyMsg = window.i18n?.format_translate('errors.wordConvertFailed') || 'Word 文档转换失败';
            
            if (errorMsg.includes('Office') || errorMsg.includes('Word') || errorMsg.includes('WPS')) {
                friendlyMsg = window.i18n?.format_translate('errors.officeCallFailed') || 'Office 软件调用失败\n\n可能的原因：\n• Office 软件未正确安装\n• 文件被其他程序占用\n• 文件格式不支持';
            }
            
            main_show_error_dialog(
                window.i18n?.format_translate('errors.convertFailed') || '转换失败',
                friendlyMsg,
                () => {
                    main_load_pdf_from_path(filePath);
                }
            );

            return;
        }
        
        main_update_loading_progress(window.i18n?.format_translate('loading.renderingPage') || '正在渲染页面...');
        
        try {
            const pdfReady = await main_wait_pdfjs();
            if (!pdfReady) {
                main_hide_loading_overlay();
                console.error('PDF.js 库加载超时');
                main_show_error_dialog(
                    window.i18n?.format_translate('errors.loadFailed') || '加载失败',
                    window.i18n?.format_translate('errors.pdfLoadTimeout') || 'PDF 库加载超时\n\n请重启应用后重试'
                );
    
                return;
            }
            
            let pdfBytes = await fs.readFile(pdfPath);
            let pdfArrayBuffer = pdfBytes.buffer;
            const pdf = await pdfjsLib.getDocument({
                data: pdfArrayBuffer,
                enableXfa: false,
                useSystemFonts: false,
                isEvalSupported: false
            }).promise;
            pdfBytes = null;
            pdfArrayBuffer = null;
            console.log('PDF加载成功，页数:', pdf.numPages);
            
            const totalPages = pdf.numPages;
            const fileName = filePath.split(/[/\\]/).pop().replace(/\.(pdf|docx|doc)$/i, '');
            const docNumber = sourceIdCounters.doc++;
            
            const folder = {
                name: fileName,
                pages: [],
                isPdf: true,
                pdfDoc: pdf,
                totalPages: totalPages,
                docNumber: docNumber,
                fileMd5: fileMd5
            };
            
            if (state.pdfDocuments.size >= MAX_PDF_CACHE) {
                const firstKey = state.pdfDocuments.keys().next().value;
                main_delete_pdf_blob_urls(firstKey);
                state.pdfDocuments.delete(firstKey);
                console.log(`[PDF缓存] 缓存已满,移除文档: ${firstKey}`);
            }
            
            state.pdfDocuments.set(docNumber, pdf);
            
            const processedPages = await main_render_pdf_pages_lazy(pdf, totalPages, PDF_INITIAL_RENDER_PAGES, docNumber);
            folder.pages = processedPages;
            
            state.fileList.push(folder);
            
            main_hide_loading_overlay();
            console.log(`文件已导入: ${folder.name}，共${folder.pages.length}页`);

            // 保存到最近打开文件列表
            window.main_add_recent_file?.(filePath);
            
            if (autoOpen && window.documentReaderManager) {
                const fileIndex = state.fileList.length - 1;
                window.documentReaderManager.open(fileIndex);
            }
            
            
            
        } catch (error) {
            main_hide_loading_overlay();
            console.error('文件导入失败:', error);
            main_show_error_dialog(
                window.i18n?.format_translate('errors.importFailed') || '导入失败',
                window.i18n?.format_translate('errors.importFailedDesc') || '文件导入失败，请确保文件格式正确'
            );

        }
        
        return;
    }
    
    main_show_loading_overlay(window.i18n?.format_translate('loading.importingFile') || '正在导入文件...');
    
    try {
        const pdfReady = await main_wait_pdfjs();
        if (!pdfReady) {
            main_hide_loading_overlay();
            console.error('PDF.js 库加载超时');
            main_show_error_dialog(
                window.i18n?.format_translate('errors.loadFailed') || '加载失败',
                window.i18n?.format_translate('errors.pdfLoadTimeout') || 'PDF 库加载超时\n\n请重启应用后重试'
            );

            return;
        }
        
        const { fs } = window.__TAURI__;
        
        let fileData;
        try {
            fileData = await fs.readFile(filePath);
            console.log('文件读取成功，数据类型:', typeof fileData, '是否数组:', Array.isArray(fileData));
        } catch (readError) {
            console.error('文件读取失败:', readError);
            main_hide_loading_overlay();
            main_show_error_dialog(
                window.i18n?.format_translate('errors.readFailed') || '读取失败',
                window.i18n?.format_translate('errors.readFailedDesc') || '无法读取文件'
            );

            return;
        }
        
        let uint8Array;
        if (Array.isArray(fileData)) {
            uint8Array = new Uint8Array(fileData);
        } else if (fileData instanceof ArrayBuffer) {
            uint8Array = new Uint8Array(fileData);
        } else {
            uint8Array = new Uint8Array(fileData);
        }
        
        console.log('PDF数据大小:', uint8Array.length);

        // PDF 解析（Worker 线程）与 MD5（主线程）并发执行
        const pdfPromise = pdfjsLib.getDocument({
            data: uint8Array,
            enableXfa: false,
            useSystemFonts: false,
            isEvalSupported: false
        }).promise;
        const fileMd5 = main_calculate_md5(uint8Array);
        if (main_check_file_open(fileMd5)) {
            fileData = null;
            uint8Array = null;
            main_hide_loading_overlay();
            return;
        }
        const pdf = await pdfPromise;
        fileData = null;
        uint8Array = null;
        console.log('PDF加载成功，页数:', pdf.numPages);
        
        const totalPages = pdf.numPages;
        const fileName = filePath.split(/[/\\]/).pop().replace(/\.(pdf|docx|doc)$/i, '');
        const docNumber = sourceIdCounters.doc++;
        
        const folder = {
            name: fileName,
            pages: [],
            isWord: false,
            pdfDoc: pdf,
            totalPages: totalPages,
            docNumber: docNumber,
            fileMd5: fileMd5
        };
        
        const processedPages = await main_render_pdf_pages_lazy(pdf, totalPages, PDF_INITIAL_RENDER_PAGES, docNumber);
        folder.pages = processedPages;
        
        state.fileList.push(folder);
        
        main_hide_loading_overlay();
        console.log(`文件已导入: ${folder.name}，共${folder.pages.length}页`);

        // 保存到最近打开文件列表
        window.main_add_recent_file?.(filePath);
        
        if (autoOpen && window.documentReaderManager) {
            const fileIndex = state.fileList.length - 1;
            window.documentReaderManager.open(fileIndex);
        }
    } catch (error) {
        main_hide_loading_overlay();
        console.error('文件导入失败:', error);
        main_show_error_dialog(
            window.i18n?.format_translate('errors.importFailed') || '导入失败',
            window.i18n?.format_translate('errors.importFailedDesc') || '文件导入失败，请确保文件格式正确'
        );
    }
}

// 处理窗口大小变化（防抖 150ms）
let resizeTimeout = null;

function main_handle_resize() {
    main_delete_cached_rect();
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        resizeTimeout = null;
        const container = dom.canvasContainer;
    const newScreenW = Math.max(1, container.clientWidth);
    const newScreenH = Math.max(1, container.clientHeight);
        
        if (newScreenW !== DRAW_CONFIG.screenW || newScreenH !== DRAW_CONFIG.screenH) {
            main_update_canvas_size(newScreenW, newScreenH);
        }
    }, 150);
}

// 调整画布大小
async function main_update_canvas_size(newScreenW, newScreenH) {
    const oldScale = state.scale;
    const oldCanvasX = state.canvasX;
    const oldCanvasY = state.canvasY;
    
    if (window.tileRenderer) {
        window.tileRenderer.destroy_all();
    }
    
    DRAW_CONFIG.screenW = Math.max(1, newScreenW);
    DRAW_CONFIG.screenH = Math.max(1, newScreenH);
    
    DRAW_CONFIG.canvasW = Math.max(1, Math.floor(newScreenW * 2));
    DRAW_CONFIG.canvasH = Math.max(1, Math.floor(newScreenH * 2));
    
    DRAW_CONFIG.dpr = window.main_calc_capped_dpr(DRAW_CONFIG.baseDpr, DRAW_CONFIG.dprLimit);
    
    main_update_move_bound();
    
    if (dom.imageElement) {
        dom.imageElement.style.width = DRAW_CONFIG.canvasW + 'px';
        dom.imageElement.style.height = DRAW_CONFIG.canvasH + 'px';
    }
    if (dom.canvasWrapper) {
        dom.canvasWrapper.style.width = DRAW_CONFIG.canvasW + 'px';
        dom.canvasWrapper.style.height = DRAW_CONFIG.canvasH + 'px';
    }
    
    // 初始化瓦片渲染器
    if (window.tileRenderer && dom.canvasWrapper) {
        window.tileRenderer.init_tiles(dom.canvasWrapper);
    }
    
    if (window.batchDrawManager) {
        window.batchDrawManager.resize_overlay(newScreenW, newScreenH, DRAW_CONFIG.dpr);
    }
    
    if (state.currentImage) {
        main_render_image_centered(state.currentImage);
    }
    
    if (state.strokeHistory.length > 0 || state.baseImageObj) {
        await main_render_all_strokes();
    }
    
    state.scale = oldScale;
    state.canvasX = oldCanvasX;
    state.canvasY = oldCanvasY;
    
    main_update_move_bound();
    main_update_canvas_position();
    main_update_canvas_transform();
    
    console.log(`窗口调整: 屏幕 ${newScreenW}x${newScreenH}, 画布 ${DRAW_CONFIG.canvasW}x${DRAW_CONFIG.canvasH}, DPR ${DRAW_CONFIG.dpr.toFixed(2)}`);
}

// 更新画布背景颜色
function main_update_canvas_bg_color(color) {
    if (dom.canvasContainer) {
        dom.canvasContainer.style.backgroundColor = color;
    }
    if (dom.canvasWrapper) {
        dom.canvasWrapper.style.backgroundColor = color;
    }
}

let cachedMoveBoundScale = null;

function main_update_move_bound() {
    if (cachedMoveBoundScale === state.scale) {
        return;
    }
    cachedMoveBoundScale = state.scale;
    
    const screenW = DRAW_CONFIG.screenW;
    const screenH = DRAW_CONFIG.screenH;
    const scaledW = DRAW_CONFIG.canvasW * state.scale;
    const scaledH = DRAW_CONFIG.canvasH * state.scale;
    
    if (scaledW >= screenW) {
        state.moveBound.minX = -(scaledW - screenW);
        state.moveBound.maxX = 0;
    } else {
        state.moveBound.minX = (screenW - scaledW) / 2;
        state.moveBound.maxX = (screenW - scaledW) / 2;
    }
    
    if (scaledH >= screenH) {
        state.moveBound.minY = -(scaledH - screenH);
        state.moveBound.maxY = 0;
    } else {
        state.moveBound.minY = (screenH - scaledH) / 2;
        state.moveBound.maxY = (screenH - scaledH) / 2;
    }
}

function main_update_canvas_position() {
    const eps = 0.001;
    state.canvasX = Math.max(state.moveBound.minX - eps, Math.min(state.moveBound.maxX + eps, state.canvasX));
    state.canvasY = Math.max(state.moveBound.minY - eps, Math.min(state.moveBound.maxY + eps, state.canvasY));
}

function main_fetch_visible_rect() {
    if (cachedVisibleRectScale === state.scale && 
        cachedVisibleRectX === state.canvasX && 
        cachedVisibleRectY === state.canvasY && 
        cachedVisibleRect) {
        return cachedVisibleRect;
    }
    
    cachedVisibleRectScale = state.scale;
    cachedVisibleRectX = state.canvasX;
    cachedVisibleRectY = state.canvasY;
    
    // 确保缩放系数 > 0，防止除以零
    const scale = Math.max(0.01, state.scale || 1);
    const screenW = DRAW_CONFIG.screenW || 1;
    const screenH = DRAW_CONFIG.screenH || 1;
    
    let visibleX = Math.max(0, -state.canvasX / scale);
    let visibleY = Math.max(0, -state.canvasY / scale);
    let visibleW = Math.min(DRAW_CONFIG.canvasW - visibleX, screenW / scale);
    let visibleH = Math.min(DRAW_CONFIG.canvasH - visibleY, screenH / scale);
    
    const padding = 10;
    visibleX = Math.max(0, visibleX - padding);
    visibleY = Math.max(0, visibleY - padding);
    visibleW = Math.min(DRAW_CONFIG.canvasW - visibleX, visibleW + padding * 2);
    visibleH = Math.min(DRAW_CONFIG.canvasH - visibleY, visibleH + padding * 2);
    
    cachedVisibleRect = {
        x: visibleX,
        y: visibleY,
        width: visibleW,
        height: visibleH
    };
    
    return cachedVisibleRect;
}

function main_update_color_buttons() {
    const panel = document.querySelector('.pen-control-panel');
    if (!panel) return;
    const mode = panel.dataset.mode;
    if (mode === 'comment') {
        panel.querySelectorAll('.pen-color-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.color === DRAW_CONFIG.penColor);
        });
    }
    const currentSize = mode === 'eraser' ? DRAW_CONFIG.eraserSize : DRAW_CONFIG.penWidth;
    panel.querySelectorAll('.size-preset-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.size) === currentSize);
    });
    const label = panel.querySelector('.pen-size-label');
    if (label) label.textContent = currentSize + 'px';
}

function main_show_pen_control_panel(triggerBtn, mode) {
    let panel = document.querySelector('.pen-control-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'pen-control-panel';
        panel.innerHTML = `
            <div class="pen-color-buttons" id="penPanelColors"></div>
            <div class="pen-size-presets" id="penPanelSizes"></div>
            <span class="pen-size-label" id="penPanelSizeLabel"></span>
            <div class="eraser-clear-sep" id="eraserClearSep"></div>
            <div class="eraser-clear-track" id="eraserClearTrack">
                <input type="range" min="0" max="100" value="0" class="eraser-clear-slider" id="eraserClearSlider">
                <span class="eraser-hint-text" id="eraserHintText">拖动清空笔迹</span>
            </div>
        `;
        document.body.appendChild(panel);

        const clearSlider = panel.querySelector('.eraser-clear-slider');
        const hintText = panel.querySelector('.eraser-hint-text');
        if (clearSlider) {
            clearSlider.addEventListener('input', () => {
                const pct = clearSlider.value;
                clearSlider.style.setProperty('--fill', pct + '%');
                if (hintText) hintText.classList.toggle('hidden', pct !== '0');
                if (pct === '100') {
                    if (window.blackboardManager?.is_open) {
                        window.blackboardManager.handle_clear();
                    } else if (window.documentReaderManager?.is_open) {
                        window.documentReaderManager.handle_clear();
                    } else {
                        main_delete_all_drawings();
                    }
                    clearSlider.value = '0';
                    clearSlider.style.setProperty('--fill', '0%');
                }
            });
            clearSlider.addEventListener('pointerup', () => {
                if (clearSlider.value === '100') return;
                clearSlider.value = '0';
                clearSlider.style.setProperty('--fill', '0%');
                if (hintText) hintText.classList.remove('hidden');
            });
            clearSlider.style.setProperty('--fill', '0%');
        }

        document.addEventListener('mousedown', (e) => {
            if (panel.classList.contains('visible') && !panel.contains(e.target)) {
                const triggerEl = document.getElementById(panel.dataset.triggerId);
                if (triggerEl && !triggerEl.contains(e.target)) {
                    panel.classList.remove('visible');
                }
            }
        }, true);
    }

    if (panel.classList.contains('visible') && panel.dataset.triggerId === triggerBtn.id) {
        panel.classList.remove('visible');
        return;
    }

    panel.dataset.mode = mode;
    panel.dataset.triggerId = triggerBtn.id;

    const colorContainer = panel.querySelector('.pen-color-buttons');
    const sizeContainer = panel.querySelector('.pen-size-presets');
    const sizeLabel = panel.querySelector('.pen-size-label');

    if (mode === 'comment') {
        colorContainer.style.display = '';
        colorContainer.innerHTML = '';
        const colors = DRAW_CONFIG.penColors || [];
        colors.forEach((color) => {
            const btn = document.createElement('button');
            btn.className = 'pen-color-btn';
            btn.dataset.color = color;
            btn.style.background = color;
            btn.classList.toggle('active', color === DRAW_CONFIG.penColor);
            const isLight = color.toLowerCase() === '#ffffff' || color.toLowerCase() === '#fff';
            btn.classList.add(isLight ? 'light-color' : 'dark-color');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                DRAW_CONFIG.penColor = color;
                main_update_color_buttons();
                panel.classList.remove('visible');
            });
            colorContainer.appendChild(btn);
        });
    } else {
        colorContainer.style.display = 'none';
    }

    sizeContainer.innerHTML = '';
    const presets = mode === 'eraser' ? DRAW_CONFIG.eraserSizePresets : DRAW_CONFIG.penSizePresets;
    const currentSize = mode === 'eraser' ? DRAW_CONFIG.eraserSize : DRAW_CONFIG.penWidth;
    presets.forEach((size) => {
        const btn = document.createElement('button');
        btn.className = 'size-preset-btn';
        btn.dataset.size = size;
        btn.style.setProperty('--dot-size', Math.max(4, Math.min(size * 1.2, 24)) + 'px');
        const dotColor = mode === 'eraser' ? 'var(--color-muted)' : (DRAW_CONFIG.penColor || '#888');
        btn.style.setProperty('--dot-color', dotColor);
        btn.classList.toggle('active', size === currentSize);
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mode === 'eraser') {
                DRAW_CONFIG.eraserSize = size;
                if (window.blackboardManager?.drawing_engine) {
                    window.blackboardManager.drawing_engine.refresh_eraser_hint_size();
                }
            } else {
                DRAW_CONFIG.penWidth = size;
            }
            main_update_color_buttons();
            panel.classList.remove('visible');
        });
        sizeContainer.appendChild(btn);
    });

    sizeLabel.textContent = currentSize + 'px';

    const clearSep = panel.querySelector('.eraser-clear-sep');
    const clearTrack = panel.querySelector('.eraser-clear-track');
    if (clearSep && clearTrack) {
        clearSep.style.display = mode === 'eraser' ? '' : 'none';
        clearTrack.style.display = mode === 'eraser' ? '' : 'none';
    }

    const rect = triggerBtn.getBoundingClientRect();
    panel.style.left = '0px';
    panel.style.top = '0px';
    panel.classList.add('visible');
    const panelRect = panel.getBoundingClientRect();
    let left = rect.left + (rect.width - panelRect.width) / 2;
    let top = rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + panelRect.width > window.innerWidth - 8) {
        left = window.innerWidth - panelRect.width - 8;
    }
    if (top + panelRect.height > window.innerHeight - 8) {
        top = rect.top - panelRect.height - 8;
    }
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
}

function main_update_ui_state() {
    const startupScreen = document.getElementById('startupScreen');
    if (startupScreen) {
        const reader = window.documentReaderManager;
        const hasOpenDoc = window.state?.fileList?.length > 0 &&
            (reader?.is_open === true || reader?._switching === true);
        startupScreen.style.display = hasOpenDoc ? 'none' : 'flex';
    }
    main_update_tabs();
}

function main_update_tabs() {
    const tabsContainer = document.getElementById('titlebarTabs');
    if (!tabsContainer) {
        setTimeout(main_update_tabs, 200);
        return;
    }
    const fileList = state.fileList || [];
    const isReaderOpen = window.documentReaderManager?.is_open === true;

    tabsContainer.innerHTML = '';

    const settingsPanel = document.getElementById('settingsPanel');
    const settingsVisible = settingsPanel && settingsPanel.style.display === 'flex';

    const homeTab = document.createElement('button');
    homeTab.className = 'titlebar-tab';
    if (!isReaderOpen && !settingsVisible && !window.documentReaderManager?._switching) homeTab.classList.add('active');
    const homeLabel = document.createElement('span');
    homeLabel.className = 'tab-label';
    homeLabel.textContent = window.i18n?.format_translate('toolbar.home') || '主页';
    homeTab.appendChild(homeLabel);
    homeTab.addEventListener('click', () => main_switch_home());
    tabsContainer.appendChild(homeTab);

    // 设置标签
    if (state.settingsOpen) {
        const settingsTab = document.createElement('button');
        settingsTab.className = settingsVisible ? 'titlebar-tab active' : 'titlebar-tab';
        const settingsLabel = document.createElement('span');
        settingsLabel.className = 'tab-label';
        settingsLabel.textContent = '设置';
        settingsTab.appendChild(settingsLabel);
        const close = document.createElement('span');
        close.className = 'tab-close';
        close.textContent = '×';
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            main_close_settings();
        });
        settingsTab.appendChild(close);
        settingsTab.addEventListener('click', () => {
            const panel = document.getElementById('settingsPanel');
            if (!state.settingsOpen) {
                main_show_settings_window();
            } else if (panel && panel.style.display !== 'flex') {
                const drToolbar = document.getElementById('drToolbar');
                if (drToolbar) drToolbar.style.display = 'none';
                panel.style.display = 'flex';
                main_update_tabs();
            }
        });
        tabsContainer.appendChild(settingsTab);
    }

    fileList.forEach((folder, index) => {
        const tab = document.createElement('button');
        tab.className = 'titlebar-tab';
        tab.dataset.index = index;
        if (window.documentReaderManager?.folder_index === index && !settingsVisible) {
            tab.classList.add('active');
        }

        const label = document.createElement('span');
        label.className = 'tab-label';
        label.textContent = folder.name || '文档';
        tab.appendChild(label);

        const close = document.createElement('span');
        close.className = 'tab-close';
        close.textContent = '×';
        close.addEventListener('click', (e) => {
            e.stopPropagation();
            main_close_tab(index);
        });
        tab.appendChild(close);

        tab.addEventListener('click', () => main_switch_to_tab(index));
        tabsContainer.appendChild(tab);
    });
}

async function main_switch_home() {
    if (state.settingsOpen) main_hide_settings();
    if (window.documentReaderManager?.is_open) {
        await window.documentReaderManager.close();
        window.documentReaderManager.folder_index = -1;
    }
    main_update_tabs();
    main_update_ui_state();
}

function main_hide_settings() {
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.style.display = 'none';
}

async function main_switch_to_tab(index) {
    if (state.settingsOpen) main_hide_settings();
    const fileList = state.fileList || [];
    if (index < 0 || index >= fileList.length) return;
    const reader = window.documentReaderManager;
    if (!reader) return;
    if (reader.is_open && reader.folder_index === index) return;
    reader._switching = true;
    reader.folder_index = index;
    main_update_tabs();
    await reader.open(index);
    reader._switching = false;
    main_update_tabs();
    main_update_ui_state();
}

async function main_close_tab(index) {
    const fileList = state.fileList || [];
    if (index < 0 || index >= fileList.length) return;
    const reader = window.documentReaderManager;
    const isReaderOpen = reader?.is_open === true;
    if (isReaderOpen && reader?.folder_index === index) {
        await reader.close();
        reader.folder_index = -1;
    }
    const folder = fileList[index];
    if (folder?.docNumber !== undefined) {
        main_delete_pdf_blob_urls(folder.docNumber);
        state.pdfDocuments.delete(folder.docNumber);
    }
    state.fileList.splice(index, 1);
    main_update_tabs();
    main_update_ui_state();
}

function main_hide_window() {
    if (window.__TAURI__) {
        const { getCurrentWindow } = window.__TAURI__.window;
        getCurrentWindow().minimize().catch(() => {});
    }
}

function main_toggle_maximize() {
    if (window.__TAURI__) {
        const { getCurrentWindow } = window.__TAURI__.window;
        getCurrentWindow().toggleMaximize().catch(() => {});
    }
}

function main_submit_close_window() {
    if (window.__TAURI__) {
        const { getCurrentWindow } = window.__TAURI__.window;
        getCurrentWindow().close().catch(() => {});
    }
}

// 绑定所有事件
function main_setup_all_events() {
    // 标题栏按钮
    if (dom.btnTitleMinimize) dom.btnTitleMinimize.addEventListener('click', main_hide_window);
    if (dom.btnTitleMaximize) dom.btnTitleMaximize.addEventListener('click', main_toggle_maximize);
    if (dom.btnTitleClose) dom.btnTitleClose.addEventListener('click', main_submit_close_window);
    main_update_tabs();
}

// 设置笔触样式
function main_update_pen_style() {
    main_reset_context_state();
}

function main_update_eraser_style() {
    main_reset_context_state();
}

function main_update_canvas_transform() {
    if (last_canvas_transform.x === state.canvasX && 
        last_canvas_transform.y === state.canvasY && 
        last_canvas_transform.scale === state.scale) {
        return;
    }
    
    const scaleChanged = last_canvas_transform.scale !== state.scale;
    last_canvas_transform.x = state.canvasX;
    last_canvas_transform.y = state.canvasY;
    last_canvas_transform.scale = state.scale;
    
    dom.canvasWrapper.style.transform = 'translate3d(' + state.canvasX + 'px, ' + state.canvasY + 'px, 0) scale(' + state.scale + ')';

    // 仅 scale 变化时更新 tile DPR（平移/惯性期间跳过冗余调用）
    if (scaleChanged && window.tileRenderer) {
        window.tileRenderer.update_visible_tile_dpr(state.scale, false, true);
    }
    if (window.batchDrawManager) {
        window.batchDrawManager.update_overlay_dpr(state.scale);
    }
}

// 撤销功能 - 混合方案：路径记录 + ImageData 压缩
function main_start_stroke(type, eraserShape) {
    const invScale = 1 / main_fetch_safe_scale();
    const baseEraserSize = DRAW_CONFIG.eraserSize * invScale;
    state.currentStroke = {
        type: type,
        points: [],
        color: type === 'draw' ? DRAW_CONFIG.penColor : '#000000',
        lineWidth: (type === 'draw' ? DRAW_CONFIG.penWidth : DRAW_CONFIG.eraserSize) * invScale,
        eraserSize: baseEraserSize,
        eraserSizeRaw: DRAW_CONFIG.eraserSize,
        eraserShape: eraserShape || 'square',
        scale: state.scale,
        bounds: {
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity
        },
        variableWidths: []
    };
    
    state.currentPressure = 0.5;
    state.currentLineWidth = DRAW_CONFIG.penWidth * invScale;
    state.lastLineWidth = DRAW_CONFIG.penWidth * invScale;
    
    state.cachedDrawType = type;
    state.cachedDrawColor = type === 'draw' ? DRAW_CONFIG.penColor : '#000000';
    const startScale = main_fetch_safe_scale();
    state.cachedDrawLineWidth = type === 'draw' ? DRAW_CONFIG.penWidth / startScale : DRAW_CONFIG.eraserSize / startScale;
    
    batchDrawManager.eraserShape = state.currentStroke.eraserShape;
    batchDrawManager.batch_draw_init_start();
}

function main_save_stroke_point(fromX, fromY, toX, toY, pressure = 0.5) {
    const stroke = state.currentStroke;
    if (!stroke) return;
    
    const bounds = stroke.bounds;
    if (fromX < bounds.minX) bounds.minX = fromX;
    if (toX < bounds.minX) bounds.minX = toX;
    if (fromY < bounds.minY) bounds.minY = fromY;
    if (toY < bounds.minY) bounds.minY = toY;
    if (fromX > bounds.maxX) bounds.maxX = fromX;
    if (toX > bounds.maxX) bounds.maxX = toX;
    if (fromY > bounds.maxY) bounds.maxY = fromY;
    if (toY > bounds.maxY) bounds.maxY = toY;
    
    let currentWidth = stroke.lineWidth;
    const currentScale = main_fetch_safe_scale();
    
    if (stroke.type === 'draw') {
        state.currentPressure = pressure;
        state.lastLineWidth = state.currentLineWidth;
        currentWidth = stroke.lineWidth * (0.9 + pressure * 0.2);
        state.currentLineWidth = currentWidth;
        state.cachedDrawLineWidth = DRAW_CONFIG.penWidth / currentScale;
    } else if (stroke.type === 'erase') {
        state.cachedDrawLineWidth = DRAW_CONFIG.eraserSize / currentScale;
    }
    
    stroke.variableWidths.push(currentWidth);
    
    const points = stroke.points;
    points.push({ fromX, fromY, toX, toY });
}

async function main_submit_stroke() {
    if (state.currentStroke && state.currentStroke.points.length > 0) {
        // 强制刷新待处理命令，确保 _storedWidths 包含所有段的线宽
        batchDrawManager.batch_draw_handle_flush();
        // limited 模式：末尾添加收尾渐变
        const penMode = window.get_pen_effect_mode ? window.get_pen_effect_mode() : 'off';
        if (penMode === 'limited' && batchDrawManager._storedWidths.length > 0) {
            const baseW = state.currentStroke.lineWidth || DRAW_CONFIG.penWidth || 5;
            batchDrawManager._apply_speed_taper(batchDrawManager._storedWidths, state.currentStroke.points, baseW);
        }
        // 捕获实时绘制的逐段宽度，确保离线渲染与实时预览一致
        const storedWidths = batchDrawManager._storedWidths;
        if (storedWidths && storedWidths.length === state.currentStroke.points.length) {
            state.currentStroke.storedWidths = [...storedWidths];
        }
        
        const halfWidth = Math.max(state.currentStroke.lineWidth || 5, state.currentStroke.eraserSize || 5) / 2;
        const strokeBounds = state.currentStroke && state.currentStroke.bounds
            ? {
                minX: state.currentStroke.bounds.minX - halfWidth,
                minY: state.currentStroke.bounds.minY - halfWidth,
                maxX: state.currentStroke.bounds.maxX + halfWidth,
                maxY: state.currentStroke.bounds.maxY + halfWidth
            } : null;
        
        const cmd = new DrawCommand({
            stroke: state.currentStroke,
            strokeHistoryRef: state.strokeHistory,
            redrawFn: () => main_render_all_strokes(strokeBounds)
        });
        await history_execute_command(cmd, false);

        if (state.currentStroke.type === 'erase') {
            if (window.tileRenderer) {
                await main_render_all_strokes(strokeBounds);
            }
        } else {
            if (window.tileRenderer) {
                await window.tileRenderer.add_stroke(state.currentStroke);
            }
        }

        if (history_validate_compact()) {
            main_init_compact();
        }
    }
    state.currentStroke = null;

    await batchDrawManager.batch_draw_handle_end();

    batchDrawManager.batch_draw_delete_all();
}

async function main_render_all_strokes(bounds) {
    main_reset_context_state();
    const tr = window.tileRenderer;
    if (!tr) return;

    if (state.strokeHistory.length === 0 && !state.baseImageObj) {
        tr.mark_strokes_changed();
        tr.for_each((info) => {
            const ctx = info.ctx;
            const dpr = info.dpr;
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, -info.rect.x * dpr, -info.rect.y * dpr);
            ctx.clearRect(info.rect.x, info.rect.y, info.rect.width, info.rect.height);
            ctx.restore();
        });
        tr.dirty.clear();
        return;
    }

    tr.mark_strokes_changed();

    if (bounds && isFinite(bounds.minX) && isFinite(bounds.minY) &&
                  isFinite(bounds.maxX) && isFinite(bounds.maxY)) {
        const infos = tr.infos_for_segment(
            bounds.minX, bounds.minY,
            bounds.maxX, bounds.maxY
        );
        for (const info of infos) {
            tr.dirty.add(info.key);
        }
    } else {
        tr.mark_all();
    }

    tr.rebuild_all();
}

function get_pen_effect_mode() { return getPenEffectMode(); }
window.get_pen_effect_mode = get_pen_effect_mode;

function main_reset_context_state() { resetContextState(); }
window.main_reset_context_state = main_reset_context_state;

function main_update_context_state(ctx, s) { updateContextState(ctx, s); }
window.main_update_context_state = main_update_context_state;

/**
 * 按原始顺序逐个绘制笔画：draw/comment 用 source-over，erase 用 destination-out
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array} strokes - 笔画数组
 */
async function main_render_strokes_to_context(ctx, strokes) {
    return renderStrokesToContext(ctx, strokes, {
        renderScale: main_fetch_safe_scale(),
        penManager: realPenManager
    });
}
window.main_render_strokes_to_context = main_render_strokes_to_context;

function main_init_compact() { historyCompactor.initCompaction(); }

async function main_handle_undo() {
    historyCompactor.cancelCompaction();
    state.baseImageLoadId++;
    state.compactSnapshotId = (state.compactSnapshotId || 0) + 1;
    realPenManager.invalidate_cache();
    await history_handle_undo();
    console.log('撤销操作');
}

function main_update_history_button_status() {
    // 工具栏现在由reader/blackboard自己管理
}

// 清空画布
function main_delete_draw_canvas() {
    if (window.tileRenderer) {
        window.tileRenderer.destroy_all();
        window.tileRenderer.init_tiles(dom.canvasWrapper);
    }
    if (window.batchDrawManager) {
        window.batchDrawManager.clear_overlay();
    }
    main_reset_context_state();
}

function main_calc_rgb_to_hex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const hex = x.toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}

function main_update_mode(mode) {
    state.drawMode = mode;
    if (dom.canvasWrapper) {
        dom.canvasWrapper.classList.toggle('drawing', mode !== 'move');
    }
}

async function main_delete_all_drawings() {
    if (state.strokeHistory.length === 0 && !state.baseImageObj) return;
    
    const cmd = new ClearCommand({
        savedStrokeHistory: [...state.strokeHistory],
        savedBaseImageURL: state.baseImageURL,
        strokeHistoryRef: state.strokeHistory,
        baseImageURLRef: { get value() { return state.baseImageURL; }, set value(v) { state.baseImageURL = v; } },
        baseImageObjRef: { get value() { return state.baseImageObj; }, set value(v) { state.baseImageObj = v; } },
        redrawFn: () => main_render_all_strokes(),
        loadBaseImageFn: (url) => main_load_base_image(url)
    });
    await history_execute_command(cmd);
    
    main_delete_draw_canvas();
    
    if (currentSourceId) {
        main_save_current_source_data();
    }
    
    if (state.drawMode === 'eraser') {
        main_update_mode('comment');
    }
    
    console.log('清空所有批注');
}

function main_load_base_image(url) {
    const loadId = ++state.baseImageLoadId;
    const img = new Image();
    img.onload = () => {
        if (loadId === state.baseImageLoadId) {
            state.baseImageObj = img;
            if (window.tileRenderer) window.tileRenderer.mark_all();
            main_render_all_strokes();
        }
    };
    img.onerror = () => {
        console.error('base image 加载失败:', url ? url.substring(0, 50) + '...' : 'null');
        if (loadId === state.baseImageLoadId) {
            state.baseImageObj = null;
            if (window.tileRenderer) window.tileRenderer.mark_all();
            main_render_all_strokes();
        }
    };
    img.src = url;
}

// 保存画布截图
function main_save_photo() {
    main_save_merged_canvas();
}

function main_save_merged_canvas() {
    console.log('执行拍照功能');
    const offscreen = main_fetch_offscreen_canvas();
    const mergedCtx = offscreen.ctx;
    
    mergedCtx.fillStyle = '#3a3a3a';
    mergedCtx.fillRect(0, 0, DRAW_CONFIG.canvasW, DRAW_CONFIG.canvasH);
    
    if (dom.imageElement.src) {
        mergedCtx.drawImage(dom.imageElement, 
            parseFloat(dom.imageElement.style.left) || 0, 
            parseFloat(dom.imageElement.style.top) || 0, 
            parseFloat(dom.imageElement.style.width) || DRAW_CONFIG.canvasW, 
            parseFloat(dom.imageElement.style.height) || DRAW_CONFIG.canvasH
        );
    }
    const tr = window.tileRenderer;
    if (tr) {
        for (const info of tr.tileInfos) {
            if (info.canvas) {
                mergedCtx.drawImage(
                    info.canvas,
                    0, 0,
                    info.canvas.width, info.canvas.height,
                    info.rect.x, info.rect.y,
                    info.rect.width, info.rect.height
                );
            }
        }
    }
    
    const link = document.createElement('a');
    link.download = `photo_${Date.now()}.png`;
    link.href = offscreen.canvas.toDataURL('image/png');
    link.click();
    
    main_release_offscreen_canvas(offscreen);
}

function main_show_settings_window() {
    if (state.settingsOpen) {
        main_close_settings();
        return;
    }
    state.settingsOpen = true;
    const startup = document.getElementById('startupScreen');
    if (startup) startup.style.display = 'none';

    // 隐藏阅读器工具栏
    const drToolbar = document.getElementById('drToolbar');
    if (drToolbar) drToolbar.style.display = 'none';

    const panel = document.getElementById('settingsPanel');
    if (!panel) return;
    panel.style.display = 'flex';

    // 动态加载 settings.css
    if (!document.querySelector('link[href="settings.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'settings.css';
        document.head.appendChild(link);
    }

    // 加载 settings.js（仅首次）
    if (!window._settingsJsLoaded) {
        window._settingsJsLoaded = true;
        const s = document.createElement('script');
        s.type = 'module';
        s.src = 'settings.js';
        document.body.appendChild(s);
    }

    main_update_tabs();
}

function main_close_settings() {
    if (!state.settingsOpen) return;
    state.settingsOpen = false;
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.style.display = 'none';
    // 移除 settings.css 避免影响主页面
    const link = document.querySelector('link[href="settings.css"]');
    if (link) link.remove();
    // 如果阅读器还开着，恢复其工具栏
    if (window.documentReaderManager?.is_open) {
        const drToolbar = document.getElementById('drToolbar');
        if (drToolbar) drToolbar.style.display = '';
    }
    const startup = document.getElementById('startupScreen');
    if (startup) startup.style.removeProperty('display');
    main_update_tabs();
    main_update_ui_state();
}

async function main_open_folder() {
    if (window.__TAURI__?.dialog) {
        try {
            const { open } = window.__TAURI__.dialog;
            const selected = await open({
                directory: true,
                multiple: false,
                title: '选择文件夹'
            });
            if (selected) {
                window.main_add_recent_file?.(selected);
            }
        } catch (error) {
            console.error('打开文件夹失败:', error);
        }
    }
}

async function main_update_image_rotation(direction) {
    if (!state.currentImage) {
        console.log('没有图片可旋转');
        return;
    }

    const rotatedDataUrl = main_update_image_rotation_fallback(state.currentImage, direction);
    
    const rotatedImg = new Image();
    rotatedImg.onload = () => {
        state.currentImage = rotatedImg;
        
        if (state.currentImageIndex >= 0 && state.currentImageIndex < state.imageList.length) {
            state.imageList[state.currentImageIndex].full = rotatedImg.src;
            state.imageList[state.currentImageIndex].thumbnail = rotatedImg.src;
            state.imageList[state.currentImageIndex].width = rotatedImg.width;
            state.imageList[state.currentImageIndex].height = rotatedImg.height;
        }
        
        main_render_image_centered(rotatedImg);
        console.log(`图片已向${direction === 'left' ? '左' : '右'}旋转`);
    };
    rotatedImg.src = rotatedDataUrl;
}

function main_update_image_rotation_fallback(img, direction) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    if (direction === 'left') {
        canvas.width = img.height;
        canvas.height = img.width;
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
    } else {
        canvas.width = img.height;
        canvas.height = img.width;
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
    }
    
    return canvas.toDataURL('image/png');
}

function main_load_pdf() {
    // 使用 Tauri 对话框获取完整文件路径
    if (window.__TAURI__?.dialog) {
        window.__TAURI__.dialog.open({
            multiple: false,
            filters: [{
                name: '文档',
                extensions: ['pdf', 'docx', 'doc']
            }]
        }).then(async (filePath) => {
            if (filePath) {
                const path = Array.isArray(filePath) ? filePath[0] : filePath;
                await main_load_pdf_from_path(path, true);
            }
        }).catch(err => {
            console.error('打开文件对话框失败:', err);
        });
    } else {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf,.docx,.doc';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            alert('请使用 Tauri 环境打开文件');
        };
        input.click();
    }
}

function main_show_loading_overlay(message) {
    DocLoader.show_loading_overlay(message);
}

function main_update_loading_progress(message) {
    DocLoader.update_loading_progress(message);
}

function main_hide_loading_overlay() {
    DocLoader.hide_loading_overlay();
}

function main_show_error_dialog(title, message, retryCallback = null) {
    DocLoader.show_error_dialog(title, message, retryCallback);
}

// === 图像导入功能 ===
// 图片导入、拍照保存、PDF处理

/**
 * 导入图片文件（支持多选，批量导入时用 Rust 并行生成缩略图）
 */
async function main_load_image() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    
    input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        
        // 保存当前源数据，确保切换前批注不丢失
        if (currentSourceId) {
            main_save_current_source_data();
        }
        
        const hasLargeImage = files.some(file => file.size > 2.5 * 1024 * 1024);
        
        // 如果有大图片或者多个文件，显示加载动画
        if (files.length > 1 || hasLargeImage) {
            main_show_loading_overlay(window.i18n?.format_translate('loading.readingImages') || '正在读取图片...');
        }
        
        const imageDataList = [];
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            
            if (files.length > 1 || file.size > 2.5 * 1024 * 1024) {
                main_update_loading_progress(window.i18n?.format_translate('loading.readingImage', { current: i + 1, total: files.length }) || `正在读取图片 ${i + 1}/${files.length}...`);
            }
            
            const blobUrl = URL.createObjectURL(file);
            
            const imageName = file.name || window.i18n?.format_translate('sidebar.imageAlt', { n: state.imageList.length + imageDataList.length + 1 }) || `图片${state.imageList.length + imageDataList.length + 1}`;
            imageDataList.push({
                data: blobUrl,
                blob: file,
                name: imageName
            });
        }
        
        for (let i = 0; i < imageDataList.length; i++) {
            const imgData = imageDataList[i];
            const isLast = (i === imageDataList.length - 1);
            
            const img = new Image();
            await new Promise((resolve) => {
                img.onload = () => resolve();
                img.onerror = () => {
                    console.error(`加载图片失败: ${imgData.name}`);
                    resolve();
                };
                img.src = imgData.data;
            });
            
            const newImgData = {
                full: imgData.data,
                thumbnail: imgData.data,
                name: imgData.name,
                width: img.width,
                height: img.height,
                strokeHistory: [],
                baseImageURL: null,
                viewState: {
                    scale: 1,
                    canvasX: -(DRAW_CONFIG.canvasW - DRAW_CONFIG.screenW) / 2,
                    canvasY: -(DRAW_CONFIG.canvasH - DRAW_CONFIG.screenH) / 2
                },
                sourceId: main_create_source_id('pic')
            };
            
            state.imageList.push(newImgData);
            state.currentImageIndex = state.imageList.length - 1;
            state.currentImage = img;
            state.currentFolderIndex = -1;
            state.currentFolderPageIndex = -1;
            
            main_delete_draw_canvas();
            state.strokeHistory = [];
            state.baseImageURL = null;
            state.baseImageObj = null;
            history_delete_all();
            state.scale = 1;
            state.canvasX = -(DRAW_CONFIG.canvasW - DRAW_CONFIG.screenW) / 2;
            state.canvasY = -(DRAW_CONFIG.canvasH - DRAW_CONFIG.screenH) / 2;
            main_update_move_bound();
            main_update_canvas_transform();
            main_update_history_button_status();
            
            if (isLast) {
                main_render_image_centered(img);
            }
        }
        
        // 如果显示了加载动画，无论文件数量多少，都需要隐藏
        if (files.length > 1 || hasLargeImage) {
            main_hide_loading_overlay();
        }
        
        console.log(`已导入 ${imageDataList.length} 张图片`);
    };
    
    input.click();
}

async function main_save_image_to_list_no_highlight(img, name, captureFilter) {
    const blob = await fetch(img.src).then(r => r.blob());
    const blobUrl = URL.createObjectURL(blob);
    
    const imgData = {
        full: blobUrl,
        thumbnail: blobUrl,
        name: name,
        width: img.width,
        height: img.height,
        sourceId: main_create_source_id('pic'),
        captureFilter: captureFilter || null
    };
    
    state.imageList.push(imgData);
}

window.main_save_image_to_list_no_highlight = main_save_image_to_list_no_highlight;
window.main_delete_all_drawings = main_delete_all_drawings;

function main_render_image_centered(img) {
    main_delete_image_layer();
    
    const screenW = DRAW_CONFIG.screenW;
    const screenH = DRAW_CONFIG.screenH;
    
    const imgRatio = img.width / img.height;
    const screenRatio = screenW / screenH;
    
    let drawW, drawH, drawX, drawY;
    
    if (imgRatio > screenRatio) {
        drawW = screenW;
        drawH = screenW / imgRatio;
    } else {
        drawH = screenH;
        drawW = screenH * imgRatio;
    }
    
    const canvasW = DRAW_CONFIG.canvasW;
    const canvasH = DRAW_CONFIG.canvasH;
    
    drawX = (canvasW - drawW) / 2;
    drawY = (canvasH - drawH) / 2;
    
    dom.imageElement.src = img.src;
    dom.imageElement.style.left = drawX + 'px';
    dom.imageElement.style.top = drawY + 'px';
    dom.imageElement.style.width = drawW + 'px';
    dom.imageElement.style.height = drawH + 'px';
}

function main_delete_image_layer() {
    dom.imageElement.src = '';
    dom.imageElement.style.left = '0';
    dom.imageElement.style.top = '0';
    dom.imageElement.style.width = DRAW_CONFIG.canvasW + 'px';
    dom.imageElement.style.height = DRAW_CONFIG.canvasH + 'px';
}

function main_delete_image_blob_urls() {
    state.imageList.forEach(imgData => {
        if (imgData.full && imgData.full.startsWith('blob:')) {
            URL.revokeObjectURL(imgData.full);
        }
        if (imgData.thumbnail && imgData.thumbnail.startsWith('blob:') && imgData.thumbnail !== imgData.full) {
            URL.revokeObjectURL(imgData.thumbnail);
        }
    });
}

function main_delete_pdf_blob_urls(docNumber) {
    const folder = state.fileList.find(f => f.docNumber === docNumber);
    if (folder) {
        folder.pages.forEach(page => {
            if (page.full && page.full.startsWith('blob:')) {
                URL.revokeObjectURL(page.full);
            }
            if (page.thumbnail && page.thumbnail.startsWith('blob:') && page.thumbnail !== page.full) {
                URL.revokeObjectURL(page.thumbnail);
            }
        });
    }
}

function main_delete_all_pdf_blob_urls() {
    DocLoader.revoke_all_document_blob_urls();
}

// ===== 最近打开文件 =====
const RECENT_FILES_KEY = 'viewstage_recent_files';
const MAX_RECENT_FILES = 20;

function main_add_recent_file(filePath) {
    try {
        let files = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) || '[]');
        if (!Array.isArray(files)) files = [];
        const now = Date.now();
        files = files.filter(f => {
            const p = typeof f === 'string' ? f : (f.path || '');
            return p !== filePath;
        });
        const entry = { path: filePath, name: filePath.split(/[/\\]/).pop(), time: now };
        if (window.__TAURI__) {
            window.__TAURI__.core.invoke('file_fetch_stat', { path: filePath }).then(size => {
                if (size != null) {
                    const idx = files.findIndex(f => (typeof f === 'string' ? f : f.path) === filePath);
                    if (idx !== -1) { files[idx].size = size; }
                    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(files));
                    window.main_render_recent_files?.(files);
                }
            }).catch(() => {});
        }
        files.unshift(entry);
        if (files.length > MAX_RECENT_FILES) files = files.slice(0, MAX_RECENT_FILES);
        localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(files));
        window.main_render_recent_files?.(files);
    } catch (e) {
        console.warn('保存最近文件失败:', e);
    }
}

function main_load_recent_files() {
    try {
        let files = JSON.parse(localStorage.getItem(RECENT_FILES_KEY) || '[]');
        if (!Array.isArray(files)) files = [];
        files = files.filter(f => {
            if (typeof f === 'string') return f;
            return f && f.path;
        });
        window.main_render_recent_files?.(files);
    } catch (e) {
        console.warn('读取最近文件失败:', e);
    }
}



window.main_setup_all_events = main_setup_all_events;
window.main_setup_pdf_file_open = main_setup_pdf_file_open;
window.main_show_error_dialog = main_show_error_dialog;
window.main_handle_resize = main_handle_resize;
window.main_submit_stroke = main_submit_stroke;
window.main_update_mode = main_update_mode;
window.main_update_canvas_bg_color = main_update_canvas_bg_color;
window.main_calc_rgb_to_hex = main_calc_rgb_to_hex;
window.main_update_color_buttons = main_update_color_buttons;
window.main_show_pen_control_panel = main_show_pen_control_panel;
window.main_update_ui_state = main_update_ui_state;
window.main_delete_image_blob_urls = main_delete_image_blob_urls;
window.main_delete_all_pdf_blob_urls = main_delete_all_pdf_blob_urls;
window.main_load_pdf = main_load_pdf;
window.main_load_pdf_from_path = main_load_pdf_from_path;
window.main_show_settings_window = main_show_settings_window;
window.main_close_settings = main_close_settings;
window.main_open_folder = main_open_folder;
window.main_update_move_bound = main_update_move_bound;
window.main_update_pen_style = main_update_pen_style;
window.main_update_canvas_transform = main_update_canvas_transform;
window.main_init_pdfjs = main_init_pdfjs;
window.main_hide_window = main_hide_window;
window.main_toggle_maximize = main_toggle_maximize;
window.main_submit_close_window = main_submit_close_window;
window.main_add_recent_file = main_add_recent_file;
window.main_load_recent_files = main_load_recent_files;
window.main_wait_pdfjs = main_wait_pdfjs;
window.main_render_image_centered = main_render_image_centered;
window.main_render_all_strokes = main_render_all_strokes;
window.main_fetch_visible_rect = main_fetch_visible_rect;
window.main_update_tabs = main_update_tabs;
window.main_switch_home = main_switch_home;
window.main_switch_to_tab = main_switch_to_tab;
window.main_close_tab = main_close_tab;
window.StrokeQuadTree = StrokeQuadTree;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(main_update_tabs, 100);
    });
} else {
    setTimeout(main_update_tabs, 100);
}

/** 同步所有 overlay DPR（主界面 + 阅读器 + 黑板） */
window.sync_all_overlay_dpr = function () {
    const dpr = window.DRAW_CONFIG?.overlayDpr;
    if (dpr == null || dpr <= 0) return;
    // 主界面
    if (window.batchDrawManager) {
        window.batchDrawManager.resize_overlay(
            DRAW_CONFIG.screenW || 800,
            DRAW_CONFIG.screenH || 600
        );
    }
    // 阅读器
    const reader = window.documentReaderManager;
    if (reader?.batch_draw?._overlayCanvas) {
        const overlay = reader.batch_draw._overlayCanvas;
        reader.batch_draw._overlayDpr = dpr;
        overlay.width = Math.ceil(window.innerWidth * dpr);
        overlay.height = Math.ceil(window.innerHeight * dpr);
        overlay.style.width = window.innerWidth + 'px';
        overlay.style.height = window.innerHeight + 'px';
    }
    // 黑板
    const bb = window.blackboardManager;
    if (bb?.overlay_canvas && bb.drawing_engine?.batch_draw) {
        bb.drawing_engine.batch_draw._overlayDpr = dpr;
        bb.overlay_canvas.width = Math.ceil(bb.screen_w * dpr);
        bb.overlay_canvas.height = Math.ceil(bb.screen_h * dpr);
        bb.overlay_canvas.style.width = bb.screen_w + 'px';
        bb.overlay_canvas.style.height = bb.screen_h + 'px';
    }
};