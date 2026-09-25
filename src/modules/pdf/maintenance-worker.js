/**
 * 维护线程（module worker）——与渲染线程（render-worker.js）相互独立。
 *
 * 职责：把主线程上的「序列化 / 反序列化」类回收加载任务搬离主线程：
 * - 批注缓存保存：JSON.stringify（大笔画文档可达数 MB 字符串，主线程执行会卡顿）
 * - 批注缓存恢复：JSON.parse
 *
 * 设计约束（与渲染线程宿主同一套失败语义）：
 * - 本线程是纯加速层，不承担正确性——创建失败 / 崩溃 / 单条消息处理失败时，
 *   宿主回退主线程 JSON.stringify/parse，功能不受影响。
 * - 无 UI 依赖、无第三方依赖；消息协议按 id 配对，串行处理（JSON 大对象
 *   并行无收益，串行避免内存峰值叠加）。
 */

let _seq = 0;

self.onmessage = (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    // 回显宿主 id（配对语义）；缺失时用本线程计数兜底
    const id = (typeof msg.id === 'number') ? msg.id : ++_seq;
    try {
        switch (msg.type) {
            case 'stringify': {
                // 入参对象经结构化克隆到达（native serializer，主线程成本远低于 JS 级 stringify），
                // JS 级 stringify 的 CPU 成本发生在本线程
                const json = JSON.stringify(msg.data);
                self.postMessage({ type: 'stringify-done', id, json });
                break;
            }
            case 'parse': {
                const obj = JSON.parse(msg.json);
                self.postMessage({ type: 'parse-done', id, data: obj });
                break;
            }
            case 'ping': {
                self.postMessage({ type: 'pong', id });
                break;
            }
            default:
                self.postMessage({ type: 'error', id, error: 'unknown type: ' + msg.type });
        }
    } catch (err) {
        self.postMessage({ type: 'error', id, error: String(err?.message || err) });
    }
};

self.addEventListener('error', (e) => {
    // 单条消息异常已按 id 回 error；这里兜底上报致命错误
    self.postMessage({ type: 'fatal', error: String(e?.message || 'unknown') });
});
