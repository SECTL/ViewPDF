/**
 * blackboard-overlay-align-sim.mjs
 * 小黑板「预览笔迹 vs 实际笔迹」错位根因仿真。
 *
 * 复刻 OverlayManager.sync_transform（旧：视口绝对锚点 / 新：相对自身锚点）
 * 与 TileRenderer 提交笔迹（瓦片随 bb_wrapper CSS transform）两套坐标数学，
 * 计算同一个「内容坐标点」在视口中的落点，比较两者是否一致。
 *
 * 结论（仿真验证）：
 *   - 覆盖层画布位于视口 (0,0) 时，旧/新实现等价，预览=提交（无偏移）。
 *   - 覆盖层画布不在视口 (0,0)（被父级 transform/定位偏移，如面板滑入过渡、
 *     container 偏移）时，旧实现会把「覆盖层自身偏移」重复计入，预览整体偏移
 *     一个等于该偏移的量，与提交笔迹错位；新实现锚定到覆盖层自身坐标系，恒对齐。
 */

const OVERLAY_DPR = 2; // 显示 DPR（calc_overlay_dpr 上限）

// 提交笔迹：内容坐标 → 瓦片(内容坐标,setTransform dpr) → 随 bb_wrapper CSS transform
// bb_wrapper transform: translate3d(canvas_x,canvas_y,0) scale(scale)，origin 0,0
// bb_wrapper 位于 canvasWrap，canvasWrap 位于 panel（视口偏移 panelOffset）
function committed(contentX, contentY, { scale, canvas_x, canvas_y, panelOffset }) {
    // 内容点先落在 bb_wrapper 局部 = (contentX, contentY)，再经 transform + panel 偏移
    return {
        x: panelOffset + contentX * scale + canvas_x,
        y: panelOffset + contentY * scale + canvas_y
    };
}

// 预览笔迹：OverlayManager 渲染。anchor 锚点 = bb_wrapper 内容原点(0,0) 的视口坐标
//   originX = panelOffset + canvas_x   （bb_wrapper 经 panel 偏移后内容原点的视口 x）
// 覆盖层画布自身位于视口 (overlay_left, overlay_top)
function preview(contentX, contentY, { scale, canvas_x, canvas_y, panelOffset, overlay_left, overlay_top, relativeFix }) {
    const originX = panelOffset + canvas_x;
    const originY = panelOffset + canvas_y;
    let tx; // setTransform 平移项的「内容坐标系」值（device 前）
    if (relativeFix) {
        // 新实现：折算到覆盖层自身坐标系
        tx = originX - overlay_left;
    } else {
        // 旧实现：直接把视口绝对 originX 当平移（隐含覆盖层在视口 0,0）
        tx = originX;
    }
    // content → overlay 设备像素 (px*scale*dpr + tx*dpr) → 覆盖层 CSS (px*scale + tx)
    // → 视口 (overlay_left + px*scale + tx)
    const cssX = contentX * scale + tx;
    const cssY = contentY * scale + (relativeFix ? (originY - overlay_top) : originY);
    return {
        x: overlay_left + cssX,
        y: overlay_top + cssY
    };
}

function run(label, opts, overlay_left, overlay_top) {
    const cases = [
        { scale: 1,  canvas_x: 100, canvas_y: 50 },
        { scale: 2,  canvas_x: 120, canvas_y: -40 },
        { scale: 0.5, canvas_x: 300, canvas_y: 200 },
    ];
    console.log(`\n=== ${label} (overlay_left=${overlay_left}, overlay_top=${overlay_top}) ===`);
    let maxOld = 0, maxNew = 0;
    for (const c of cases) {
        const o = { ...opts, ...c };
        const com = committed(c.canvas_x === undefined ? 300 : 300, 200, o);
        // 校验内容点 (300,200)
        const px = 300, py = 200;
        const comV = committed(px, py, o);
        const oldV = preview(px, py, { ...o, overlay_left, overlay_top, relativeFix: false });
        const newV = preview(px, py, { ...o, overlay_left, overlay_top, relativeFix: true });
        const dOld = Math.hypot(comV.x - oldV.x, comV.y - oldV.y);
        const dNew = Math.hypot(comV.x - newV.x, comV.y - newV.y);
        maxOld = Math.max(maxOld, dOld);
        maxNew = Math.max(maxNew, dNew);
    }
    console.log(`  预览(旧) 与提交最大偏差: ${maxOld.toFixed(2)}px  ${maxOld < 1e-6 ? '✅对齐' : '❌错位'}`);
    console.log(`  预览(新) 与提交最大偏差: ${maxNew.toFixed(2)}px  ${maxNew < 1e-6 ? '✅对齐' : '❌错位'}`);
    return { maxOld, maxNew };
}

const scenarios = [
    ['A. 静止全屏（覆盖层在视口 0,0；面板无偏移）', { panelOffset: 0 }, 0, 0],
    ['B. 面板滑入过渡中（panel 偏移 -300，覆盖层随面板偏移 -300）', { panelOffset: -300 }, -300, -300],
    ['C. 覆盖层被父级定位偏移 +80（如 container padding/标题栏）', { panelOffset: 0 }, 80, 40],
    ['D. 缩放态 + 面板偏移复合', { panelOffset: -150 }, -150, -150],
];

let allPass = true;
for (const [label, opts, ol, ot] of scenarios) {
    const { maxOld, maxNew } = run(label, opts, ol, ot);
    if (maxNew >= 1e-6) allPass = false;
    // 旧实现允许在 A 场景对齐，但在 B/C/D 错位（这是预期缺陷）
}

console.log(`\n[总结] 新实现（相对自身锚点）在全部场景下预览与提交对齐: ${allPass ? '✅ 全部通过' : '❌ 存在未对齐'}`);
console.log('（旧实现的错位仅出现在「覆盖层不在视口 0,0」的场景 B/C/D，与"绘制中位置错、抬笔后正常"症状吻合）');
