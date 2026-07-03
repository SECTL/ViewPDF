/**
 * 文档阅读器多页管理器
 * 管理每页的批注数据、TileRenderer 实例、DOM 元素引用
 * 与 BlackboardPageManager 结构对齐，支持懒加载和分块渲染
 */

export class DocumentReaderPageManager {
    constructor() {
        this.pages_list = [];
        this.current_index = -1;
    }

    /**
     * 从文件列表初始化页面数据
     * @param {Array} folder_pages - 文件夹的 pages 数组（来自 state.fileList）
     */
    init_from_folder_pages(folder_pages) {
        this.pages_list = folder_pages.map((page_data, index) => ({
            stroke_history: [],
            undo_list: [],
            redo_list: [],
            image_url: page_data.full,
            thumbnail_url: page_data.thumbnail || page_data.full,
            render_mode: page_data.renderMode || 'image',
            page_num: page_data.pageNum,
            page_width: page_data.width || 0,
            page_height: page_data.height || 0,
            coord_width: 0,
            coord_height: 0,
            aspect_ratio: page_data.width && page_data.height ? page_data.width / page_data.height : 0,
            tile_renderer: null,
            is_tiles_initialized: false,
            is_visible: false,
            is_virtualized: false,
            loading_promise: null,
            overlay_canvas: null,
            overlay_ctx: null,
            pdf_canvas: null,
            pdf_render_css_width: 0,
            pdf_render_promise: null,
            pdf_render_task: null,
            pdf_text_layer: null,
            page_element: null,
            index: index
        }));
        this.current_index = 0;
    }

    get_page_count() {
        return this.pages_list.length;
    }

    get_current_page() {
        if (this.current_index < 0 || this.current_index >= this.pages_list.length) return null;
        return this.pages_list[this.current_index];
    }

    switch_page(index) {
        if (index < 0 || index >= this.pages_list.length) return false;
        if (index === this.current_index) return false;
        this.current_index = index;
        return true;
    }

    nav_prev() {
        if (this.current_index <= 0) return false;
        return this.switch_page(this.current_index - 1);
    }

    nav_next() {
        if (this.current_index >= this.pages_list.length - 1) return false;
        return this.switch_page(this.current_index + 1);
    }

    destroy() {
        for (const page of this.pages_list) {
            if (page.tile_renderer) {
                page.tile_renderer.destroy();
                page.tile_renderer = null;
            }
            page.is_tiles_initialized = false;
            if (page.overlay_canvas && page.overlay_canvas.parentNode) {
                page.overlay_canvas.parentNode.removeChild(page.overlay_canvas);
            }
            if (page.pdf_render_task) {
                page.pdf_render_task.cancel?.();
            }
            if (page.pdf_canvas) {
                page.pdf_canvas.width = 0;
                page.pdf_canvas.height = 0;
            }
            page.overlay_canvas = null;
            page.overlay_ctx = null;
            page.pdf_canvas = null;
            page.pdf_render_css_width = 0;
            page.pdf_render_promise = null;
            page.pdf_render_task = null;
            page.pdf_text_layer = null;
            page.page_element = null;
        }
        this.pages_list = [];
        this.current_index = -1;
    }
}
