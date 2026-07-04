/**
 * ViewPDF 初始化 —— 文件管理
 */
import ThemeManager from './themes/theme.js';
import * as Eraser from './modules/eraser/eraser.js';

console.log('[init] module loaded, readyState:', document.readyState);

let currentView = 'recent'; // 'recent' | 'starred'

// 星标状态管理
function get_starred_set() {
    try {
        return new Set(JSON.parse(localStorage.getItem('starred_files') || '[]'));
    } catch(e) { return new Set(); }
}
function save_starred_set(set) {
    localStorage.setItem('starred_files', JSON.stringify([...set]));
}
function toggle_starred(path) {
    const set = get_starred_set();
    if (set.has(path)) set.delete(path); else set.add(path);
    save_starred_set(set);
    return set.has(path);
}
function is_starred(path) {
    return get_starred_set().has(path);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[init] DOMContentLoaded -> initPdfJs');
        window.main_init_pdfjs();
    });
} else {
    console.log('[init] already loaded, calling initPdfJs immediately');
    window.main_init_pdfjs();
}

// 初始化缓存路径（并行获取）
async function dir_init_cache_path() {
    if (window.__TAURI__) {
        try {
            const [cacheDir, configDir] = await Promise.all([
                window.__TAURI__.core.invoke('dir_fetch_cache'),
                window.__TAURI__.core.invoke('dir_fetch_config'),
            ]);
            window.cacheDir = cacheDir;
            window.configDir = configDir;
        } catch (error) {
            console.error('获取缓存目录失败:', error);
        }
    }
}

// 缓存 DOM 元素引用
function dom_init_all() {
    const dom = window.dom;
    dom.canvasContainer = document.getElementById('canvasContainer');
    dom.canvasWrapper = document.getElementById('canvasWrapper');
    dom.imageElement = document.getElementById('imageElement');
    dom.startupScreen = document.getElementById('startupScreen');
    dom.recentFileList = document.getElementById('recentFileList');
    dom.recentFileEmpty = document.getElementById('recentFileEmpty');
    
    // 侧边栏按钮
    dom.sideImportPdf = document.getElementById('sideImportPdf');
    dom.sideRecent = document.getElementById('sideRecent');
    dom.sideStarred = document.getElementById('sideStarred');
    dom.sideSettings = document.getElementById('sideSettings');
    
    // 顶栏按钮
    dom.btnToggleTheme = document.getElementById('btnToggleTheme');
    dom.btnGlobalSettings = document.getElementById('btnGlobalSettings');
    
    // 标题栏按钮
    dom.btnTitleMinimize = document.getElementById('btnTitleMinimize');
    dom.btnTitleMaximize = document.getElementById('btnTitleMaximize');
    dom.btnTitleClose = document.getElementById('btnTitleClose');
    
    // 文档阅读器面板
    dom.documentReaderPanel = document.getElementById('documentReaderPanel');
    dom.docReaderScrollContainer = document.getElementById('docReaderScrollContainer');

    if (!dom.canvasContainer) {
        console.error('必需的元素未找到');
        return false;
    }

    return true;
}

// 加载设置
async function settings_load_config() {
    if (window.__TAURI__) {
        try {
            const { invoke } = window.__TAURI__.core;
            const result = await invoke('settings_fetch_all');
            const settings = (result && typeof result === 'object' && result.settings)
                ? result.settings : {};

            if (settings.theme) {
                await ThemeManager.theme_update_active(settings.theme);
            }
            
            // 加载黑板启用状态
            window.__blackboardEnabled = settings.blackboardEnabled !== false;
            
            console.log('[init] 配置加载完成');
        } catch (error) {
            console.error('加载配置失败:', error);
        }
    }
}

// 绑定事件
function main_setup_events() {
    const dom = window.dom;
    
    // 侧边栏 - 新建导入
    if (dom.sideImportPdf) {
        dom.sideImportPdf.addEventListener('click', () => {
            window.main_load_pdf();
        });
    }
    
    // 侧边栏 - 文件视图
    if (dom.sideRecent) {
        dom.sideRecent.addEventListener('click', () => {
            document.querySelectorAll('.sidebar-item.active').forEach(el => el.classList.remove('active'));
            dom.sideRecent.classList.add('active');
            currentView = 'recent';
            apply_view_filter();
        });
    }
    if (dom.sideStarred) {
        dom.sideStarred.addEventListener('click', () => {
            document.querySelectorAll('.sidebar-item.active').forEach(el => el.classList.remove('active'));
            dom.sideStarred.classList.add('active');
            currentView = 'starred';
            apply_view_filter();
        });
    }
    
    // 视图筛选（在 main_setup_events 中调用，也需暴露给星标按钮）
    window.apply_view_filter = window.apply_view_filter || function() {
        const rows = document.querySelectorAll('.file-row');
        const groups = document.querySelectorAll('.file-time-group');
        if (currentView === 'starred') {
            groups.forEach(g => {
                let hasMatch = false;
                g.querySelectorAll('.file-row').forEach(r => {
                    const path = r.dataset.path;
                    const starred = path && is_starred(path);
                    r.style.display = starred ? '' : 'none';
                    if (starred) hasMatch = true;
                });
                g.style.display = hasMatch ? '' : 'none';
            });
        } else {
            rows.forEach(r => r.style.display = '');
            groups.forEach(g => g.style.display = '');
        }
        const fileList = document.getElementById('recentFileList');
        const empty = fileList?.querySelector('.file-list-empty');
        if (currentView === 'starred' && fileList) {
            const visible = fileList.querySelectorAll('.file-row:not([style*="display: none"])').length === 0;
            if (visible) {
                if (!empty) {
                    const el = document.createElement('div');
                    el.className = 'file-list-empty';
                    el.innerHTML = '<div class="file-list-empty-icon">★</div><span class="file-list-empty-title">暂无星标文件</span><span class="file-list-empty-sub">在文件行上点击 ☆ 即可添加星标</span>';
                    fileList.appendChild(el);
                }
            } else {
                empty?.remove();
            }
        } else {
            empty?.remove();
        }
    };
    const apply_view_filter = window.apply_view_filter;
    
    // 侧边栏 - 底部设置
    if (dom.sideSettings) {
        dom.sideSettings.addEventListener('click', () => {
            window.main_show_settings_window();
        });
    }
    
    // 顶栏按钮
    if (dom.btnGlobalSettings) {
        dom.btnGlobalSettings.addEventListener('click', () => {
            window.main_show_settings_window();
        });
    }
    if (dom.btnToggleTheme) {
        dom.btnToggleTheme.addEventListener('click', () => {
            if (window.ThemeManager) {
                const themes = window.ThemeManager.theme_list?.() || [];
                const cur = window.ThemeManager.current_theme_id;
                const idx = themes.findIndex(t => t.id === cur);
                const next = themes[(idx + 1) % themes.length];
                if (next) window.ThemeManager.theme_apply(next.id);
            }
        });
    }
    
    // 标题栏按钮事件
    if (window.main_setup_all_events) {
        window.main_setup_all_events();
    }
    
    // 视图切换
    const viewList = document.getElementById('viewList');
    const viewGrid = document.getElementById('viewGrid');
    const fileListEl = document.getElementById('recentFileList');
    if (viewList) {
        viewList.addEventListener('click', () => {
            viewList.classList.add('active');
            viewGrid?.classList.remove('active');
            fileListEl?.classList.remove('grid-view');
        });
    }
    if (viewGrid) {
        viewGrid.addEventListener('click', () => {
            viewGrid.classList.add('active');
            viewList?.classList.remove('active');
            fileListEl?.classList.add('grid-view');
        });
    }
    
    // 搜索过滤
    const fileSearch = document.getElementById('fileSearch');
    if (fileSearch) {
        const clearBtn = document.getElementById('searchClear');
        const doFilter = () => {
            const q = fileSearch.value.trim().toLowerCase();
            if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';
            const rows = document.querySelectorAll('.file-row');
            const groups = document.querySelectorAll('.file-time-group');
            if (!q) {
                rows.forEach(r => r.style.display = '');
                groups.forEach(g => g.style.display = '');
                return;
            }
            groups.forEach(g => {
                let groupHasMatch = false;
                g.querySelectorAll('.file-row').forEach(r => {
                    const nameEl = r.querySelector('.name-text');
                    const match = nameEl && nameEl.textContent.toLowerCase().includes(q);
                    r.style.display = match ? '' : 'none';
                    if (match) groupHasMatch = true;
                });
                g.style.display = groupHasMatch ? '' : 'none';
            });
        };
        fileSearch.addEventListener('input', doFilter);
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                fileSearch.value = '';
                if (clearBtn) clearBtn.style.display = 'none';
                const rows = document.querySelectorAll('.file-row');
                const groups = document.querySelectorAll('.file-time-group');
                rows.forEach(r => r.style.display = '');
                groups.forEach(g => g.style.display = '');
                fileSearch.focus();
            });
        }
    }
    
    // 文件打开事件
    window.main_setup_pdf_file_open();
    
    // 加载最近打开文件列表
    window.main_load_recent_files?.();
    
    // 拖拽导入
    main_setup_dragdrop();
    
    console.log('[init] 事件绑定完成');
}

// 拖拽导入支持
function main_setup_dragdrop() {
    const dropZone = document.getElementById('startupScreen') || document.querySelector('.app-main');
    if (!dropZone) return;
    
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });
    
    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
    });
    
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            const file = files[0];
            if (file.name.toLowerCase().endsWith('.pdf')) {
                const path = file.path || file.name;
                window.main_load_pdf_from_path?.(path, true);
            }
        }
    });
}

// 渲染最近打开文件列表
const FILE_EXT_COLORS = {
    pdf: { cls: 'type-pdf', label: 'PDF' },
    doc: { cls: 'type-doc', label: 'WD' },
    docx: { cls: 'type-doc', label: 'WD' },
    xls: { cls: 'type-xls', label: 'XL' },
    xlsx: { cls: 'type-xls', label: 'XL' },
    ppt: { cls: 'type-ppt', label: 'PP' },
    pptx: { cls: 'type-ppt', label: 'PP' },
    png: { cls: 'type-image', label: 'PN' },
    jpg: { cls: 'type-image', label: 'JP' },
    jpeg: { cls: 'type-image', label: 'JP' },
    gif: { cls: 'type-image', label: 'GF' },
    bmp: { cls: 'type-image', label: 'BM' },
    webp: { cls: 'type-image', label: 'WP' },
    xmind: { cls: 'type-mindmap', label: 'XM' },
    mindnode: { cls: 'type-mindmap', label: 'MN' },
};

function file_type_info(path) {
    const ext = (path || '').split('.').pop().toLowerCase();
    return FILE_EXT_COLORS[ext] || { cls: 'type-other', label: ext ? ext.toUpperCase().slice(0, 2) : '??' };
}

function format_file_size(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function time_group_label(time) {
    if (!time) return '更早';
    const now = Date.now();
    const diff = now - time;
    const oneDay = 86400000;
    if (diff < oneDay) return '今天';
    if (diff < 2 * oneDay) return '昨天';
    if (diff < 7 * oneDay) return '本周';
    if (diff < 30 * oneDay) return '本月';
    return '更早';
}

function format_access_time(time) {
    if (!time) return '';
    const d = new Date(time);
    const now = new Date();
    const diff = now - d;
    const oneDay = 86400000;
    if (diff < oneDay) {
        return '今天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    if (diff < 2 * oneDay) return '昨天 ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (d.getFullYear() === now.getFullYear()) {
        return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    }
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
}

function norm_file_entry(f) {
    if (typeof f === 'string') {
        return { path: f, name: f.split(/[/\\]/).pop(), time: null, size: null };
    }
    return { path: f.path || '', name: f.name || f.path?.split(/[/\\]/).pop() || '', time: f.time || null, size: f.size || null };
}

window.main_render_recent_files = (files) => {
    const dom = window.dom;
    if (!dom.recentFileList) return;
    dom.recentFileList.innerHTML = '';

    if (!files || files.length === 0) {
        return;
    }

    const entries = files.map(norm_file_entry);

    // 按时间分组
    const groups = {};
    for (const e of entries) {
        const label = time_group_label(e.time);
        if (!groups[label]) groups[label] = [];
        groups[label].push(e);
    }
    const groupOrder = ['今天', '昨天', '本周', '本月', '更早'];

    for (const label of groupOrder) {
        const items = groups[label];
        if (!items || items.length === 0) continue;

        const groupDiv = document.createElement('div');
        groupDiv.className = 'file-time-group';

        const header = document.createElement('div');
        header.className = 'file-time-header';
        header.innerHTML = label + ' <span class="file-time-count">' + items.length + '</span>';
        groupDiv.appendChild(header);

        for (const entry of items) {
            const info = file_type_info(entry.path);
            const ext = (entry.path || '').split('.').pop().toLowerCase();

            const row = document.createElement('div');
            row.className = 'file-row';
            row.tabIndex = 0;
            row.dataset.path = entry.path;

            const icon = document.createElement('div');
            icon.className = 'file-type-icon ' + info.cls;
            if (ext === 'pdf') {
                icon.innerHTML = '<img src="assets/pdf.ico" style="width:20px;height:20px">';
            } else if (ext === 'doc' || ext === 'docx') {
                icon.innerHTML = '<img src="assets/word.ico" style="width:20px;height:20px">';
            } else {
                icon.textContent = info.label;
            }

            const infoDiv = document.createElement('div');
            infoDiv.className = 'file-row-info';

            const nameDiv = document.createElement('div');
            nameDiv.className = 'file-row-name';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'name-text';
            nameSpan.textContent = entry.name;

            nameDiv.appendChild(nameSpan);

            const extBadge = document.createElement('span');
            extBadge.className = 'file-ext-badge';
            extBadge.textContent = ext || '?';
            nameDiv.appendChild(extBadge);

            infoDiv.appendChild(nameDiv);

            const metaDiv = document.createElement('div');
            metaDiv.className = 'file-row-meta';

            const sourceSpan = document.createElement('span');
            sourceSpan.className = 'meta-item';
            sourceSpan.textContent = '本地';
            metaDiv.appendChild(sourceSpan);

            if (entry.time) {
                const timeSpan = document.createElement('span');
                timeSpan.className = 'meta-item';
                timeSpan.textContent = format_access_time(entry.time);
                metaDiv.appendChild(timeSpan);
            } else {
                const emptySpan = document.createElement('span');
                emptySpan.className = 'meta-item';
                metaDiv.appendChild(emptySpan);
            }

            if (entry.size != null) {
                const sizeSpan = document.createElement('span');
                sizeSpan.className = 'meta-item';
                sizeSpan.textContent = format_file_size(entry.size);
                metaDiv.appendChild(sizeSpan);
            } else {
                const emptySpan = document.createElement('span');
                emptySpan.className = 'meta-item';
                metaDiv.appendChild(emptySpan);
            }

            infoDiv.appendChild(metaDiv);

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'file-row-actions';

            const btnStar = document.createElement('button');
            btnStar.className = 'row-action' + (is_starred(entry.path) ? ' starred' : '');
            btnStar.innerHTML = '★';
            btnStar.title = '星标';
            btnStar.addEventListener('click', (e) => {
                e.stopPropagation();
                toggle_starred(entry.path);
                btnStar.classList.toggle('starred');
                if (currentView === 'starred') window.apply_view_filter?.();
            });

            const btnDelete = document.createElement('button');
            btnDelete.className = 'row-action';
            btnDelete.innerHTML = '✕';
            btnDelete.title = '删除';
            btnDelete.addEventListener('click', (e) => {
                e.stopPropagation();
                console.log('删除:', entry.path);
            });

            actionsDiv.appendChild(btnStar);
            actionsDiv.appendChild(btnDelete);

            row.appendChild(icon);
            row.appendChild(infoDiv);
            row.appendChild(actionsDiv);

            row.addEventListener('click', () => {
                window.main_load_pdf_from_path?.(entry.path, true);
            });

            groupDiv.appendChild(row);
        }

        dom.recentFileList.appendChild(groupDiv);
    }

    if (window.ThemeManager?.theme_load_icons) {
        window.ThemeManager.theme_load_icons();
    }
    
    // 渲染后根据当前视图过滤
    if (currentView !== 'recent') window.apply_view_filter?.();
};

// 黑板懒加载函数
window.blackboard_ensure_loaded = (async (container) => {
    if (window.blackboardManager) {
        if (!window.blackboardManager.bb_wrapper) {
            window.blackboardManager.init(container);
        }
        return window.blackboardManager;
    }
    try {
        await import('./modules/blackboard/blackboard.js');
        if (!window.blackboardManager.bb_wrapper) {
            window.blackboardManager.init(container);
        }
        return window.blackboardManager;
    } catch (e) {
        console.error('[blackboard] failed to load:', e);
        return null;
    }
});

// 主初始化入口
async function main_init_all() {
    console.log('[init] main_init_all start');
    try {
        window.__eraser = Eraser;

        if (window.i18n) {
            await window.i18n.init_start();
        }
        
        if (window.__TAURI__) {
            const isOobeActive = await window.__TAURI__.core.invoke('oobe_check_active');
            if (isOobeActive) {
                return;
            }
        }
        
        if (!dom_init_all()) {
            throw new Error('DOM 初始化失败');
        }
        
        await dir_init_cache_path();
        await settings_load_config();

        // 初始化文档阅读器
        if (window.documentReaderManager) {
            window.documentReaderManager.init();
        }

        // 绑定事件
        main_setup_events();

        // 初始化标签管理器和UI状态
        if (window.main_update_tabs) {
            window.main_update_tabs();
        }
        if (window.main_update_ui_state) {
            window.main_update_ui_state();
        }

        // 延迟加载黑板（窗口已显示后再加载，不阻塞启动）
        if (window.__blackboardEnabled !== false) {
            setTimeout(async () => {
                try {
                    const bb = await window.blackboard_ensure_loaded(document.body);
                    if (bb) {
                        bb.setup_toolbar_events();
                    }
                } catch (e) {
                    console.error('[init] blackboard lazy load error:', e);
                }
            }, 0);
        }

        // 恢复上次打开的文档
        if (window.documentReaderManager) {
            window.__TAURI__?.core?.invoke('settings_fetch_all').then(result => {
                const settings = (result && typeof result === 'object' && result.settings)
                    ? result.settings : {};
                if (settings.restoreLastDoc !== false) {
                    window.documentReaderManager.restore_last_document().catch(e => {
                        console.log('[init] 恢复上次文档失败:', e);
                    });
                }
            }).catch(e => {
                console.log('[init] 读取设置失败:', e);
            });
        }

    } catch (error) {
        console.error('初始化失败:', error);
        window.main_show_error_dialog(
            window.i18n?.format_translate('errors.initFailed') || '初始化失败',
            window.i18n?.format_translate('errors.initFailedDesc') || '应用初始化失败，请刷新页面重试'
        );
    }
}

// 启动
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main_init_all());
} else {
    main_init_all();
}

// 清理
document.addEventListener('beforeunload', () => {
    if (window.documentReaderManager) {
        if (window.__restoreLastDocEnabled) {
            window.documentReaderManager._save_annotations_to_cache?.();
            window.documentReaderManager._save_last_doc_state?.();
        } else {
            window.documentReaderManager.destroy?.();
            window.documentReaderManager.delete_annotation_cache_files?.();
        }
    }
});
