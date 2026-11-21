/**
 * ViewPDF 开发者选项
 * 通过关于页面图标点击5次打开
 */

async function developer_options_init() {
    // 从后端加载已保存的值（设置面板无 DRAW_CONFIG，必须读后端）
    const invoke = window.__TAURI__?.core?.invoke;
    let savedWidthRatio = 0.4;
    let savedMaxScale = 4;
    let savedDevMode = true;
    let savedFrameDelta = 60;
    let savedTailDuration = 50;
    let savedEllipseStroke = false;

    if (invoke) {
        try {
            const result = await invoke('settings_fetch_all');
            const s = result?.settings || {};
            // 优先使用 DRAW_CONFIG（主窗口），否则用后端保存值，最后用硬编码默认
            savedWidthRatio = window.DRAW_CONFIG?.penMinWidthRatio
                ?? s.penMinWidthRatio
                ?? 0.4;
            savedMaxScale = window.DRAW_CONFIG?.maxScaleImage
                ?? s.maxScaleImage
                ?? 4;
            savedDevMode = s.developerMode !== false;
            savedFrameDelta = window.DRAW_CONFIG?.gestureFrameDelta
                ?? s.gestureFrameDelta
                ?? 60;
            savedTailDuration = window.DRAW_CONFIG?.penTailDuration
                ?? s.penTailDuration
                ?? 30;
            savedEllipseStroke = s.ellipseStrokeEnabled === true;
        } catch (_) {
            savedWidthRatio = window.DRAW_CONFIG?.penMinWidthRatio ?? 0.4;
            savedMaxScale = window.DRAW_CONFIG?.maxScaleImage ?? 4;
        }
    } else {
        savedWidthRatio = window.DRAW_CONFIG?.penMinWidthRatio ?? 0.4;
        savedMaxScale = window.DRAW_CONFIG?.maxScaleImage ?? 4;
    }

    developer_options_show_main(savedWidthRatio, savedMaxScale, savedDevMode, savedFrameDelta, savedTailDuration, savedEllipseStroke);
}

function _tk(key) { return window.i18n?.format_translate(key) ?? key; }

/**
 * 纯 DOM 构造器：所有文本只能经 textContent / value 写入。
 * 动态值（配置值、i18n 文案）永不拼进 HTML 字符串后交给浏览器解析。
 */
function _devEl(tag, cfg, children) {
    const node = document.createElement(tag);
    const c = cfg || {};
    if (c.id !== undefined) node.id = c.id;
    if (c.className !== undefined) node.className = c.className;
    if (c.text !== undefined) node.textContent = c.text;
    if (c.for !== undefined) node.htmlFor = c.for;
    if (c.style !== undefined) node.style.cssText = c.style;
    if (c.attrs) {
        for (const k of Object.keys(c.attrs)) {
            const v = c.attrs[k];
            if (v === true) node.setAttribute(k, '');
            else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, String(v));
        }
    }
    if (children) {
        for (const child of children) {
            if (child === null || child === undefined) continue;
            node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
        }
    }
    return node;
}

/** 原生 <select>：键盘与读屏可直接使用，选项与当前值都来自 JS 数据而非模板串。 */
function _devNativeSelect(id, presets, currentValue, currentLabel, parseFn) {
    const select = _devEl('select', { id: id, className: 'sp-select-native' });
    let matched = false;
    presets.forEach(p => {
        const opt = _devEl('option', { text: p.label });
        opt.value = p.value;
        if (parseFn(p.value) === currentValue) {
            opt.selected = true;
            matched = true;
        }
        select.appendChild(opt);
    });
    // 当前值不在预设表里时补一个选项，保持和旧自定义下拉一致的显示
    if (!matched) {
        const opt = _devEl('option', { text: currentLabel });
        opt.value = String(currentValue);
        opt.selected = true;
        select.appendChild(opt);
    }
    return select;
}

function developer_options_show_main(currentWidthRatio, currentMaxScale, devModeEnabled, currentFrameDelta, currentTailDuration, ellipseStrokeEnabled) {
    const page = document.getElementById('pageDevOptions');
    if (!page) return;
    const devModeOn = devModeEnabled !== false;
    // 事件回调单独取 invoke：它不在 developer_options_init 的词法作用域内
    const invoke = window.__TAURI__?.core?.invoke;

    const _presetDefault = _tk('developer.presetDefault');
    const _presetDisabled = _tk('developer.presetDisabled');
    const _displayDefault = _tk('developer.displayDefault');

    const widthPresets = [
        { value: '0.05', label: '0.05' },
        { value: '0.1', label: '0.10' },
        { value: '0.15', label: '0.15' },
        { value: '0.2', label: '0.20' },
        { value: '0.25', label: '0.25' },
        { value: '0.3', label: '0.30' },
        { value: '0.4', label: `0.40${_presetDefault}` },
        { value: '0.5', label: '0.50' },
        { value: '0.75', label: '0.75' },
        { value: '1', label: '1.00' },
    ];
    const currentWidthLabel = widthPresets.find(p => parseFloat(p.value) === currentWidthRatio)?.label
        || currentWidthRatio.toFixed(2);

    const scalePresets = [
        { value: '2', label: '2x' },
        { value: '3', label: '3x' },
        { value: '4', label: `4x${_presetDefault}` },
        { value: '5', label: '5x' },
        { value: '6', label: '6x' },
        { value: '8', label: '8x' },
        { value: '10', label: '10x' },
    ];
    const currentScaleLabel = scalePresets.find(p => parseInt(p.value) === currentMaxScale)?.label
        || `${currentMaxScale}x`;

    const frameDeltaPresets = [
        { value: '60', label: `60px${_presetDefault}` },
        { value: '100', label: '100px' },
        { value: '200', label: '200px' },
        { value: '500', label: '500px' },
        { value: '1000', label: '1000px' },
    ];
    const currentFrameDeltaLabel = frameDeltaPresets.find(p => parseInt(p.value) === currentFrameDelta)?.label
        || `${currentFrameDelta}px`;

    const currentTailDurationVal = currentTailDuration ?? 30;

    // 开发者模式复选框：原生 switch 布尔属性 + 旧浏览器 ARIA 回退
    const devModeToggle = _devEl('input', { id: 'devModeToggle', attrs: { type: 'checkbox' } });
    devModeToggle.setAttribute('switch', '');
    if (devModeOn) devModeToggle.checked = true;
    if (typeof HTMLInputElement !== 'undefined' && !('switch' in HTMLInputElement.prototype)) {
        devModeToggle.setAttribute('role', 'switch');
    }

    // 一次性构造整页结构；不经 HTML 字符串解析
    page.replaceChildren(
        _devEl('h2', { className: 'sp-page-title', text: _tk('developer.title') }),

        _devEl('div', {
            className: 'sp-setting-item',
            style: 'border-bottom-color:var(--color-hairline, rgba(255,255,255,0.08));'
        }, [
            _devEl('label', {
                className: 'sp-setting-label',
                for: 'devModeToggle',
                text: _tk('developer.devMode')
            }),
            _devEl('label', { className: 'sp-toggle-switch' }, [
                devModeToggle,
                _devEl('span', { className: 'sp-toggle-slider' })
            ])
        ]),

        _devEl('div', { className: 'sp-setting-item' }, [
            _devEl('label', {
                className: 'sp-setting-label',
                for: 'devWidthRatioSelect',
                text: _tk('developer.widthRatio')
            }),
            _devNativeSelect('devWidthRatioSelect', widthPresets, currentWidthRatio, currentWidthLabel, v => parseFloat(v))
        ]),

        _devEl('div', { className: 'sp-setting-item' }, [
            _devEl('label', {
                className: 'sp-setting-label',
                for: 'devMaxScaleSelect',
                text: _tk('developer.maxScale')
            }),
            _devNativeSelect('devMaxScaleSelect', scalePresets, currentMaxScale, currentScaleLabel, v => parseInt(v, 10))
        ]),

        _devEl('div', { className: 'sp-setting-item' }, [
            _devEl('label', {
                className: 'sp-setting-label',
                for: 'devFrameDeltaSelect',
                text: _tk('developer.frameDelta')
            }),
            _devNativeSelect('devFrameDeltaSelect', frameDeltaPresets, currentFrameDelta, currentFrameDeltaLabel, v => parseInt(v, 10))
        ]),

        _devEl('div', { className: 'sp-setting-item' }, [
            _devEl('label', {
                className: 'sp-setting-label',
                for: 'devTailDurationInput',
                text: _tk('developer.tailDuration')
            }),
            _devEl('div', { style: 'display:flex;align-items:center;gap:6px;' }, [
                _devEl('input', {
                    id: 'devTailDurationInput',
                    className: 'sp-dev-number-input',
                    attrs: {
                        type: 'number',
                        value: currentTailDurationVal,
                        min: '0',
                        max: '500',
                        step: '1'
                    }
                }),
                _devEl('span', { style: 'font-size:12px;color:var(--color-muted, #888);', text: 'ms' })
            ])
        ]),

        _devEl('div', { className: 'sp-setting-item' }, [
            _devEl('span', { className: 'sp-setting-label', text: _tk('developer.docDetection') }),
            _devEl('span', {
                id: 'devGoDetection',
                style: 'cursor:pointer;font-size:18px;color:var(--color-muted, #888);padding:4px;',
                text: '→'
            })
        ])
    );

    document.getElementById('devGoDetection')?.addEventListener('click', developer_options_show_detection);

    // 初始化设置面板里的其它自定义下拉框（开发者选项自身已改用原生 select）
    if (typeof window.settings_init_all_selects === 'function') {
        window.settings_init_all_selects();
    }

    // 开发者模式开关
    (function setup_dev_mode_toggle() {
        const toggle = document.getElementById('devModeToggle');
        if (!toggle) return;
        toggle.addEventListener('change', () => {
            const enabled = toggle.checked;
            if (invoke) {
                invoke('settings_save_all', { settings: { developerMode: enabled } });
            }
            /* 同步隐藏/显示侧边栏按钮 */
            const devBtn = document.getElementById('btnDevOptions');
            if (devBtn) devBtn.style.display = enabled ? '' : 'none';
        });
    })();

    // 宽度比例选择器
    (function setup_width_ratio_select() {
        const select = document.getElementById('devWidthRatioSelect');
        if (!select) return;
        select.addEventListener('change', () => {
            const v = parseFloat(select.value);
            if (isNaN(v)) return;
            if (window.DRAW_CONFIG) {
                window.DRAW_CONFIG.penMinWidthRatio = v;
            }
            if (invoke) {
                invoke('settings_save_all', { settings: { penMinWidthRatio: v, developerMode: true } });
            }
        });
    })();

    // 最大缩放选择器
    (function setup_max_scale_select() {
        const select = document.getElementById('devMaxScaleSelect');
        if (!select) return;
        select.addEventListener('change', () => {
            const v = parseInt(select.value, 10);
            if (isNaN(v)) return;
            if (window.DRAW_CONFIG) {
                window.DRAW_CONFIG.maxScaleImage = v;
            }
            if (invoke) {
                invoke('settings_save_all', { settings: { maxScaleImage: v, developerMode: true } });
            }
        });
    })();

    // 单帧手势位移上限选择器
    (function setup_frame_delta_select() {
        const select = document.getElementById('devFrameDeltaSelect');
        if (!select) return;
        select.addEventListener('change', () => {
            const v = parseInt(select.value, 10);
            if (isNaN(v)) return;
            if (window.DRAW_CONFIG) {
                window.DRAW_CONFIG.gestureFrameDelta = v;
            }
            if (invoke) {
                invoke('settings_save_all', { settings: { gestureFrameDelta: v, developerMode: true } });
            }
        });
    })();

    // 收尾时长输入框
    (function setup_tail_duration_input() {
        const input = document.getElementById('devTailDurationInput');
        if (!input) return;

        let saveTimer = null;
        input.addEventListener('input', () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                const v = parseInt(input.value);
                if (isNaN(v) || v < 0) return;
                const val = Math.min(500, Math.max(0, v));
                input.value = val;
                if (window.DRAW_CONFIG) {
                    window.DRAW_CONFIG.penTailDuration = val;
                }
                if (invoke) {
                    invoke('settings_save_all', { settings: { penTailDuration: val, developerMode: true } });
                }
            }, 300);
        });
    })();

    // 椭圆笔迹渲染开关
    (function setup_ellipse_stroke_toggle() {
        const toggle = document.getElementById('devEllipseStrokeToggle');
        if (!toggle) return;
        toggle.addEventListener('change', () => {
            const enabled = toggle.checked;
            if (window.DRAW_CONFIG) {
                window.DRAW_CONFIG.ellipseStrokeEnabled = enabled;
            }
            if (window.batchDrawManager) {
                window.batchDrawManager.ellipseMode = enabled;
            }
            // 同步到阅读器和黑板的独立 batch_draw 实例
            const docReader = window.documentReaderManager;
            if (docReader?.batch_draw) {
                docReader.batch_draw.ellipseMode = enabled;
            }
            const bb = window.blackboardManager;
            if (bb?.drawing_engine?.batch_draw) {
                bb.drawing_engine.batch_draw.ellipseMode = enabled;
            }
            if (invoke) {
                invoke('settings_save_all', { settings: { ellipseStrokeEnabled: enabled } });
            }
        });
    })();

}

function developer_options_show_detection() {
    const page = document.getElementById('pageDevOptions');
    if (!page) return;

    const notDetected = _tk('developer.notDetected');
    const detectLabel = _tk('developer.docDetection');
    const rows = [
        { label: _tk('developer.detectMsOffice'), id: 'devWordStatus', check: 'word' },
        { label: _tk('developer.detectWps'), id: 'devWpsStatus', check: 'wps' },
        { label: _tk('developer.detectLibreOffice'), id: 'devLibreStatus', check: 'libreoffice' }
    ];

    page.replaceChildren(
        _devEl('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:16px;' }, [
            _devEl('span', {
                id: 'devBackToMain',
                style: 'cursor:pointer;font-size:18px;color:var(--color-muted, #888);padding:4px;',
                text: _tk('developer.backToMain')
            }),
            _devEl('h2', { className: 'sp-page-title', style: 'margin:0;', text: _tk('developer.detectionTitle') })
        ]),
        ...rows.map(r => _devEl('div', { className: 'sp-setting-item' }, [
            _devEl('span', { className: 'sp-setting-label', text: r.label }),
            _devEl('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
                _devEl('span', {
                    id: r.id,
                    style: 'font-size:13px;color:var(--color-muted, #888);',
                    text: notDetected
                }),
                _devEl('button', {
                    className: 'sp-btn-action',
                    attrs: { 'data-check': r.check },
                    text: detectLabel
                })
            ])
        ]))
    );

    document.getElementById('devBackToMain')?.addEventListener('click', developer_options_init);

    const statusIds = { word: 'devWordStatus', wps: 'devWpsStatus', libreoffice: 'devLibreStatus' };
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) return;

    document.querySelectorAll('[data-check]').forEach(btn => {
        btn.addEventListener('click', () => {
            const check = btn.dataset.check;
            const statusEl = document.getElementById(statusIds[check]);
            if (!statusEl) return;

            statusEl.textContent = _tk('developer.detecting');
            statusEl.style.color = 'var(--color-muted, #888)';
            statusEl.style.fontSize = '13px';
            statusEl.style.fontWeight = 'normal';

            invoke('office_check_runtime').then(r => r[check])
                .then(ok => {
                    statusEl.textContent = ok ? '✓' : '✗';
                    statusEl.style.color = ok ? '#2ecc71' : '#e74c3c';
                    statusEl.style.fontSize = '20px';
                    statusEl.style.fontWeight = 'bold';
                })
                .catch(() => {
                    statusEl.textContent = '✗';
                    statusEl.style.color = '#e74c3c';
                    statusEl.style.fontSize = '20px';
                    statusEl.style.fontWeight = 'bold';
                });
        });
    });
}
