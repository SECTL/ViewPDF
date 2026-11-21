/**
 * 文档级旋转数学仿真：验证 _reapply_rotation_dims / 视口旋转 / 持久化往返
 * 的核心不变式（纯数值，不依赖 DOM）。
 */
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

// ---- 复刻 _reapply_rotation_dims 逻辑 ----
function reapply(dims, dimsRotation, docRotation) {
    let w = dims.w, h = dims.h;
    const cur = ((dimsRotation ?? 0) % 360 + 360) % 360;
    if (cur % 180) { const t = w; w = h; h = t; }
    if (docRotation % 180) { const t = w; w = h; h = t; }
    return { w, h, _dims_rotation: docRotation };
}

console.log('== A. 尺寸往返：A4 纵向 595×842，旋转 0→90→180→270→0 ==');
{
    let dims = { w: 595, h: 842 }, rot = 0;
    const seq = [90, 180, 270, 0];
    // 90/270 交换宽高；180 不交换
    const expect = [{ w: 842, h: 595 }, { w: 595, h: 842 }, { w: 842, h: 595 }, { w: 595, h: 842 }];
    seq.forEach((target, i) => {
        dims = reapply(dims, rot, target);
        rot = target;
        check(`旋转到 ${target}° → ${expect[i].w}×${expect[i].h}`,
            dims.w === expect[i].w && dims.h === expect[i].h,
            `got ${dims.w}×${dims.h}`);
    });
}

console.log('== B. 混合口径页面：构建期内在尺寸 vs 渲染期旋转尺寸，重算一致 ==');
{
    // 页 1 从未渲染（内在口径），页 2 已被 worker 返回旋转后尺寸（_dims_rotation=90）
    const doc_rot = 90;
    const p1 = reapply({ w: 595, h: 842 }, 0, doc_rot);      // 未渲染：内在
    const p2 = reapply({ w: 842, h: 595 }, 90, doc_rot);     // 已渲染：旋转口径
    check('未渲染页与已渲染页重算到同一显示尺寸', p1.w === p2.w && p1.h === p2.h,
        `p1=${p1.w}×${p1.h} p2=${p2.w}×${p2.h}`);
}

console.log('== C. 视口旋转：css_scale 基于旋转后宽度，盒子高度与画布一致 ==');
{
    const intrinsic = { w: 595, h: 842 };
    const page_rotate = 0, doc_rot = 90;
    const vp_rot = (((page_rotate + doc_rot) % 360) + 360) % 360;
    // getViewport(scale:1, rotation:vp_rot) 的宽高（旋转 90 → 宽高互换）
    const base = vp_rot % 180 ? { w: intrinsic.h, h: intrinsic.w } : intrinsic;
    const css_w = 800;                                   // 页盒宽度（容器决定，与旋转无关）
    const css_scale = css_w / base.w;
    const aspect = base.w / base.h;
    const box_h = css_w / aspect;                        // _resize_page_layout 盒高
    const canvas_h = css_w / aspect;                     // commit 写入的画布 css 高
    check('vp_rot 归一化', vp_rot === 90, `got ${vp_rot}`);
    check('base 已旋转（宽=内在高）', base.w === 842 && base.h === 595);
    check('盒高 == 画布 css 高', Math.abs(box_h - canvas_h) < 1e-9);
    check('旋转后页盒为横向', box_h < css_w);
}

console.log('== D. worker 协议：绝对旋转 = (page.rotate + delta) mod 360 ==');
{
    const cases = [
        { page: 0, delta: 0, want: 0 }, { page: 90, delta: 90, want: 180 },
        { page: 270, delta: 180, want: 90 }, { page: 0, delta: 270, want: 270 },
        { page: 180, delta: 270, want: 90 }
    ];
    for (const c of cases) {
        const got = (((c.page + c.delta) % 360) + 360) % 360;
        check(`page.rotate=${c.page} + delta=${c.delta} → ${c.want}`, got === c.want, `got ${got}`);
    }
}

console.log('== E. 持久化往返：rotation 归一化 ==');
{
    const norm = (r) => Number.isInteger(r) ? (((r % 360) + 360) % 360) : 0;
    check('90 → 90', norm(90) === 90);
    check('450 → 90', norm(450) === 90);
    check('-90 → 270', norm(-90) === 270);
    check('缺失 → 0', norm(undefined) === 0);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
