import { renderStrokesToContext } from './stroke-renderer.js';

let _compactIdleId = null;

/**
 * 创建历史压缩器
 * @param {Object} deps
 * @param {Object} deps.state - 全局状态
 * @param {Function} deps.cloneStrokeDeep
 * @param {Function} deps.fetchOffscreenCanvas
 * @param {Function} deps.releaseOffscreenCanvas
 * @param {Function} deps.renderAllStrokes
 * @param {Function} deps.loadBaseImage
 * @param {Function} deps.safeScaleFn
 * @param {Function} deps.penManager
 * @param {Function} deps.historyValidateCompact
 * @param {Function} deps.historyFetchUndoStack
 * @param {Function} deps.historyFetchCommandsToCompact
 * @param {Function} deps.historyFormatCompact
 * @param {Function} deps.SnapshotCommand
 * @returns {{ initCompaction(), handleCompactStrokes(), cancelCompaction(), compactIdleId }}
 */
export function createHistoryCompactor(deps) {
    return {
        get compactIdleId() { return _compactIdleId; },

        initCompaction() {
            if (window.__HISTORY_ISOLATED) return;
            if (!deps.historyValidateCompact()) return;
            if (_compactIdleId !== null) return;

            const undoStack = deps.historyFetchUndoStack();
            if (undoStack.some(cmd => cmd.can_compact && !cmd.can_compact())) {
                console.log('检测到不可压缩的操作，跳过压缩');
                return;
            }

            _compactIdleId = requestIdleCallback(() => {
                _compactIdleId = null;
                this.handleCompactStrokes();
            }, { timeout: 2000 });
        },

        async handleCompactStrokes() {
            if (window.__HISTORY_ISOLATED) return;
            if (!deps.historyValidateCompact()) return;

            const undoStack = deps.historyFetchUndoStack();
            if (undoStack.some(cmd => cmd.can_compact && !cmd.can_compact())) {
                console.log('压缩执行前检测到不可压缩的操作，取消压缩');
                return;
            }

            const commandsToCompact = deps.historyFetchCommandsToCompact();
            if (commandsToCompact.length === 0) return;
            const compactTargetCount = commandsToCompact.length;

            const state = deps.state;
            const loadId = ++state.baseImageLoadId;
            state.compactSnapshotId = (state.compactSnapshotId || 0) + 1;
            const compactSnapshotId = state.compactSnapshotId;

            const beforeStrokes = deps.cloneStrokeDeep(state.strokeHistory);
            const frozenImageURL = state.baseImageURL;

            const strokesToCompactSet = new Set();
            commandsToCompact.forEach(cmd => {
                if (cmd.stroke) strokesToCompactSet.add(cmd.stroke);
            });
            const strokesToCompact = Array.from(strokesToCompactSet);

            if (!deps.historyValidateCompact()) {
                console.log('压缩期间撤销栈已变化，取消压缩');
                return;
            }

            const offscreen = deps.fetchOffscreenCanvas();
            const tempCtx = offscreen.ctx;
            const DRAW_CONFIG = window.DRAW_CONFIG;

            if (state.baseImageObj) {
                tempCtx.drawImage(state.baseImageObj, 0, 0, DRAW_CONFIG.canvasW, DRAW_CONFIG.canvasH);
            }

            await renderStrokesToContext(tempCtx, strokesToCompact, {
                renderScale: deps.safeScaleFn(),
                penManager: deps.penManager()
            });

            if (loadId !== state.baseImageLoadId) {
                deps.releaseOffscreenCanvas(offscreen);
                return;
            }
            if (compactSnapshotId !== state.compactSnapshotId) {
                console.log('压缩快照已过期,取消操作');
                deps.releaseOffscreenCanvas(offscreen);
                return;
            }

            const afterImageURL = offscreen.canvas.toDataURL('image/png');

            const remainingStrokes = state.strokeHistory.filter(s => !strokesToCompactSet.has(s));
            state.strokeHistory.length = 0;
            remainingStrokes.forEach(s => state.strokeHistory.push(s));

            const afterStrokes = [...state.strokeHistory];

            const snapshotCmd = new deps.SnapshotCommand({
                beforeImageURL: frozenImageURL,
                afterImageURL,
                beforeStrokes,
                afterStrokes,
                strokeHistoryRef: state.strokeHistory,
                baseImageURLRef: { get value() { return state.baseImageURL; }, set value(v) { state.baseImageURL = v; } },
                baseImageObjRef: { get value() { return state.baseImageObj; }, set value(v) { state.baseImageObj = v; } },
                redrawFn: () => deps.renderAllStrokes(),
                loadBaseImageFn: (url) => deps.loadBaseImage(url)
            });

            deps.historyFormatCompact(snapshotCmd, compactTargetCount);

            state.baseImageURL = afterImageURL;
            state.baseImageObj = null;
            const img = new Image();
            img.onload = () => {
                if (loadId === state.baseImageLoadId) {
                    state.baseImageObj = img;
                    if (window.tileRenderer) window.tileRenderer.mark_all();
                }
                deps.releaseOffscreenCanvas(offscreen);
            };
            img.onerror = () => deps.releaseOffscreenCanvas(offscreen);
            img.src = afterImageURL;

            console.log('笔画已异步压缩，保留最近', deps.historyFetchUndoStack().length, '步可撤销');
        },

        cancelCompaction() {
            if (_compactIdleId !== null) {
                cancelIdleCallback(_compactIdleId);
                _compactIdleId = null;
            }
        }
    };
}
