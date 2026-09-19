/**
 * 钢笔笔锋曲面细分 - 将笔画点数据拆分为带渐变宽度的细分段，实现钢笔笔触效果
 * 渲染时将每个细分段以二次贝塞尔曲线绘制，产生平滑笔迹
 */
class PenTessellator {
    constructor() {
        /**
         * 分段路径缓存：键为「细分笔画对象」，值 { ratio, runs }，
         * runs = [{ w, path: Path2D }, ...]（按宽度变化切成若干段）。
         *
         * 段的几何只由 segments 与 scaleRatio 决定（调用方恒传 1），与目标
         * 瓦片、DPR、视图变换全都无关 —— 同一条笔迹在所有瓦片、所有重建之间
         * 共用同一批 Path2D。WeakMap 保证笔画被回收时缓存随之释放。
         */
        this._runsCache = new WeakMap();
        this._cachedRunCount = 0;
        /**
         * 缓存总量上限（按「段」计）。
         * 段数只在宽度每变化 0.5 时增加，正常笔迹约 4 段/笔；上限用于封住
         * 病态输入（逐点跳变的宽度会让段数逼近采样点数）下的原生内存。
         * 超出后新笔画不再入缓存，渲染仍走同一条代码路径、结果不变，
         * 只是退回「每次现建」的旧代价。
         */
        this._MAX_CACHED_RUNS = 200000;
    }

    /**
     * 从笔画数据构建曲面细分后的可渲染笔画
     * @param {Object} stroke - 原始笔画数据（points: 点数组, lineWidth: 基础笔宽, color: 颜色）
     * @param {Object} [options] - 配置项，含 density 密度系数、storedWidths 实时存储宽度数组、noStartTaper 是否禁用起笔渐变
     * @returns {Object|null} { segments: 细分段数组, color: 颜色 }，无效输入返回 null
     */
    tessellator_build_stroke_from_stroke_data(stroke, options = {}) {
        if (!stroke || !stroke.points || stroke.points.length < 1) return null;

        const points = stroke.points;
        const base_width = stroke.lineWidth || 5;
        const color = stroke.color || '#3498db';
        const density = options.density || 1;
        const storedWidths = options.storedWidths || null;

        const segs = this._tessellator_build_segments(points, base_width, density, options.noStartTaper, storedWidths);
        if (!segs || segs.length < 1) return null;

        return { segments: segs, color };
    }

    // 将点序列转换为每段的渐变宽度数组，支持实时存储宽度或按速度重算两种模式
    _tessellator_build_segments(points, base_width, density = 1, noStartTaper = false, storedWidths = null) {
        if (points.length < 1) return null;

        const raw = [{ x: points[0].fromX, y: points[0].fromY }];
        for (let i = 0; i < points.length; i++) {
            raw.push({ x: points[i].toX, y: points[i].toY });
        }
        if (raw.length < 2) return null;

        const line_widths = [];

        if (storedWidths && storedWidths.length === raw.length - 1) {
            // 使用实时存储宽度，跳过速度重算
            for (let i = 0; i < storedWidths.length; i++) {
                line_widths.push(storedWidths[i]);
            }
        } else {
            // 无存储宽度：从速度重算（兼容模式，如子笔画）
            const speedScale = Math.max(0.4, Math.min(2.5, base_width / 4));
            const maxSpeed = 2.5 * speedScale;
            const minSpeed = 0.2 * speedScale;
            const minRatio = window.DRAW_CONFIG?.penMinWidthRatio ?? 0.4;
            let last_line_width = base_width;

            for (let i = 1; i < raw.length; i++) {
                const prev = raw[i - 1];
                const curr = raw[i];

                const dx = curr.x - prev.x;
                const dy = curr.y - prev.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                const safeDist = Math.max(dist, 0.01);
                const speed = safeDist * 0.125;
                const clamped = Math.max(0, Math.min(1, (speed - minSpeed) / (maxSpeed - minSpeed)));

                let line_width;
                if (clamped >= 1) {
                    line_width = base_width * minRatio;
                } else if (clamped <= 0) {
                    line_width = base_width;
                } else {
                    const eased = clamped * clamped * (3 - 2 * clamped);
                    line_width = base_width - eased * (base_width * minRatio);
                }

                const blend = Math.max(0.3, Math.min(0.85, 1 - dist / (base_width * 3)));
                line_width = line_width * (1 - blend) + last_line_width * blend;

                const maxDelta = base_width * 0.12;
                line_width = Math.min(last_line_width + maxDelta, Math.max(last_line_width - maxDelta, line_width));
                last_line_width = line_width;

                line_widths.push(line_width);
            }
        }

        const totalSegments = line_widths.length;
        const taperSegments = 4;

        for (let i = 0; i < totalSegments; i++) {
            if (!noStartTaper && i < taperSegments) {
                // 存储宽度已包含实时计算的起笔渐变，此处不再叠加
                if (!storedWidths) {
                    const taperT = (i + 1) / taperSegments;
                    const eased = taperT * taperT * (3 - 2 * taperT);
                    const minStart = base_width * 0.2;
                    line_widths[i] = minStart + (line_widths[i] - minStart) * eased;
                }
            }
        }

        const segments = [];
        for (let i = 0; i < line_widths.length; i++) {
            const p1 = raw[i];
            const p2 = raw[i + 1];
            segments.push({
                x1: p1.x, y1: p1.y,
                x2: p2.x, y2: p2.y,
                line_width: line_widths[i]
            });
        }

        return segments;
    }

    /**
     * 取该细分笔画的分段路径列表（按宽度变化切段）。
     *
     * 之所以缓存「分段路径」而不是「采样点」：采样点只是中间量，真正逐帧发出的
     * 是上下文的 lineTo —— 实测一次全量重绘（3000 笔迹）要发 157 万次 lineTo，
     * 因为同一笔画的折线被每块相交瓦片各走一遍。缓存 Path2D 后，这些调用只剩下
     * 每段一次 ctx.stroke(path)，把「笔画数 × 命中瓦片数」这一层乘法整个消掉。
     * @returns {Array<{w:number, path:Path2D}>|null}
     */
    _runs(ts, scaleRatio) {
        const cached = this._runsCache.get(ts);
        if (cached && cached.ratio === scaleRatio) return cached.runs;
        const runs = this._build_runs(ts, scaleRatio);
        if (runs) {
            // WeakMap 拿不到 GC 回调，_cachedRunCount 只会虚高；配额满时整体作废
            // 重来（比"满了就永久拒收"好——那会让长会话后半程笔画永远走冷路径）。
            if (this._cachedRunCount + runs.length > this._MAX_CACHED_RUNS) {
                this.reset_runs_cache();
            }
            this._cachedRunCount += runs.length;
            this._runsCache.set(ts, { ratio: scaleRatio, runs });
        }
        return runs;
    }

    /**
     * 作废分段路径缓存。
     *
     * 缓存键是「细分笔画对象」，而细分笔画由 RealPenManager.build_tessellated_stroke
     * 按**原始笔画对象**（store 键）产出；原始笔画的 points 被原地改写时，
     * 细分对象不会重建，_runsCache 里的旧 runs 会被一直沿用 →
     * 调用方（RealPenManager.invalidate_cache）必须先丢弃细分对象再清这里。
     * _cachedRunCount 一并归零：它只是缓存体积配额，旧段已不可达。
     */
    reset_runs_cache() {
        this._runsCache = new WeakMap();
        this._cachedRunCount = 0;
    }

    /** 采样点序列的唯一构建实现（与改造前的点序逐字一致） */
    _build_sample_points(ts, scaleRatio) {
        const segments = ts.segments;
        const len = segments ? segments.length : 0;
        if (len === 0) return null;

        const SUBDIVS = 8;
        // i=0 另有一个起点，末段再多 4 个收尾点 => 8*len + 5 个采样点
        const data = new Float32Array((len * SUBDIVS + 5) * 3);
        let o = 0;

        for (let i = 0; i < len; i++) {
            const seg = segments[i];
            const prevW = i > 0 ? segments[i - 1].line_width * scaleRatio : seg.line_width * scaleRatio;
            const curW = seg.line_width * scaleRatio;

            let sx, sy, cx, cy, ex, ey;
            if (i === 0) {
                sx = seg.x1; sy = seg.y1;
                ex = (seg.x1 + seg.x2) / 2; ey = (seg.y1 + seg.y2) / 2;
                cx = sx; cy = sy;
                data[o] = sx; data[o + 1] = sy; data[o + 2] = curW; o += 3;
            } else {
                const prev = segments[i - 1];
                sx = (prev.x1 + prev.x2) / 2; sy = (prev.y1 + prev.y2) / 2;
                ex = (seg.x1 + seg.x2) / 2; ey = (seg.y1 + seg.y2) / 2;
                cx = seg.x1; cy = seg.y1;
            }

            for (let j = 1; j <= SUBDIVS; j++) {
                const t = j / SUBDIVS;
                const w = prevW + (curW - prevW) * t;
                let px, py;
                if (i === 0) {
                    px = sx + (ex - sx) * t;
                    py = sy + (ey - sy) * t;
                } else {
                    const omt = 1 - t;
                    px = omt * omt * sx + 2 * omt * t * cx + t * t * ex;
                    py = omt * omt * sy + 2 * omt * t * cy + t * t * ey;
                }
                data[o] = px; data[o + 1] = py; data[o + 2] = w; o += 3;
            }

            if (i === len - 1) {
                const mx = ex, my = ey;
                const tx = seg.x2, ty = seg.y2;
                const segs = 4;
                for (let j = 1; j <= segs; j++) {
                    const t = j / segs;
                    data[o] = mx + (tx - mx) * t;
                    data[o + 1] = my + (ty - my) * t;
                    data[o + 2] = curW;
                    o += 3;
                }
            }
        }

        return data;
    }

    /**
     * 按宽度切段并预构建 Path2D（分段逻辑与改造前的渲染循环逐字对应）：
     * 宽度每变化 >= 0.5 就收一段，新段以上一段的**最后一个采样点**为起点
     * （相邻段重叠一个点），保证交界处连续无缺口。
     */
    _build_runs(ts, scaleRatio) {
        const data = this._build_sample_points(ts, scaleRatio);
        if (!data) return null;
        const n = data.length / 3;
        if (n < 2) return null;          // 等价于改造前的 pts.length < 2

        const WIDTH_EPSILON = 0.5;
        const runs = [];
        let start = 0;
        let batchWidth = data[2];

        const push_run = (from, to, w) => {
            const path = new Path2D();
            path.moveTo(data[from * 3], data[from * 3 + 1]);
            for (let k = from + 1; k <= to; k++) {
                path.lineTo(data[k * 3], data[k * 3 + 1]);
            }
            runs.push({ w, path });
        };

        for (let k = 1; k < n; k++) {
            const w = data[k * 3 + 2];
            if (Math.abs(w - batchWidth) >= WIDTH_EPSILON) {
                push_run(start, k - 1, batchWidth);
                start = k - 1;
                batchWidth = w;
            }
        }
        push_run(start, n - 1, batchWidth);

        return runs;
    }

    /**
     * 渲染曲面细分后的笔画到 canvas
     * @param {CanvasRenderingContext2D} ctx - 画布上下文
     * @param {Object} tessellated_stroke - 细分笔画数据（segments 数组 + color 颜色）
     * @param {number} scaleRatio - strokeScale / renderScale，用于线宽缩放转换
     */
    tessellator_render_stroke(ctx, tessellated_stroke, scaleRatio = 1) {
        if (!tessellated_stroke || !tessellated_stroke.segments) return;

        ctx.strokeStyle = tessellated_stroke.color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalCompositeOperation = 'source-over';

        const runs = this._runs(tessellated_stroke, scaleRatio);
        if (!runs || runs.length === 0) return;

        for (let i = 0; i < runs.length; i++) {
            const run = runs[i];
            ctx.lineWidth = run.w;
            ctx.stroke(run.path);
        }
    }
}

window.penTessellator = new PenTessellator();
