/**
 * PDF 渲染线程宿主（主线程侧单例）。
 *
 * 职责：
 * - worker 生命周期管理（懒创建、崩溃检测）
 * - 文档字节投递（pdfDoc.getData() 取副本 → transfer 给渲染线程）
 * - 请求调度：可见页渲染优先于预渲染（unshift / push 两级队列）
 * - 按页取消：force 重渲染、虚拟化卸载、关文档时停掉在途任务
 *
 * 失败语义：渲染线程是纯加速层，不承担正确性——任何失败（创建失败/崩溃/
 * 打开失败）只会让 available=false 或 ensure_document 返回 false，
 * 调用方（document_reader）回退到主线程 pdf.js 渲染路径。
 */

function _cancelled_error() {
    const err = new Error('render cancelled');
    err.name = 'RenderingCancelledException';
    return err;
}

export class PdfRenderWorkerHost {
    constructor() {
        this.available = typeof Worker !== 'undefined';
        this._worker = null;
        this._cur_doc = null;           // 当前已成功投递的 PDFDocumentProxy（身份键）
        this._open_failed_doc = null;   // 打开失败的文档：本会话内不再重试（快速失败）
        this._open_serial = Promise.resolve(); // open 串行化：换文档先关旧再投新
        this._req_id = 0;
        this._open_waiters = new Map(); // openId -> {resolve, reject}
        this._queue = [];               // 待派发：{reqId, pageNum, cssW, dpr}
        this._pending = new Map();      // reqId -> {resolve, reject, pageNum}（已入队未派发）
        this._inflight = new Map();     // reqId -> {resolve, reject, pageNum}（已派发给 worker）
        this._by_page = new Map();      // pageNum -> reqId（该页最新一次请求，取消按页定位）
        this._max_inflight = 2;         // 在途渲染上限：与主线程路径 _RENDER_MAX 口径一致
        this._prerender_queue_max = 6;  // 预渲染队列上限：滚动长距时过期预渲染及时让位
    }

    _ensure_worker() {
        if (this._worker) return this._worker;
        this._worker = new Worker('modules/pdf/render-worker.js', { type: 'module' });
        this._worker.onmessage = (e) => this._on_message(e.data);
        this._worker.onerror = (e) => {
            this._on_worker_down('worker error: ' + (e?.message || 'unknown'));
        };
        this._worker.onmessageerror = () => this._on_worker_down('worker messageerror');
        return this._worker;
    }

    _on_message(msg) {
        switch (msg?.type) {
            case 'opened': {
                const w = this._open_waiters.get(msg.id);
                if (w) { this._open_waiters.delete(msg.id); w.resolve(true); }
                break;
            }
            case 'open-error': {
                const w = this._open_waiters.get(msg.id);
                if (w) { this._open_waiters.delete(msg.id); w.reject(new Error(msg.error || 'open failed')); }
                break;
            }
            case 'render-done': {
                const p = this._inflight.get(msg.req);
                if (p) {
                    this._inflight.delete(msg.req);
                    if (this._by_page.get(p.pageNum) === msg.req) this._by_page.delete(p.pageNum);
                    p.resolve({ bitmap: msg.bitmap, width: msg.width, height: msg.height, pageW: msg.pageW, pageH: msg.pageH });
                }
                this._drain();
                break;
            }
            case 'render-error': {
                const p = this._inflight.get(msg.req);
                if (p) {
                    this._inflight.delete(msg.req);
                    if (this._by_page.get(p.pageNum) === msg.req) this._by_page.delete(p.pageNum);
                    const err = msg.cancelled
                        ? _cancelled_error()
                        : new Error(msg.error || 'worker render failed');
                    p.reject(err);
                }
                this._drain();
                break;
            }
            case 'fatal': {
                console.warn('[render-worker-host] worker 内部异常:', msg.error);
                this._on_worker_down('fatal: ' + msg.error);
                break;
            }
        }
    }

    /** worker 崩溃/不可用：置死本实例，所有在途请求按取消语义拒绝（调用方回退主线程路径） */
    _on_worker_down(reason) {
        if (!this.available && !this._worker) return;
        console.warn('[render-worker-host] 渲染线程不可用，回退主线程渲染:', reason);
        this.available = false;
        const err = _cancelled_error();
        this._fail_all(err);
        try { this._worker?.terminate(); } catch (_) {}
        this._worker = null;
        this._cur_doc = null;
    }

    _fail_all(err) {
        for (const w of this._open_waiters.values()) w.reject(err);
        this._open_waiters.clear();
        for (const p of this._pending.values()) p.reject(err);
        this._pending.clear();
        for (const p of this._inflight.values()) p.reject(err);
        this._inflight.clear();
        this._queue.length = 0;
        this._by_page.clear();
    }

    /**
     * 确保渲染线程已装载该文档。按 pdfDoc 对象身份记忆：
     * 同一文档重复调用零开销；换文档自动关闭旧文档；
     * 打开失败按文档记忆，本会话内快速失败（不再反复拷贝字节）。
     * @returns {Promise<boolean>} 是否可用（false = 调用方回退主线程路径）
     */
    ensure_document(pdfDoc) {
        if (!this.available || !pdfDoc) return Promise.resolve(false);
        if (this._cur_doc === pdfDoc) return Promise.resolve(true);
        if (this._open_failed_doc === pdfDoc) return Promise.resolve(false);
        this._open_serial = this._open_serial
            .then(() => this._open_doc(pdfDoc))
            .catch(() => false);
        return this._open_serial;
    }

    async _open_doc(pdfDoc) {
        // 串行链中前一个请求可能已把同一文档装载完成
        if (this._cur_doc === pdfDoc) return true;
        if (this._open_failed_doc === pdfDoc) return false;

        let bytes;
        try {
            // getData() 返回原字节副本；再复制一份以 transfer（零拷贝移交，
            // 避免与 pdf.js 内部持有的缓冲共享所有权）
            const raw = await pdfDoc.getData();
            bytes = new Uint8Array(raw.length);
            bytes.set(raw);
        } catch (e) {
            console.warn('[render-worker-host] 读取文档字节失败:', e);
            this._open_failed_doc = pdfDoc;
            return false;
        }

        try {
            this._ensure_worker();
            await new Promise((resolve, reject) => {
                const id = ++this._req_id;
                this._open_waiters.set(id, { resolve, reject });
                this._worker.postMessage({ type: 'open', id, data: bytes }, [bytes.buffer]);
            });
            this._cur_doc = pdfDoc;
            return true;
        } catch (e) {
            console.warn('[render-worker-host] 文档投递失败，回退主线程渲染:', e);
            this._open_failed_doc = pdfDoc;
            return false;
        }
    }

    /**
     * 请求渲染一页。is_prerender=true 进入队尾（预渲染让位于可见页），
     * 否则插队首（翻页升清不被后台预渲染挤占）。
     * @returns {Promise<{bitmap: ImageBitmap, width: number, height: number, pageW: number, pageH: number}>}
     *   取消时 reject（name=RenderingCancelledException）；其他错误 reject 普通异常。
     */
    render(pageNum, cssW, dpr, is_prerender = false) {
        if (!this.available) {
            return Promise.reject(new Error('render worker unavailable'));
        }
        return new Promise((resolve, reject) => {
            const reqId = ++this._req_id;
            const item = { reqId, pageNum, cssW, dpr, is_prerender };

            // 按页合流：同页旧请求立即作废（队列中直接出队；在途中向 worker 发 cancel）。
            // 调用方（document_reader）的 seq 守卫本就会丢弃过期结果，提前取消把
            // 渲染槽位让给最新参数——频繁缩放时不再出现「worker 忙着栅格化
            // 注定被丢弃的过期请求」，最新画面更快就位。
            const prev_id = this._by_page.get(pageNum);
            if (prev_id != null) {
                const qi = this._queue.findIndex(it => it.reqId === prev_id);
                if (qi >= 0) {
                    this._queue.splice(qi, 1);
                    const pp = this._pending.get(prev_id);
                    if (pp) {
                        this._pending.delete(prev_id);
                        pp.reject(_cancelled_error());
                    }
                } else if (this._inflight.has(prev_id)) {
                    // inflight 条目保留：worker 回 render-error(cancelled) 时统一清理
                    try { this._worker?.postMessage({ type: 'cancel', req: prev_id }); } catch (_) {}
                }
            }

            // 优先级抢占：可见页请求到达时若在途槽位全被预渲染占用，取消最新
            // 插入的一个预渲染在途任务（进度最少、浪费最小），worker 回 cancelled
            // 后 _drain 会优先派发本请求（unshift 在队首）。否则可见页要排在整页
            // 栅格化（大页可达数百 ms）之后——多指令并发下翻页升清明显延迟。
            if (!is_prerender && this._inflight.size >= this._max_inflight) {
                let preempt_id = null;
                for (const [id, p] of this._inflight) {
                    if (p.is_prerender) preempt_id = id; // Map 迭代序=插入序，取最新
                }
                if (preempt_id != null) {
                    try { this._worker?.postMessage({ type: 'cancel', req: preempt_id }); } catch (_) {}
                }
            }

            // 预渲染队列上限：长距离滚动时积压的预渲染多数已离开视口（过期），
            // 保留只会被逐个栅格化浪费线程时间。超限丢最旧的预渲染（push 序最早、
            // 最可能过期）。被丢请求按取消语义 reject——调用方的预渲染链路
            // 对 RenderingCancelledException 有专门处理，不会卡队列。
            if (is_prerender) {
                let count = 0, oldest = null;
                for (const it of this._queue) {
                    if (!it.is_prerender) continue;
                    count++;
                    if (!oldest) oldest = it;
                }
                if (count >= this._prerender_queue_max && oldest) {
                    const oi = this._queue.indexOf(oldest);
                    if (oi >= 0) this._queue.splice(oi, 1);
                    const op = this._pending.get(oldest.reqId);
                    this._pending.delete(oldest.reqId);
                    if (this._by_page.get(oldest.pageNum) === oldest.reqId) {
                        this._by_page.delete(oldest.pageNum);
                    }
                    if (op) op.reject(_cancelled_error());
                }
            }

            this._pending.set(reqId, { resolve, reject, pageNum, is_prerender });
            this._by_page.set(pageNum, reqId);
            if (is_prerender) this._queue.push(item);
            else this._queue.unshift(item);
            this._drain();
        });
    }

    _drain() {
        if (!this._worker) return;
        while (this._inflight.size < this._max_inflight && this._queue.length > 0) {
            const item = this._queue.shift();
            const p = this._pending.get(item.reqId);
            if (!p) continue; // 已被取消
            this._pending.delete(item.reqId);
            this._inflight.set(item.reqId, p);
            try {
                this._worker.postMessage({
                    type: 'render',
                    req: item.reqId,
                    pageNum: item.pageNum,
                    cssW: item.cssW,
                    dpr: item.dpr
                });
            } catch (e) {
                this._inflight.delete(item.reqId);
                p.reject(e);
            }
        }
    }

    /** 手势期限流：并发上限 2→1，降低后台栅格化与合成线程的 CPU/GPU 争用 */
    set_throttled(on) {
        const next = on ? 1 : 2;
        if (this._max_inflight === next) return;
        this._max_inflight = next;
        if (!on) this._drain(); // 解除限流后立即补发积压请求
    }

    /** 取消指定页的最新一次请求（队列中直接出队；在途中向 worker 发 cancel） */
    cancel_render(pageNum) {
        const reqId = this._by_page.get(pageNum);
        if (reqId == null) return;
        const queued_idx = this._queue.findIndex(it => it.reqId === reqId);
        if (queued_idx >= 0) {
            this._queue.splice(queued_idx, 1);
            const p = this._pending.get(reqId);
            if (p) {
                this._pending.delete(reqId);
                p.reject(_cancelled_error());
            }
            if (this._by_page.get(pageNum) === reqId) this._by_page.delete(pageNum);
            return;
        }
        if (this._inflight.has(reqId)) {
            try { this._worker?.postMessage({ type: 'cancel', req: reqId }); } catch (_) {}
        }
    }

    /** 关闭当前文档（丢弃渲染线程侧字节与解析缓存、取消全部在途请求），worker 保留复用 */
    close_document() {
        this._cur_doc = null;
        this._open_failed_doc = null;
        this._fail_all(_cancelled_error());
        try { this._worker?.postMessage({ type: 'close' }); } catch (_) {}
    }

    /** 彻底销毁（应用退出/阅读器永不再用时才需要） */
    destroy() {
        this.close_document();
        this.available = false;
        try { this._worker?.terminate(); } catch (_) {}
        this._worker = null;
    }
}
