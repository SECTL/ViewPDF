/**
 * blackboard-pipeline-align-sim.mjs
 * 小黑板「预览笔迹 vs 实际(提交)笔迹」全链路坐标对齐仿真。
 *
 * 复刻三套数学：
 *   1) pointer -> content 折算（drawing-engine.handle_pointer_down/move）
 *   2) 预览落点（OverlayManager.sync_transform：旧=视口绝对锚点 / 新=相对自身锚点）
 *   3) 提交落点（TileRenderer：内容坐标 + bb_wrapper CSS transform(translate+scale,origin 0,0)）
 *
 * 覆盖场景：
 *   A 静止全屏（overlay 在视口 0,0，无过渡）
 *   B overlay 被父级偏移（container padding / 标题栏 / 非全屏嵌入）
 *   C 平滑过渡中「未快进」起笔（bb_state.scale 已是终态，但 bb_wrapper gBCR 是中间态）
 *   D 平滑过渡中「已快进」起笔（_bb_snap_smooth_transform 把 DOM 落到终态）
 *
 * 预期结论：
 *   - A：旧/新/提交 三者一致（稳态对齐）。
 *   - B：旧实现把 overlay 自身偏移重复计入 -> 预览整体错；新实现锚定自身坐标系 -> 恒对齐。
 *   - C：未快进时，预览跟手、提交被烘焙偏移（"绘制中位置对、抬笔后错位"的典型症状）。
 *   - D：快进后三者一致（snap 是过渡窗口的真实护栏）。
 */

const EPS = 1e-6;

// ---- 提交笔迹：内容点 -> bb_wrapper 局部(P) -> CSS transform -> 视口 ----
// bb_wrapper: transform translate3d(cx,cy,0) scale(s), origin 0 0  =>  局部(X,Y)->视口(cx+X*s, cy+Y*s)
// 内容点 P 在 bb_wrapper 局部即 (Px,Py)
function committed(Px, Py, { scale, canvas_x, canvas_y }) {
    return { x: canvas_x + Px * scale, y: canvas_y + Py * scale };
}

// ---- pointer -> content（drawing-engine 折算，inv = 1/scale）----
// content = (client - bbRect.left) / scale ; bbRect.left 即 bb_wrapper 当前 gBCR.left
function pointerToContent(clientX, clientY, { bbRectLeft, bbRectTop, scale }) {
    const inv = 1 / scale;
    return { x: (clientX - bbRectLeft) * inv, y: (clientY - bbRectTop) * inv };
}

// ---- 预览落点 ----
// overlay 画布自身位于视口 (ovLeft, ovTop)；anchor originX = bb_wrapper 内容原点(0,0) 的视口坐标
//   originX = bbRectLeft（bb_wrapper(0,0) 经 transform 后视觉左缘）
// 旧实现：setTransform(tx=originX)；新实现：tx = originX - ovLeft（折算到 overlay 自身坐标系）
function preview(Px, Py, { scale, bbRectLeft, bbRectTop, ovLeft, ovTop, relativeFix }) {
    const tx = relativeFix ? (bbRectLeft - ovLeft) : bbRectLeft;
    const ty = relativeFix ? (bbRectTop - ovTop) : bbRectTop;
    // content -> overlay 设备像素 (Px*scale*dpr + tx*dpr) -> CSS (Px*scale + tx) -> 视口 (ovLeft + ...)
    const cssX = Px * scale + tx;
    const cssY = Py * scale + ty;
    return { x: ovLeft + cssX, y: ovTop + cssY };
}

function check(label, fn) {
    const r = fn();
    const dOld = Math.hypot(r.com.x - r.old.x, r.com.y - r.old.y);
    const dNew = Math.hypot(r.com.x - r.new.x, r.com.y - r.new.y);
    console.log(`\n=== ${label} ===`);
    console.log(`  提交落点        : (${r.com.x.toFixed(1)}, ${r.com.y.toFixed(1)})`);
    console.log(`  预览(旧) 落点   : (${r.old.x.toFixed(1)}, ${r.old.y.toFixed(1)})  偏差 ${dOld.toFixed(2)}px ${dOld < EPS ? '✅' : '❌错位'}`);
    console.log(`  预览(新) 落点   : (${r.new.x.toFixed(1)}, ${r.new.y.toFixed(1)})  偏差 ${dNew.toFixed(2)}px ${dNew < EPS ? '✅' : '❌错位'}`);
    return { dOld, dNew };
}

let allPass = true;
const results = [];

// ---------- A. 静止全屏：overlay 在视口 0,0，无过渡 ----------
// 用户在 (clientX,clientY) 落笔；bb_wrapper 静止于 canvas_x/canvas_y
{
    const scale = 2, canvas_x = 120, canvas_y = -40, ovLeft = 0, ovTop = 0;
    const clientX = 360, clientY = 200;
    const content = pointerToContent(clientX, clientY, { bbRectLeft: canvas_x, bbRectTop: canvas_y, scale });
    const com = committed(content.x, content.y, { scale, canvas_x, canvas_y });
    const old = preview(content.x, content.y, { scale, bbRectLeft: canvas_x, bbRectTop: canvas_y, ovLeft, ovTop, relativeFix: false });
    const neu = preview(content.x, content.y, { scale, bbRectLeft: canvas_x, bbRectTop: canvas_y, ovLeft, ovTop, relativeFix: true });
    results.push(['A 静止全屏', check('A. 静止全屏（overlay@0,0，稳态）', () => ({ com, old, new: neu }))]);
}

// ---------- B. overlay 被父级偏移（+80,+40），稳态 ----------
{
    const scale = 2, canvas_x = 120, canvas_y = -40, ovLeft = 80, ovTop = 40;
    const clientX = 360, clientY = 200;
    const content = pointerToContent(clientX, clientY, { bbRectLeft: canvas_x, bbRectTop: canvas_y, scale });
    const com = committed(content.x, content.y, { scale, canvas_x, canvas_y });
    const old = preview(content.x, content.y, { scale, bbRectLeft: canvas_x, bbRectTop: canvas_y, ovLeft, ovTop, relativeFix: false });
    const neu = preview(content.x, content.y, { scale, bbRectLeft: canvas_x, bbRectTop: canvas_y, ovLeft, ovTop, relativeFix: true });
    results.push(['B overlay偏移', check('B. overlay 被父级偏移 +80/+40（非全屏/嵌套容器）', () => ({ com, old, new: neu }))]);
}

// ---------- C. 平滑过渡中「未快进」起笔：scale 已终态，gBCR 是中间态 ----------
// 假设从 canvas_x0=0 平滑过渡到 canvas_x1=200（终态），当前 gBCR 在中间 canvas_xMid=100。
// bb_state.scale 已是终态 scale=2（_sync_bb_transform_smooth 先写终态再靠 CSS 过渡 DOM）。
// 用户手指 clientX 不变：content 按「终态 scale × 中间态 rect」折算（这正是代码注释描述的 bug）。
{
    const scale = 2;                 // 已是终态
    const canvas_x_final = 200;      // 终态平移
    const canvas_y_final = -40;      // 终态平移
    const canvas_x_mid = 100;        // 当前 gBCR 中间态（DOM 还在动）
    const canvas_y_mid = -20;        // 当前 gBCR 中间态
    const ovLeft = 0, ovTop = 0;
    const clientX = 360, clientY = 200;
    // 折算用的是中间态 rect（canvas_*_mid），但 scale 用终态
    const content = pointerToContent(clientX, clientY, { bbRectLeft: canvas_x_mid, bbRectTop: canvas_y_mid, scale });
    // 提交（过渡结束后 DOM 落到终态）：用终态平移渲染 content
    const com = committed(content.x, content.y, { scale, canvas_x: canvas_x_final, canvas_y: canvas_y_final });
    // 预览（绘制中读实时 gBCR = 中间态）：用中间态平移
    const old = preview(content.x, content.y, { scale, bbRectLeft: canvas_x_mid, bbRectTop: canvas_y_mid, ovLeft, ovTop, relativeFix: false });
    const neu = preview(content.x, content.y, { scale, bbRectLeft: canvas_x_mid, bbRectTop: canvas_y_mid, ovLeft, ovTop, relativeFix: true });
    results.push(['C 未快进', check('C. 平滑过渡未快进起笔（scale 终态 / gBCR 中间态）', () => ({ com, old, new: neu }))]);
}

// ---------- D. 平滑过渡「已快进」起笔：_bb_snap_smooth_transform 把 DOM 落到终态 ----------
// 快进后 gBCR 立即 = 终态 canvas_x_final，scale 终态，两者一致。
{
    const scale = 2;
    const canvas_x_final = 200;      // 快进后 gBCR 即终态
    const ovLeft = 0, ovTop = 0;
    const clientX = 360, clientY = 200;
    const content = pointerToContent(clientX, clientY, { bbRectLeft: canvas_x_final, bbRectTop: -40, scale });
    const com = committed(content.x, content.y, { scale, canvas_x: canvas_x_final, canvas_y: -40 });
    const old = preview(content.x, content.y, { scale, bbRectLeft: canvas_x_final, bbRectTop: -40, ovLeft, ovTop, relativeFix: false });
    const neu = preview(content.x, content.y, { scale, bbRectLeft: canvas_x_final, bbRectTop: -40, ovLeft, ovTop, relativeFix: true });
    results.push(['D 已快进', check('D. 平滑过渡已快进起笔（snap 把 DOM 落终态）', () => ({ com, old, new: neu }))]);
}

// ---------- 汇总 ----------
console.log('\n==================== 汇总 ====================');
for (const [name, { dOld, dNew }] of results) {
    const ok = dNew < EPS;
    if (!ok) allPass = false;
    console.log(`  ${name.padEnd(14)} | 旧偏差 ${dOld.toFixed(1).padStart(6)}px | 新偏差 ${dNew.toFixed(1).padStart(6)}px ${ok ? '✅' : '❌'}`);
}
console.log(`\n[结论] 新实现（相对自身锚点）全部场景对齐: ${allPass ? '✅ 全部通过' : '❌ 存在未对齐'}`);
console.log('说明：');
console.log('  · A 稳态：旧/新均对齐（overlay 在 0,0 时新实现 == 旧实现，严格泛化）。');
console.log('  · B overlay 偏移：旧实现把自身偏移重复计入 -> 错位；新实现锚定自身坐标系 -> 恒对齐（防御性价值）。');
console.log('  · C 未快进：预览跟手、提交被烘焙偏移（"绘制中对、抬笔后错位"的典型症状）—— 此场景靠 _bb_snap_smooth_transform 护栏消除。');
console.log('  · D 已快进：三者一致（snap 是过渡窗口的真实护栏）。');
console.log('  · 当前全屏小黑板 DOM 把 overlay 固定在视口 0,0，故稳态(场景A)新==旧；');
console.log('    若用户仍见错位，需确认起笔是否落在上一条平滑过渡窗口内（snap 是否覆盖该起笔入口）。');
