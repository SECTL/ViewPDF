/** 输入设备类型 */
export const DeviceType = Object.freeze({
    Mouse: 'mouse',
    Stylus: 'stylus',
    Touch: 'touch',
});

/**
 * 事件来源类型
 * - Device: 真实输入设备
 * - LostCapture: 输入捕获丢失（如 pointercancel/触摸中断）
 * - Manual: 程序化触发
 */
export const VirtualDeviceType = Object.freeze({
    Device: 'device',
    LostCapture: 'lost-capture',
    Manual: 'manual',
});

/** 设备按钮 */
export const DeviceButton = Object.freeze({
    None: 'none',
    Left: 'left',
    Right: 'right',
    Middle: 'middle',
    Context: 'context',
    Eraser: 'eraser',
    Barrel: 'barrel',
});


export class DeviceInputEvent {
    constructor(id, position, type, button, originEvent = null) {
        this.id = id;
        this.position = position;
        this.type = type;
        this.button = button;
        this.virtualType = VirtualDeviceType.Device;
        this.originEvent = originEvent;
    }
}


export class DeviceInputDragEvent extends DeviceInputEvent {
    constructor(id, position, type, button, originPosition, offsetToOrigin, offsetToLast, originEvent = null) {
        super(id, position, type, button, originEvent);
        this.originPosition = originPosition;
        this.offsetToOrigin = offsetToOrigin;
        this.offsetToLast = offsetToLast;
    }
}


export class DeviceInputStartingEvent extends DeviceInputEvent {
    constructor(id, type, button) {
        super(id, { x: 0, y: 0 }, type, button);
    }
}


export class DeviceInputStartedEvent extends DeviceInputEvent {
    constructor(id, type, button) {
        super(id, { x: 0, y: 0 }, type, button);
    }
}


export class DeviceInputCompletedEvent extends DeviceInputEvent {
    constructor(type, button, virtualType = VirtualDeviceType.Device) {
        super(-1, { x: 0, y: 0 }, type, button);
        this.virtualType = virtualType;
    }
}
