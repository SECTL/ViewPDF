const _state = {
    strokeStyle: null,
    fillStyle: null,
    lineWidth: null,
    lineCap: null,
    lineJoin: null,
    globalCompositeOperation: null
};

export function resetContextState() {
    _state.strokeStyle = null;
    _state.fillStyle = null;
    _state.lineWidth = null;
    _state.lineCap = null;
    _state.lineJoin = null;
    _state.globalCompositeOperation = null;
}

export function updateContextState(ctx, props) {
    if (_state.strokeStyle !== props.strokeStyle) {
        ctx.strokeStyle = props.strokeStyle;
        _state.strokeStyle = props.strokeStyle;
    }
    if (_state.fillStyle !== props.fillStyle) {
        ctx.fillStyle = props.fillStyle;
        _state.fillStyle = props.fillStyle;
    }
    if (_state.lineWidth !== props.lineWidth) {
        ctx.lineWidth = props.lineWidth;
        _state.lineWidth = props.lineWidth;
    }
    if (_state.lineCap !== props.lineCap) {
        ctx.lineCap = props.lineCap;
        _state.lineCap = props.lineCap;
    }
    if (_state.lineJoin !== props.lineJoin) {
        ctx.lineJoin = props.lineJoin;
        _state.lineJoin = props.lineJoin;
    }
    if (_state.globalCompositeOperation !== props.globalCompositeOperation) {
        ctx.globalCompositeOperation = props.globalCompositeOperation;
        _state.globalCompositeOperation = props.globalCompositeOperation;
    }
}
