import { DeviceType, DeviceButton, VirtualDeviceType, DeviceInputEvent, DeviceInputStartingEvent, DeviceInputStartedEvent, DeviceInputCompletedEvent } from './types.js';
import { detectDeviceType, isRealMouse } from './tolerance.js';

/**
 * 统一输入抽象层
 *
 * 将 PointerEvent / MouseEvent / TouchEvent 归一化为设备无关的事件生命周期：
 *   InputStarting → InputStarted → [InputDown / InputMove / InputHover / InputUp] → InputCompleted
 *
 * 支持多指追踪（按 pointerId/touchId 区分），自动检测设备类型（Mouse/Stylus/Touch）。
 */
export class InputSource {
    /**
     * @param {Element} element - 绑定目标 DOM 元素
     * @param {object} [options]
     * @param {boolean} [options.usePreview=false] - 是否使用 Preview 事件（捕获阶段）
     * @param {boolean} [options.enableTouchFallback=true] - 无 PointerEvent 时降级到 TouchEvent
     */
    constructor(element, options = {}) {
        this._element = element;
        this._usePreview = !!options.usePreview;
        this._enableTouchFallback = options.enableTouchFallback !== false;

        this._started = false;
        this._activePointers = new Map();
        this._deviceType = null;
        this._deviceButton = DeviceButton.None;
        this._internalContainer = null;

        this._handlers = {};

        // 缓存：避免热路径中每帧创建新数组/对象
        this._activeEventsCache = [];
        this._activeEventsDirty = true;
        this._positionsCache = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
        this._positionsLen = 0;

        this._boundPointerDown = this._onPointerDown.bind(this);
        this._boundPointerMove = this._onPointerMove.bind(this);
        this._boundPointerUp = this._onPointerUp.bind(this);
        this._boundPointerCancel = this._onPointerCancel.bind(this);

        this._boundTouchStart = this._onTouchStart.bind(this);
        this._boundTouchMove = this._onTouchMove.bind(this);
        this._boundTouchEnd = this._onTouchEnd.bind(this);
        this._boundTouchCancel = this._onTouchCancel.bind(this);
    }

    /**
     * 注册事件回调
     * @param {'inputStarting'|'inputStarted'|'inputDown'|'inputMove'|'inputUp'|'inputHover'|'inputCompleted'} name
     * @param {function} fn
     */
    on(name, fn) {
        if (!this._handlers[name]) {
            this._handlers[name] = [];
        }
        this._handlers[name].push(fn);
    }

    off(name, fn) {
        const list = this._handlers[name];
        if (!list) return;
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
    }

    _emit(name, data) {
        const list = this._handlers[name];
        if (!list) return;
        for (let i = 0; i < list.length; i++) {
            try {
                list[i](data);
            } catch (e) {
                console.warn(`[InputSource] handler error (${name}):`, e);
            }
        }
    }

    /** 绑定输入事件 */
    attach() {
        const el = this._element;

        if (window.PointerEvent) {
            if (this._usePreview) {
                el.addEventListener('pointerdown', this._boundPointerDown);
                el.addEventListener('pointermove', this._boundPointerMove);
                el.addEventListener('pointerup', this._boundPointerUp);
                el.addEventListener('pointercancel', this._boundPointerCancel);
                el.addEventListener('lostpointercapture', this._boundPointerCancel);
            } else {
                el.addEventListener('pointerdown', this._boundPointerDown);
                el.addEventListener('pointermove', this._boundPointerMove);
                el.addEventListener('pointerup', this._boundPointerUp);
                el.addEventListener('pointercancel', this._boundPointerCancel);
                el.addEventListener('lostpointercapture', this._boundPointerCancel);
            }
        } else {
            el.addEventListener('mousedown', this._boundPointerDown);
            el.addEventListener('mousemove', this._boundPointerMove);
            el.addEventListener('mouseup', this._boundPointerUp);

            if (this._enableTouchFallback) {
                el.addEventListener('touchstart', this._boundTouchStart, { passive: true });
                el.addEventListener('touchmove', this._boundTouchMove, { passive: false });
                el.addEventListener('touchend', this._boundTouchEnd, { passive: true });
                el.addEventListener('touchcancel', this._boundTouchCancel, { passive: true });
            }
        }
    }

    /** 解绑输入事件 */
    detach() {
        const el = this._element;

        if (window.PointerEvent) {
            el.removeEventListener('pointerdown', this._boundPointerDown);
            el.removeEventListener('pointermove', this._boundPointerMove);
            el.removeEventListener('pointerup', this._boundPointerUp);
            el.removeEventListener('pointercancel', this._boundPointerCancel);
            el.removeEventListener('lostpointercapture', this._boundPointerCancel);
        } else {
            el.removeEventListener('mousedown', this._boundPointerDown);
            el.removeEventListener('mousemove', this._boundPointerMove);
            el.removeEventListener('mouseup', this._boundPointerUp);

            if (this._enableTouchFallback) {
                el.removeEventListener('touchstart', this._boundTouchStart);
                el.removeEventListener('touchmove', this._boundTouchMove);
                el.removeEventListener('touchend', this._boundTouchEnd);
                el.removeEventListener('touchcancel', this._boundTouchCancel);
            }
        }

        this._emitAllUp(VirtualDeviceType.LostCapture);
    }

    /** 获取当前活跃指针数量 */
    get activeCount() {
        return this._activePointers.size;
    }

    /** 获取当前活跃指针的事件列表（缓存复用，避免每帧 GC） */
    get activeEvents() {
        let i = 0;
        for (const ev of this._activePointers.values()) {
            if (i < this._activeEventsCache.length) {
                this._activeEventsCache[i] = ev;
            } else {
                this._activeEventsCache.push(ev);
            }
            i++;
        }
        this._activeEventsCache.length = i;
        return this._activeEventsCache;
    }

    /**
     * 获取所有活跃指针的位置列表（预分配缓存，避免每帧 GC）
     * @returns {{x: number, y: number}[]}
     */
    getActivePositions() {
        let i = 0;
        for (const ev of this._activePointers.values()) {
            if (i < this._positionsCache.length) {
                this._positionsCache[i].x = ev.position.x;
                this._positionsCache[i].y = ev.position.y;
            } else {
                this._positionsCache.push({ x: ev.position.x, y: ev.position.y });
            }
            i++;
        }
        this._positionsCache.length = i;
        return this._positionsCache;
    }

    /**
     * 获取所有活跃指针在元素坐标系中的位置列表
     * @returns {{x: number, y: number}[]}
     */
    getActivePositionsRelative(element) {
        const rect = element.getBoundingClientRect();
        const result = [];
        for (const ev of this._activePointers.values()) {
            result.push({
                x: ev.position.x - rect.left,
                y: ev.position.y - rect.top,
            });
        }
        return result;
    }

    // ==================== PointerEvent 处理 ====================

    _getPointerButton(event) {
        if (event.button === 2) return DeviceButton.Right;
        if (event.button === 1) return DeviceButton.Middle;
        if (event.buttons & 32) return DeviceButton.Context;
        return DeviceButton.Left;
    }

    _onPointerDown(event) {
        event.preventDefault();

        const deviceType = detectDeviceType(event);
        const button = this._getPointerButton(event);
        const id = event.pointerId;

        if (this._activePointers.size === 0 && !this._started) {
            this._deviceType = deviceType;
            this._deviceButton = button;
            this._internalContainer = event.currentTarget;
            this._started = true;

            this._emit('inputStarting', new DeviceInputStartingEvent(id, deviceType, button));
            this._emit('inputStarted', new DeviceInputStartedEvent(id, deviceType, button));
        }

        const pos = { x: event.clientX, y: event.clientY };
        const ev = new DeviceInputEvent(id, pos, deviceType, button, event);
        this._activePointers.set(id, ev);

        try {
            event.target?.setPointerCapture?.(id);
        } catch (_) {}

        this._emit('inputDown', ev);
    }

    _onPointerMove(event) {
        const id = event.pointerId;
        const existing = this._activePointers.get(id);
        if (!existing && !this._started) {
            return;
        }

        if (!existing && this._started) {
            return;
        }

        if (existing) {
            existing.position.x = event.clientX;
            existing.position.y = event.clientY;
            existing.originEvent = event;
            this._emit('inputMove', existing);
            return;
        }
    }

    _onPointerUp(event) {
        const id = event.pointerId;
        const existing = this._activePointers.get(id);
        if (!existing) return;

        existing.position.x = event.clientX;
        existing.position.y = event.clientY;
        existing.originEvent = event;
        this._activePointers.delete(id);

        this._emit('inputUp', existing);

        if (this._activePointers.size === 0 && this._started) {
            this._started = false;
            const completed = new DeviceInputCompletedEvent(
                this._deviceType || deviceTypeFromEvent(event),
                this._deviceButton,
                VirtualDeviceType.Device
            );
            this._emit('inputCompleted', completed);
        }
    }

    _onPointerCancel(event) {
        const id = event.pointerId;
        const existing = this._activePointers.get(id);
        if (existing) {
            existing.virtualType = VirtualDeviceType.LostCapture;
            existing.originEvent = event;
            this._activePointers.delete(id);
            this._emit('inputUp', existing);
        }

        if (this._activePointers.size === 0 && this._started) {
            this._started = false;
            const completed = new DeviceInputCompletedEvent(
                this._deviceType || DeviceType.Mouse,
                this._deviceButton,
                VirtualDeviceType.LostCapture
            );
            this._emit('inputCompleted', completed);
        }
    }

    _emitAllUp(virtualType) {
        if (!this._started && this._activePointers.size === 0) return;

        for (const ev of this._activePointers.values()) {
            ev.virtualType = virtualType;
            this._emit('inputUp', ev);
        }
        this._activePointers.clear();

        if (this._started) {
            this._started = false;
            const completed = new DeviceInputCompletedEvent(
                this._deviceType || DeviceType.Mouse,
                this._deviceButton,
                virtualType
            );
            this._emit('inputCompleted', completed);
        }
    }

    // ==================== TouchEvent 降级处理（无 PointerEvent 时）====================

    _onTouchStart(event) {
        const deviceType = DeviceType.Touch;
        const button = DeviceButton.Left;

        if (this._activePointers.size === 0 && !this._started) {
            this._deviceType = deviceType;
            this._deviceButton = button;
            this._internalContainer = event.currentTarget;
            this._started = true;

            const firstTouch = event.changedTouches[0];
            this._emit('inputStarting', new DeviceInputStartingEvent(firstTouch.identifier, deviceType, button));
            this._emit('inputStarted', new DeviceInputStartedEvent(firstTouch.identifier, deviceType, button));
        }

        for (let i = 0; i < event.changedTouches.length; i++) {
            const t = event.changedTouches[i];
            const pos = { x: t.clientX, y: t.clientY };
            const ev = new DeviceInputEvent(t.identifier, pos, deviceType, button, event);
            this._activePointers.set(t.identifier, ev);
            this._emit('inputDown', ev);
        }
    }

    _onTouchMove(event) {
        event.preventDefault();

        for (let i = 0; i < event.changedTouches.length; i++) {
            const t = event.changedTouches[i];
            const existing = this._activePointers.get(t.identifier);
            if (existing) {
                existing.position.x = t.clientX;
                existing.position.y = t.clientY;
                existing.originEvent = event;
                this._emit('inputMove', existing);
            }
        }
    }

    _onTouchEnd(event) {
        const deviceType = DeviceType.Touch;

        for (let i = 0; i < event.changedTouches.length; i++) {
            const t = event.changedTouches[i];
            const existing = this._activePointers.get(t.identifier);
            if (existing) {
                existing.position.x = t.clientX;
                existing.position.y = t.clientY;
                existing.originEvent = event;
                this._activePointers.delete(t.identifier);
                this._emit('inputUp', existing);
            }
        }

        if (this._activePointers.size === 0 && this._started) {
            this._started = false;
            const completed = new DeviceInputCompletedEvent(deviceType, this._deviceButton, VirtualDeviceType.Device);
            this._emit('inputCompleted', completed);
        }
    }

    _onTouchCancel(event) {
        const deviceType = DeviceType.Touch;

        for (let i = 0; i < event.changedTouches.length; i++) {
            const t = event.changedTouches[i];
            const existing = this._activePointers.get(t.identifier);
            if (existing) {
                existing.virtualType = VirtualDeviceType.LostCapture;
                existing.originEvent = event;
                this._activePointers.delete(t.identifier);
                this._emit('inputUp', existing);
            }
        }

        if (this._activePointers.size === 0 && this._started) {
            this._started = false;
            const completed = new DeviceInputCompletedEvent(deviceType, this._deviceButton, VirtualDeviceType.LostCapture);
            this._emit('inputCompleted', completed);
        }
    }
}

function deviceTypeFromEvent(event) {
    if (event.pointerType === 'touch') return DeviceType.Touch;
    if (event.pointerType === 'pen') return DeviceType.Stylus;
    return DeviceType.Mouse;
}
