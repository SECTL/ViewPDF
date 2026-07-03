/**
 * 文档加载器 —— PDF/Word 文件加载、渲染、Blob URL 管理的纯工具函数
 * 从 main.js 提取，无状态耦合，供 document_reader.js 和 main.js 共用
 */

/**
 * 初始化 PDF.js worker 路径
 * @returns {boolean} 是否初始化成功
 */
export function init_pdfjs() {
    if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'modules/pdf/pdf.worker.min.mjs';
        // 抑制 PDF.js 的 CMap/ToUnicode 警告（不影响功能）
        window.pdfjsLib.verbosity = 0;
        return true;
    }
    console.warn('[DocLoader] PDF.js 库未加载');
    return false;
}

/**
 * 等待 PDF.js 库加载完成
 * @param {number} max_wait - 最大等待毫秒数
 * @returns {Promise<boolean>} 是否加载成功
 */
export async function wait_pdfjs(max_wait = 5000) {
    const start_time = Date.now();
    while (!window.pdfjsLib && (Date.now() - start_time) < max_wait) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (window.pdfjsLib) {
        init_pdfjs();
        return true;
    }
    return false;
}

/**
 * 读取单个 PDF 页面的元数据，不把页面转成图片。
 * @param {Object} pdf - PDF.js document 对象
 * @param {number} page_num - 页码（1-based）
 * @param {number|null} doc_number - 文档编号（用于生成 sourceId）
 * @returns {Promise<{full: null, thumbnail: null, pageNum: number, sourceId: string|null, loaded: boolean, width: number, height: number, renderMode: string}>}
 */
export async function get_pdf_page_info(pdf, page_num, doc_number) {
    const page = await pdf.getPage(page_num);
    const viewport = page.getViewport({ scale: 1 });
    const source_id = doc_number !== null ? `doc-${doc_number}-${page_num}` : null;
    page.cleanup?.();

    return {
        full: null,
        thumbnail: null,
        pageNum: page_num,
        sourceId: source_id,
        loaded: true,
        width: viewport.width,
        height: viewport.height,
        renderMode: 'pdfjs'
    };
}

/**
 * 构建 PDF 页面列表：只读取页尺寸，页面内容在阅读器中按需直接渲染。
 * @param {Object} pdf - PDF.js document 对象
 * @param {number} total_pages - 总页数
 * @param {number} initial_pages - 保留旧调用签名，不再用于预渲染
 * @param {number|null} doc_number - 文档编号
 * @returns {Promise<Array>} 页面数据数组
 */
export async function render_pdf_pages_lazy(pdf, total_pages, initial_pages = 3, doc_number = null) {
    const pages = [];
    const BATCH_SIZE = 8;

    for (let i = 1; i <= total_pages; i += BATCH_SIZE) {
        const batch_end = Math.min(i + BATCH_SIZE, total_pages + 1);
        const batch = [];
        for (let j = i; j < batch_end; j++) {
            batch.push(get_pdf_page_info(pdf, j, doc_number));
        }
        const batch_results = await Promise.all(batch);
        pages.push(...batch_results);

        update_loading_progress(
            window.i18n?.format_translate('loading.processingPage', { current: batch_end - 1, total: total_pages })
            || `正在处理 ${batch_end - 1}/${total_pages} 页`
        );
    }

    return pages;
}

// ====== 加载/错误 UI ======

/**
 * 显示加载遮罩
 * @param {string} message - 显示的加载消息
 */
export function show_loading_overlay(message) {
    const existing = document.getElementById('loadingOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'loadingOverlay';
    overlay.className = 'loading-overlay';
    overlay.innerHTML = `
        <div class="loading-content">
            <div class="loading-spinner"></div>
            <div class="loading-message" id="loadingMessage">${message}</div>
        </div>
    `;
    document.body.appendChild(overlay);
}

/**
 * 更新加载进度消息
 * @param {string} message - 新的进度消息
 */
export function update_loading_progress(message) {
    const el = document.getElementById('loadingMessage');
    if (el) el.textContent = message;
}

/**
 * 隐藏加载遮罩
 */
export function hide_loading_overlay() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.remove();
}

/**
 * 显示错误弹窗
 * @param {string} title - 错误标题
 * @param {string} message - 错误消息
 * @param {Function|null} retry_callback - 重试回调（可选）
 */
export function show_error_dialog(title, message, retry_callback = null) {
    const existing = document.getElementById('errorDialog');
    if (existing) existing.remove();

    const retry_text = window.i18n?.format_translate('common.retry') || '重试';
    const close_text = window.i18n?.format_translate('common.close') || '关闭';

    const dialog = document.createElement('div');
    dialog.id = 'errorDialog';
    dialog.className = 'error-dialog-overlay';
    dialog.innerHTML = `
        <div class="error-dialog">
            <div class="error-icon">⚠️</div>
            <div class="error-title">${title}</div>
            <div class="error-message">${message}</div>
            <div class="error-buttons">
                ${retry_callback ? `<button class="error-btn error-btn-retry" id="errorRetry">${retry_text}</button>` : ''}
                <button class="error-btn error-btn-close" id="errorClose">${close_text}</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);

    document.getElementById('errorClose')?.addEventListener('click', () => dialog.remove());
    document.getElementById('errorRetry')?.addEventListener('click', () => {
        dialog.remove();
        if (retry_callback) retry_callback();
    });
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.remove();
    });
}

// ====== Blob URL 管理 ======

/**
 * 释放所有文档的全部页面 blob URL
 */
export function revoke_all_document_blob_urls() {
    if (!window.state?.fileList) return;
    window.state.fileList.forEach(folder => {
        folder.pages.forEach(page => {
            if (page.full && page.full.startsWith('blob:')) {
                URL.revokeObjectURL(page.full);
            }
            if (page.thumbnail && page.thumbnail.startsWith('blob:') && page.thumbnail !== page.full) {
                URL.revokeObjectURL(page.thumbnail);
            }
        });
    });
}

export const DocLoader = {
    init_pdfjs,
    wait_pdfjs,
    get_pdf_page_info,
    render_pdf_pages_lazy,
    show_loading_overlay,
    update_loading_progress,
    hide_loading_overlay,
    show_error_dialog,
    revoke_all_document_blob_urls
};
