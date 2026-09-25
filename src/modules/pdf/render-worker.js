/**
 * PDF 渲染专用线程（module worker）。
 *
 * 职责：接收宿主页投递的 PDF 字节流，在本线程独立完成「解析 → 栅格化」全流程，
 * 以 ImageBitmap（零拷贝 transfer）回传结果。主线程只保留参数守卫与画布换帧，
 * 滚动/缩放/预渲染期间的栅格化不再阻塞主线程。
 *
 * 注意：pdf.js 的 getDocument 会再派生自己的解析 worker（嵌套 worker）；
 * 嵌套 worker 不可用时 pdf.js 自动降级为「fake worker」在本线程解析——
 * 无论哪种情况，栅格化都发生在这里，主线程不受影响。
 *
 * 本线程无 UI 访问能力，严禁依赖 window/document；资源 URL 一律用
 * new URL(..., import.meta.url) 解析（基准 = 本文件所在目录 modules/pdf/）。
 */
import * as pdfjsLib from './pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;

// ===== 无 DOM 画布工厂（与 pdf.js 官方 Node 路径 NodeCanvasFactory 同构） =====
// pdf.js 渲染期会按需创建临时画布：平铺图案（TilingPattern）、网格渐变、
// 透明组（transparentCanvas）、SMask、图片重采样都调 canvasFactory.create()。
// 默认 DOMCanvasFactory 持有 globalThis.document——本线程无 document，
// 命中即抛 "Cannot read properties of undefined (reading 'createElement')"。
// 接口对齐 BaseCanvasFactory：create → {canvas, context}、reset、destroy。
// 注意：类定义必须在 BASE_OPTIONS 之前——BASE_OPTIONS 是顶层立即求值的
// const，初始化器按值引用类；放后面会触发 TDZ，worker 模块加载即崩。
class WorkerCanvasFactory {
    create(width, height) {
        if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        return { canvas, context };
    }

    reset(canvasAndContext, width, height) {
        if (!canvasAndContext?.canvas) throw new Error('Canvas is not specified');
        if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
    }

    destroy(canvasAndContext) {
        if (!canvasAndContext?.canvas) throw new Error('Canvas is not specified');
        canvasAndContext.canvas.width = 0;
        canvasAndContext.canvas.height = 0;
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
    }
}

// 无 DOM 滤镜工厂（同 pdf.js 的 NodeFilterFactory extends BaseFilterFactory）：
// 全部方法返回 "none"，亮度/挖空/alpha 滤镜按无滤镜路径绘制，不崩溃。
// 透明组的蒙版合成不依赖 DOM 滤镜（走 OffscreenCanvas 像素合成）。
class WorkerFilterFactory {
    addFilter() { return 'none'; }
    addHCMFilter() { return 'none'; }
    addAlphaFilter() { return 'none'; }
    addLuminosityFilter() { return 'none'; }
    addKnockoutFilter() { return 'none'; }
    addHighlightHCMFilter() { return 'none'; }
    addSelectionHCMFilter() { return 'none'; }
    addSelectionFilter() { return 'none'; }
    createSelectionStyle() { return null; }
    destroy() {}
}

// 与 main.js 主线程 getDocument 参数保持一致（字体/CMap 资源按本目录解析）。
// disableFontFace 必须为 true：字体注册依赖 document.fonts（FontFace API），
// worker 中没有 document——不关闭时文字回落到默认字体，渲染结果全是乱码。
// 该模式下 pdf.js 把字形按矢量路径绘制（同 Node.js 无 DOM 渲染路径），
// 不依赖任何 DOM 字体设施，代价是字形栅格化略慢（发生在线程内，不阻塞主线程）。
const BASE_OPTIONS = {
    enableXfa: false,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: new URL('./standard_fonts/', import.meta.url).href,
    cMapUrl: new URL('./cmaps/', import.meta.url).href,
    cMapPacked: true,
    // 无 DOM 环境的画布/滤镜工厂（见上方类定义）。缺省时 pdf.js 用
    // DOMCanvasFactory（document.createElement）——凡命中临时画布的特性
    // （平铺图案/网格渐变/透明组/蒙版/图片重采样）整页崩溃回退主线程。
    CanvasFactory: WorkerCanvasFactory,
    FilterFactory: WorkerFilterFactory,
    verbosity: pdfjsLib.VerbosityLevel?.ERRORS ?? 0
};

let pdf_doc = null;
// reqId -> 渲染任务（支持按请求取消；force 重渲染/虚拟化卸载都会触发）
const render_tasks = new Map();

// pageNum -> PDFPageProxy 的小型 LRU（上限 4 页）：多指令并发下同页重复指令
// （档内缩放重渲染、被抢占后重排、位图缓存失效回源）直接复用已解析页对象，
// 免去重复 getPage 解析（每页 10~50ms，发生在渲染线程内但仍是总延迟）。
// 内存仍有界：仅在 LRU 驱逐时 cleanup；页面有未完成渲染任务时 pdf.js 的
// cleanup() 是安全空操作（内部会跳过在用数据），驱逐竞态无害。
const page_cache = new Map();
const PAGE_CACHE_MAX = 4;

async function _get_page(num) {
    let page = page_cache.get(num);
    if (page) {
        page_cache.delete(num);
        page_cache.set(num, page);
        return page;
    }
    page = await pdf_doc.getPage(num);
    page_cache.set(num, page);
    if (page_cache.size > PAGE_CACHE_MAX) {
        const oldest_num = page_cache.keys().next().value;
        const oldest = page_cache.get(oldest_num);
        page_cache.delete(oldest_num);
        try { oldest.cleanup(); } catch (_) {}
    }
    return page;
}

self.onmessage = async (e) => {
    const msg = e.data;
    try {
        switch (msg?.type) {
            case 'open': {
                // 换文档：先销毁旧文档（释放其解析缓存与内部 worker 侧数据）
                page_cache.clear();
                if (pdf_doc) {
                    try { await pdf_doc.destroy(); } catch (_) { /* 旧文档销毁失败不阻塞新文档 */ }
                    pdf_doc = null;
                }
                pdf_doc = await pdfjsLib.getDocument({ ...BASE_OPTIONS, data: msg.data }).promise;
                self.postMessage({ type: 'opened', id: msg.id, pages: pdf_doc.numPages });
                break;
            }

            case 'render': {
                const { req, pageNum, cssW, dpr } = msg;
                try {
                    if (!pdf_doc) throw new Error('render worker: document not open');
                    const page = await _get_page(pageNum);
                    const base = page.getViewport({ scale: 1 });
                    const css_scale = cssW / base.width;
                    const viewport = page.getViewport({ scale: css_scale * dpr });
                    const w = Math.max(1, Math.ceil(viewport.width));
                    const h = Math.max(1, Math.ceil(viewport.height));

                    // 每次渲染新建 OffscreenCanvas；transferToImageBitmap 后整体移交主线程
                    const canvas = new OffscreenCanvas(w, h);
                    const ctx = canvas.getContext('2d', { alpha: false });
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(0, 0, w, h);

                    const task = page.render({
                        canvasContext: ctx,
                        viewport,
                        annotationMode: 0
                    });
                    render_tasks.set(req, task);
                    await task.promise;
                    render_tasks.delete(req);

                    const bitmap = canvas.transferToImageBitmap();
                    self.postMessage(
                        { type: 'render-done', req, width: w, height: h, pageW: base.width, pageH: base.height, bitmap },
                        [bitmap]
                    );
                    // 页对象留在 page_cache（LRU 驱逐时才 cleanup）：
                    // 同页重复指令直接复用，不重复解析
                } catch (err) {
                    render_tasks.delete(req);
                    self.postMessage({
                        type: 'render-error',
                        req,
                        cancelled: err?.name === 'RenderingCancelledException',
                        error: String((err && err.message) || err)
                    });
                }
                break;
            }

            case 'cancel': {
                const task = render_tasks.get(msg.req);
                if (task) { try { task.cancel(); } catch (_) { /* 取消竞态无害 */ } }
                break;
            }

            case 'close': {
                render_tasks.forEach(t => { try { t.cancel(); } catch (_) {} });
                render_tasks.clear();
                page_cache.clear();
                if (pdf_doc) {
                    try { pdf_doc.destroy(); } catch (_) {}
                    pdf_doc = null;
                }
                break;
            }
        }
    } catch (err) {
        if (msg?.type === 'open') {
            self.postMessage({ type: 'open-error', id: msg.id, error: String((err && err.message) || err) });
        } else {
            self.postMessage({ type: 'fatal', error: String((err && err.message) || err) });
        }
    }
};
