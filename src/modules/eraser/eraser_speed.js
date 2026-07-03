const ERASER_SPEED_BUFFER_SIZE = 5;

export function eraser_speed_create_state() {
    return {
        buffer: new Float32Array(ERASER_SPEED_BUFFER_SIZE),
        bufferIdx: 0,
        bufferCount: 0,
        bufferSum: 0,
        lastDrawTime: 0,
        lastDrawX: 0,
        lastDrawY: 0,
        hasLast: false
    };
}

export function eraser_speed_build_config(DRAW_CONFIG, invScale) {
    return {
        eraserSpeedEnabled: DRAW_CONFIG.eraserSpeedEnabled,
        eraserSpeedMinSize: DRAW_CONFIG.eraserSpeedMinSize * invScale,
        eraserSpeedMaxSize: DRAW_CONFIG.eraserSpeedMaxSize * invScale,
        eraserSpeedSizeRange: (DRAW_CONFIG.eraserSpeedMaxSize - DRAW_CONFIG.eraserSpeedMinSize) * invScale,
        eraserSpeedFactor: DRAW_CONFIG.eraserSpeedFactor
    };
}

export function eraser_speed_update(state, stroke, toX, toY) {
    const now = performance.now();

    if (!state.hasLast) {
        state.hasLast = true;
        state.lastDrawTime = now;
        state.lastDrawX = toX;
        state.lastDrawY = toY;
        return stroke.lineWidth;
    }

    const dt = now - state.lastDrawTime;
    state.lastDrawTime = now;

    if (dt <= 0) {
        state.lastDrawX = toX;
        state.lastDrawY = toY;
        return stroke.lineWidth;
    }

    const dx = toX - state.lastDrawX;
    const dy = toY - state.lastDrawY;
    state.lastDrawX = toX;
    state.lastDrawY = toY;

    const speed = Math.sqrt(dx * dx + dy * dy) / dt;

    const buf = state.buffer;
    const idx = state.bufferIdx;

    if (state.bufferCount < ERASER_SPEED_BUFFER_SIZE) {
        buf[idx] = speed;
        state.bufferSum += speed;
        state.bufferCount++;
        state.bufferIdx = (idx + 1) % ERASER_SPEED_BUFFER_SIZE;
        const avg = state.bufferSum / state.bufferCount;
        return Math.min(stroke.eraserSpeedMinSize + avg * stroke.eraserSpeedFactor * 100, stroke.eraserSpeedMaxSize);
    }

    state.bufferSum -= buf[idx];
    buf[idx] = speed;
    state.bufferSum += speed;
    state.bufferIdx = (idx + 1) % ERASER_SPEED_BUFFER_SIZE;

    const avg = state.bufferSum * (1 / ERASER_SPEED_BUFFER_SIZE);
    return Math.min(stroke.eraserSpeedMinSize + avg * stroke.eraserSpeedFactor * 100, stroke.eraserSpeedMaxSize);
}
