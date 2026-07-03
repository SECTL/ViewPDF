import { DeviceType } from './types.js';

/**
 * 设备感知容差配置（单位: px）
 *   DragTolerance    = { Mouse: 1.0, Touch: 16.0, Stylus: 4.0 }  — 拖拽触发阈值
 *   HitTestTolerance = { Mouse: 3.0, Touch: 10.0, Stylus: 5.0 }  — 命中测试阈值
 *   DragLight        = { Mouse: 1.0, Touch: 4.0,  Stylus: 2.0 }  — 轻度拖拽阈值
 */
export const TOLERANCE = Object.freeze({
    DRAG:                         { mouse: 1,  touch: 16, stylus: 4  },
    DRAG_LIGHT:                   { mouse: 1,  touch: 4,  stylus: 2  },
    HIT_TEST:                     { mouse: 3,  touch: 10, stylus: 5  },
    PINCH:                        { mouse: 1,  touch: 8,  stylus: 4  },
});

/**
 * 获取指定设备类型的容差值
 * @param {{ mouse: number, touch: number, stylus: number }} toleranceSet
 * @param {string} deviceType - DeviceType 的值
 * @returns {number}
 */
export function getTolerance(toleranceSet, deviceType) {
    if (deviceType === DeviceType.Touch) return toleranceSet.touch;
    if (deviceType === DeviceType.Stylus) return toleranceSet.stylus;
    return toleranceSet.mouse;
}

/**
 * 从 PointerEvent 或 TouchEvent 中检测设备类型
 * @param {PointerEvent|TouchEvent|MouseEvent} event
 * @returns {string} DeviceType 中的值
 */
export function detectDeviceType(event) {
    if (event.pointerType) {
        if (event.pointerType === 'touch') return DeviceType.Touch;
        if (event.pointerType === 'pen') return DeviceType.Stylus;
        return DeviceType.Mouse;
    }

    if (event instanceof TouchEvent || window.TouchEvent && event instanceof TouchEvent) {
        return DeviceType.Touch;
    }

    return DeviceType.Mouse;
}

/**
 * 检测是否为鼠标事件（真实鼠标，非触控笔模拟）
 * @param {PointerEvent|MouseEvent} event
 * @returns {boolean}
 */
export function isRealMouse(event) {
    if (event.pointerType) {
        return event.pointerType === 'mouse';
    }
    return !(event instanceof TouchEvent || (window.TouchEvent && event instanceof TouchEvent));
}
