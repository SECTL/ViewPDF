/**
 * 钢笔笔锋曲面细分 - 将笔画点数据拆分为带渐变宽度的细分段，实现钢笔笔触效果
 * 渲染时将每个细分段以二次贝塞尔曲线绘制，产生平滑笔迹
 */
class PenTessellator {
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
     * 渲染曲面细分后的笔画到 canvas
     * @param {CanvasRenderingContext2D} ctx - 画布上下文
     * @param {Object} tessellated_stroke - 细分笔画数据（segments 数组 + color 颜色）
     * @param {number} scaleRatio - strokeScale / renderScale，用于线宽缩放转换
     */
    tessellator_render_stroke(ctx, tessellated_stroke, scaleRatio = 1) {
        if (!tessellated_stroke || !tessellated_stroke.segments) return;

        const { segments, color } = tessellated_stroke;
        const len = segments.length;

        ctx.strokeStyle = color;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalCompositeOperation = 'source-over';

        const SUBDIVS = 8;

        /* 构建采样点序列，宽度沿曲线线性插值，消除段间阶跃 */
        const pts = [];

        for (let i = 0; i < len; i++) {
            const seg = segments[i];
            const prevW = i > 0 ? segments[i - 1].line_width * scaleRatio : seg.line_width * scaleRatio;
            const curW = seg.line_width * scaleRatio;

            let sx, sy, cx, cy, ex, ey, tail = false;
            if (i === 0) {
                sx = seg.x1; sy = seg.y1;
                ex = (seg.x1 + seg.x2) / 2; ey = (seg.y1 + seg.y2) / 2;
                cx = sx; cy = sy;
                pts.push({ x: sx, y: sy, w: curW });
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
                pts.push({ x: px, y: py, w });
            }

            if (i === len - 1) {
                const mx = ex, my = ey;
                const tx = seg.x2, ty = seg.y2;
                const segs = 4;
                for (let j = 1; j <= segs; j++) {
                    const t = j / segs;
                    pts.push({ x: mx + (tx - mx) * t, y: my + (ty - my) * t, w: curW });
                }
            }
        }

        if (pts.length < 2) return;

        const WIDTH_EPSILON = 0.5;
        let batchWidth = pts[0].w;
        ctx.lineWidth = batchWidth;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);

        for (let i = 1; i < pts.length; i++) {
            const p = pts[i];
            if (Math.abs(p.w - batchWidth) >= WIDTH_EPSILON) {
                ctx.stroke();
                ctx.lineWidth = p.w;
                batchWidth = p.w;
                ctx.beginPath();
                ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
            }
            ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
    }
}

window.penTessellator = new PenTessellator();
