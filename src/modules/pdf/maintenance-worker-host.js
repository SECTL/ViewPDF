/**
 * 维护线程宿主（主线程侧懒创建单例用法）。
 *
 * 职责：
 * - worker 生命周期管理（懒创建、崩溃检测、失败置死）
 * - 批注缓存的 JSON.stringify / JSON.parse 派发与 Promise 配对
 *
 * 失败语义：本线程是纯加速层，不承担正确性——创建失败 / 崩溃 /
 * 单条消息处理失败时，available=false，调用方回退主线程
 * JSON.stringify / JSON.parse（见 document_reader 的 _maint_* 包装）。
 *
 * 与渲染线程（render-worker-host）刻意分离：序列化任务不得挤占
 * 栅格化线程的并发槽位——两类任务分属不同线程，互不排队。
 */

const CREATE_TIMEOUT_MS = 0; // Worker 创建本身同步失败由 try/catch 捕获

export class MaintenanceWorkerHost {
    constructor() {
        this.available = typeof Worker !== 'undefined';
        this._worker = null;
        this._failed = false;          // 创建/致命失败：本会话不再重试
        this._waiters = new Map();     // id -> {resolve, reject}
        this._req_id = 0;
    }

    _ensure_worker() {
        if (this._worker) return this._worker;
        if (this._failed) return null;
        try {
            this._worker = new Worker('modules/pdf/maintenance-worker.js', { type: 'module' });
            this._worker.onmessage = (e) => this._on_message(e.data);
            this._worker.onerror = (e) => {
                this._on_worker_down('worker error: ' + (e?.message || 'unknown'));
            };
            this._worker.onmessageerror = () => this._on_worker_down('worker messageerror');
            return this._worker;
        } catch (e) {
            console.warn('[maintenance-worker-host] 创建失败，回退主线程:', e);
            this._failed = true;
            this.available = false;
            return null;
        }
    }

    _on_message(msg) {
        switch (msg?.type) {
            case 'stringify-done':
            case 'parse-done': {
                const w = this._waiters.get(msg.id);
                if (w) {
                    this._waiters.delete(msg.id);
                    w.resolve(msg.type === 'parse-done' ? msg.data : msg.json);
                }
                break;
            }
            case 'error': {
                const w = this._waiters.get(msg.id);
                if (w) {
                    this._waiters.delete(msg.id);
                    w.reject(new Error(msg.error || 'maintenance worker error'));
                }
                break;
            }
            case 'fatal': {
                console.warn('[maintenance-worker-host] 维护线程致命异常:', msg.error);
                this._on_worker_down('fatal: ' + msg.error);
                break;
            }
        }
    }

    /** 崩溃置死：所有在途请求拒绝（调用方回退主线程），本会话不再重试 */
    _on_worker_down(reason) {
        if (this._failed && !this._worker) return;
        console.warn('[maintenance-worker-host] 维护线程不可用，回退主线程:', reason);
        this._failed = true;
        this.available = false;
        const err = new Error(reason);
        for (const w of this._waiters.values()) w.reject(err);
        this._waiters.clear();
        try { this._worker?.terminate(); } catch (_) {}
        this._worker = null;
    }

    _post(msg, transfer) {
        const worker = this._ensure_worker();
        if (!worker) return Promise.reject(new Error('maintenance worker unavailable'));
        const id = ++this._req_id;
        return new Promise((resolve, reject) => {
            this._waiters.set(id, { resolve, reject });
            try {
                worker.postMessage({ ...msg, id }, transfer || []);
            } catch (e) {
                // 结构化克隆失败（含不可克隆对象）：按单条失败处理
                this._waiters.delete(id);
                reject(e);
            }
        });
    }

    /**
     * JSON.stringify 在维护线程执行。入参经结构化克隆发送
     * （native 序列化，主线程成本远低于 JS 级 stringify）。
     * @returns {Promise<string>}
     */
    stringify(data) {
        if (!this.available) return Promise.reject(new Error('maintenance worker unavailable'));
        return this._post({ type: 'stringify', data });
    }

    /**
     * JSON.parse 在维护线程执行。字符串按拷贝发送（native memcpy）。
     * @returns {Promise<object>}
     */
    parse(json) {
        if (!this.available) return Promise.reject(new Error('maintenance worker unavailable'));
        return this._post({ type: 'parse', json });
    }
}
