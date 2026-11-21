// 页面旋转的行为测试。
//
// 旋转的危险不在「转没转」，而在三处容易静默出错的地方：
//  ① 两条渲染路径（渲染线程 / 主线程 / 缩略图）口径是否一致 —— 不一致会渲染出
//     不同朝向，且 pageW/pageH 回传未旋转尺寸，页盒比例算错；
//  ② 渲染守卫会不会因 css_w/dpr 未变而拒绝重渲染 → 页面停在旧朝向；
//  ③ 多标签切换时旋转是否串味。
import fs from 'node:fs';

const SRC = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');
const WORKER = fs.readFileSync('src/modules/pdf/render-worker.js', 'utf8');
const HOST = fs.readFileSync('src/modules/pdf/render-worker-host.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
function ok(label, got) { eq(label, !!got, true); }
const count = (text, re) => (text.match(re) || []).length;

// ====== 1. 角度归一化（真跑 set_page_rotation 的归一分支）======
const rotSrc = /set_page_rotation\(deg,[^)]*\)\s*\{([\s\S]*?)\n        const prev = this\._page_rotation;/.exec(SRC);
ok('定位到 set_page_rotation 的角度归一分支', !!rotSrc);
// 抽出归一分支单独跑：必须剥掉那句 `if (next === this._page_rotation) return ...`
// —— 它依赖实例字段，在裸 Function 里 this._page_rotation 是 undefined，
// 留着会让每个用例都返回 undefined（而不是返回归一后的角度）。
const normalizeBody = rotSrc[1]
  .replace(/if\s*\(\s*next\s*===\s*this\._page_rotation\s*\)\s*return[^;]*;/, '')
  .trim();
const normalize = new Function('deg', normalizeBody + '\nreturn next;');
{
  // 期望：合法角度原样；非法值（含 >360、负数、非 90 的倍数）归 0
  const cases = [[0, 0], [90, 90], [180, 180], [270, 270],
  [360, 0], [450, 90], [-90, 270], [45, 0], [null, 0], [undefined, 0], ['180', 180]];
  const wrong = cases.filter(([inp, want]) => normalize(inp) !== want)
    .map(([i, w]) => `${i}->${normalize(i)}(期望 ${w})`);
  eq('角度归一化（含 mod 360 与非法值）', wrong.join(','), '');
}

// ====== 2. 渲染参数：三条路径都必须带 rotation =====
{
  ok('渲染线程调用带 rotation 参数',
     /worker_host\.render\([^)]*this\._page_rotation\)/s.test(SRC));
  eq('渲染线程 render 调用共 2 处（页面 + 缩略图），都带 rotation',
     count(SRC, /worker_host\.render\([\s\S]{0,400}?this\._page_rotation\)/g), 2);
  eq('worker_host.render 签名新增 rotation 默认参数',
     /render\(pageNum, cssW, dpr, is_prerender = false, rotation = 0\)/.test(HOST), true);
  ok('host 把 rotation 透传给 worker 消息',
     /type: 'render'[\s\S]{0,300}?rotation: item\.rotation/.test(HOST));
}

// ====== 3. worker 内部：getViewport 必须带 rotation =====
{
  ok('worker 收下 rotation', /const \{ req, pageNum, cssW, dpr, rotation \} = msg;/.test(WORKER));
  // 旋转后 base 宽高互换，css_scale 必须由「旋转后的 base.width」推出，
  // 否则 cssW 与页面实际宽度差一个轴，页面会被拉伸。
  ok('worker 用旋转后的 base 推 css_scale',
     /const base = page\.getViewport\(\{ scale: 1, rotation: rot \}\);\s*\n\s*const css_scale = cssW \/ base\.width;/.test(WORKER));
  eq('worker 内 getViewport 带 rotation 共 2 处（base + 渲染）',
     count(WORKER, /getViewport\(\{[^}]*rotation: rot[^}]*\}\)/g), 2);
}

// ====== 4. 主线程与缩略图路径同样带 rotation =====
{
  // 主线程渲染路径
  ok('主线程渲染路径 base/css/render 三个 viewport 都带 rotation',
     /const rot = this\._page_rotation;[\s\S]{0,400}?getViewport\(\{ scale: 1, rotation: rot \}\)[\s\S]{0,300}?getViewport\(\{ scale: css_scale, rotation: rot \}\)[\s\S]{0,300}?getViewport\(\{ scale: css_scale \* render_dpr, rotation: rot \}\)/.test(SRC));
  // 缩略图主线程回退路径
  ok('缩略图回退路径 viewport 带 rotation',
     /const rot = this\._page_rotation;[\s\S]{0,900}?getViewport\(\{ scale: page_scale, rotation: rot \}\)/.test(SRC));
  // 不允许残留未带 rotation 的 getViewport（渲染相关）
  const bare = [...SRC.matchAll(/getViewport\(\{([^}]*)\}\)/g)]
    .map(m => m[1])
    .filter(args => !/rotation/.test(args));
  eq('document_reader 内无「漏传 rotation」的 getViewport', bare.join(' || '), '');
}

// ====== 5. 旋转后必须让重渲染守卫失效 ======
// ⚠️ 必须把断言限定在 set_page_rotation 函数体内。全文件搜同样的语句会命中
// 文档重载路径（_reload_document 里也有一模一样的两行守卫作废），把它删掉照样通过
// —— 守卫必须盯住它自己那一处。
const rotBody = (() => {
  const i = SRC.search(/    (async )?set_page_rotation\(deg,/);
  if (i < 0) return '';
  // 用下一个同缩进的方法定义作为右边界
  const rest = SRC.slice(i);
  const m = /\n    \}\n\n    \/\*\*|\n    \}\n\n    _/m.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
})();
ok('定位到 set_page_rotation 函数体', rotBody.length > 200);
{
  // fit-width 下 css_w 恒为容器宽、target_dpr 不变 → 只清位图缓存不够，
  // 守卫会判定「已达标」而跳过重渲染，页面永远停在旧朝向。
  ok('旋转时作废渲染守卫 pdf_render_css_width/dpr',
     /pd\.pdf_render_css_width = null;/.test(rotBody) && /pd\.pdf_render_dpr = null;/.test(rotBody));
  ok('旋转时清位图缓存', /this\._bitmap_cache_clear\(\);/.test(rotBody));
  ok('旋转时销毁全部瓦片', /this\._destroy_all_tiles\(\);/.test(rotBody));
  ok('旋转时重排全部页盒（比例翻转后框要跟着变）',
     /this\._resize_page_layout\(i, base_w, true\)/.test(rotBody));
  ok('旋转时作废页位置缓存', /this\._invalidate_page_positions\(\);/.test(rotBody));
  // 比例翻转：只在 0/180 ↔ 90/270 之间发生
  ok('旋转时就地取倒数翻转 aspect_ratio',
     /if \(swaps && pd\.aspect_ratio > 0\) pd\.aspect_ratio = 1 \/ pd\.aspect_ratio;/.test(rotBody));
}

// ====== 6. 批注清空（用户确认的设计）=====
{
  ok('旋转清空每页 stroke_history', /pd\.stroke_history = \[\];/.test(rotBody));
  ok('旋转作废批注坐标基准 coord_width/height',
     /pd\.coord_width = 0;[\s\S]{0,80}?pd\.coord_height = 0;/.test(rotBody));
  ok('旋转重置撤销/重做栈（旧命令持有已丢弃的 stroke 引用）',
     /history_init_manager\(\{/.test(rotBody));
  ok('旋转后立即落盘（否则下次打开旧笔迹会回来）',
     /this\._save_annotations_to_cache\(\{ awaitIdle: false \}\)/.test(rotBody));
}

// ====== 7. 宽高比翻转：只在 0/180 ↔ 90/270 之间发生 =====
{
  const swapSrc = /const swaps = (\(prev % 180 !== 0\) !== \(next % 180 !== 0\));/.exec(SRC);
  ok('存在 swaps 奇偶判定', !!swapSrc);
  const swaps = new Function('prev', 'next', 'return ' + swapSrc[1]);
  eq('0°→90° 需翻转比例', swaps(0, 90), true);
  eq('90°→0° 需翻转比例', swaps(90, 0), true);
  eq('90°→270° 不翻转（同为横置）', swaps(90, 270), false);
  eq('0°→180° 不翻转（同为竖置）', swaps(0, 180), false);
  eq('180°→90° 需翻转比例', swaps(180, 90), true);
}

// ====== 8. 多标签切换不串味 =====
{
  ok('tab view 捕获旋转', /pageRotation: this\._page_rotation,/.test(SRC));
  ok('tab view 恢复旋转（旧快照兜底 0）',
     /this\._page_rotation = view\.pageRotation \?\? 0;/.test(SRC));
}

// ====== 9. 持久化 =====
{
  ok('缓存写入 page_rotation', /page_rotation: include_viewport \? this\._page_rotation : 0,/.test(SRC));
  ok('缓存读取 page_rotation', /page_rotation: cache_data\.page_rotation \?\? 0/.test(SRC));
  ok('open 时在任何首屏渲染前落位旋转',
     /this\._cache_ready = true;[\s\S]{0,400}?this\._page_rotation = \(\(\(saved_state\?\.page_rotation/.test(SRC));
}

// ====== 10. UI 接线 =====
{
  ok('头部改为两栏并保留标题节点',
     /className = 'dr-page-sidebar-title'/.test(SRC) &&
     !/header\.textContent = `页面/.test(SRC));
  ok('旋转按钮使用已有的 arrow-clockwise 图标',
     /data-icon="arrow-clockwise"/.test(SRC));
  ok('菜单提供 90/180/270 三个角度',
     /for \(const deg of \[90, 180, 270\]\)/.test(SRC));
  ok('补一次 theme_load_icons（动态插入的 data-icon 不会自动加载）',
     /ThemeManager\?\.theme_load_icons\?\.\(\)/.test(SRC));
  ok('菜单的 document 级监听在侧边栏关闭时摘除（否则长会话无界增长）',
     /removeEventListener\('click', this\._rotate_menu_close, true\)/.test(SRC));
}

// ====== 11. 清空批注前的确认门（仅在画布有笔迹时弹）======
{
  ok('旋转入口是 async（要 await 确认结果）',
     /async set_page_rotation\(deg, skip_confirm = false\)/.test(SRC));
  ok('存在「画布是否有笔迹」判定',
     /_has_any_strokes\(\)\s*\{[\s\S]{0,300}?stroke_history\?\.length/.test(SRC));
  // 门控三要素缺一不可：未跳过后门控 + 角度确实变化 + 画布有笔迹
  ok('确认门条件完整（未跳过 && 角度变化 && 有笔迹）',
     /if \(!skip_confirm && prev !== next && this\._has_any_strokes\(\)\)/.test(rotBody));
  // 注意用 lastIndexOf：只查「第一次出现」的话，在赋值**之后**再加一道确认门
  // 是发现不了的（前面那道原始的门仍然排在赋值之前）。真正要守的不变式是
  // 「角度赋值之前不存在任何确认门」—— 否则弹窗期间画面已转、批注已错位。
  ok('确认前不修改任何状态（角度赋值前不存在任何确认门）',
     rotBody.lastIndexOf('_has_any_strokes()') < rotBody.indexOf('this._page_rotation = next'));
  ok('取消时返回原角度（画面/批注/角度全部原样）',
     /if \(!ok\) return prev;/.test(rotBody));
  ok('确认后才落角度并清批注',
     /this\._page_rotation = next;[\s\S]{0,600}?pd\.stroke_history = \[\];/.test(rotBody));

  // 确认弹窗自身：三个出口都必须结算，且只能结算一次
  const cf = SRC.slice(SRC.indexOf('_show_reader_confirm(title, message)'));
  ok('确认弹窗支持取消/确定/点遮罩三个出口',
     /cancel\.addEventListener\('click', \(\) => finish\(false\)\)/.test(cf) &&
     /ok\.addEventListener\('click', \(\) => finish\(true\)\)/.test(cf) &&
     /if \(e\.target === overlay\) finish\(false\)/.test(cf));
  ok('结算函数有 done 幂等守卫（三出口只结算一次）',
     /if \(done\) return;/.test(cf));
  ok('重开弹窗会先结算上一个（否则连点两下会让第一个 Promise 永久 pending）',
     /if \(this\._reader_confirm_settle\) \{\s*this\._reader_confirm_settle\(false\);/.test(cf));
  ok('结算时摘掉 keydown 监听（否则长会话累积）',
     /document\.removeEventListener\('keydown', on_key\);/.test(cf));
  ok('弹窗元素被外部移除时兜底结算（阅读器关闭时不悬挂）',
     /if \(!overlay\.isConnected\)/.test(cf));
  // 文案必须是 textContent，不能拼 innerHTML
  ok('弹窗文案用 textContent 赋值（不拼 innerHTML）',
     /h\.textContent = title;/.test(cf) && /m\.textContent = message;/.test(cf) &&
     !/dr-reader-confirm[\s\S]{0,400}?innerHTML\s*=/.test(cf));

  // 文案必须在所有语言包里存在
  const missing = [];
  for (const f of fs.readdirSync('src/locales').filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync('src/locales/' + f, 'utf8'));
    if (!j.reader?.rotateTitle || !j.reader?.rotateClearWarn) missing.push(f);
  }
  eq('9 个语言包都带齐旋转确认文案', missing.join(','), '');
}
console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
