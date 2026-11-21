// 真跑 _show_reader_confirm 的行为测试。
//
// 为什么单独一支：它曾因「const overlay 被重复赋值」在运行时抛
// TypeError —— 而所有静态正则守卫（textContent 赋值、done 幂等、三出口结算）
// 全部通过。静态检查看不出控制流里的重复赋值，只有真跑一遍才会炸。
// 这支测试的价值就在于它会真的执行 Promise 与 DOM 交互。
import fs from 'node:fs';

const SRC = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};

// ---------- 抠出真实方法体 ----------
const m = /_show_reader_confirm\(title, message\)\s*\{([\s\S]*?)\n    \}\n\n    \/\*\* 画布/.exec(SRC);
if (!m) {
  console.error('FAIL  未定位到 _show_reader_confirm');
  process.exit(1);
}

// ---------- 极简 DOM 替身 ----------
class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.id = '';
    this.type = '';
    this.textContent = '';
    this.hidden = false;
    this._listeners = new Map();
    this.isConnected = true;
  }
  setAttribute(k, v) { this['attr_' + k] = v; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode = null;
    }
    this.isConnected = false;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const a = this._listeners.get(type) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  /** 触发事件；target 默认为自身 */
  fire(type, ev = {}) {
    const e = { type, target: this, key: ev.key, stopPropagation() {} };
    for (const fn of (this._listeners.get(type) || []).slice()) fn(e);
  }
  /** 深度优先找第一个匹配 class 的后代 */
  find(cls) {
    for (const c of this.children) {
      if (String(c.className).split(/\s+/).includes(cls)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
}

const docListeners = new Map();
const body = new El('body');
globalThis.document = {
  body,
  createElement: (tag) => new El(tag),
  getElementById: (id) => body.find('x') && body.children.find((c) => c.id === id) || null,
  addEventListener: (t, fn) => {
    if (!docListeners.has(t)) docListeners.set(t, []);
    docListeners.get(t).push(fn);
  },
  removeEventListener: (t, fn) => {
    const a = docListeners.get(t) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  },
};
globalThis.window = { i18n: { format_translate: (k) => ({ 'common.cancel': '取消', 'common.confirm': '确定' }[k] || k) } };

const keyListeners = new Map();
globalThis.setInterval = () => 0;   // 兜底轮询：测试里不让它真的挂住事件循环
globalThis.document.addEventListener = document.addEventListener;

// 独立捕获 keydown/click 的 document 监听，便于模拟
const fireDoc = (type, ev) => {
  for (const fn of (docListeners.get(type) || []).slice()) fn({ type, ...ev });
};

// ⚠️ 必须给每个 await 加超时兜底。
// Promise 永不结算时，事件循环里没有待办事项，Node 会**干净地退出 0** ——
// 挂起的断言会被静默跳过，测试反而「通过」。而「Promise 悬挂」恰恰是这段代码
// 重点要防的失效模式（见源码里关于 _reader_confirm_settle 的注释），
// 用一个会静默放行的测试去守它等于没守。
const TIMED_OUT = Symbol('timed-out');
function settle(p, label) {
  return Promise.race([
    p,
    new Promise((r) => setTimeout(() => r(TIMED_OUT), 300)),
  ]).then((v) => {
    if (v === TIMED_OUT) {
      fail++;
      console.log('FAIL  ' + label + '   got=<Promise 永不结算：疑似悬挂> want=<已结算>');
      return '__hung__';
    }
    return v;
  });
}

// ---------- 组装被测对象 ----------
const self = { _reader_confirm_settle: null };
const confirm = new Function('document', 'window', 'setInterval',
  'return function (title, message) {' + m[1] + '\n};'
)(document, globalThis.window, globalThis.setInterval).bind(self);

// ---------- 1. 基本路径：确定 ----------
(async () => {
  const p = confirm('旋转页面', '会清空批注');
  const overlay = body.children[body.children.length - 1];
  ok_overlay(overlay);
  const okBtn = overlay.find('dr-reader-confirm-btn-danger');
  const cancelBtn = overlay.find('dr-reader-confirm-btn');
  okBtn.fire('click');
  eq('确定 → resolve(true)', await settle(p, '确定'), true);
  eq('确定后弹窗已从 DOM 移除', overlay.isConnected, false);
  eq('确定后结算句柄已清空', self._reader_confirm_settle, null);

  // ---------- 2. 取消 ----------
  const p2 = confirm('t', 'm');
  const ov2 = body.children[body.children.length - 1];
  ov2.find('dr-reader-confirm-btn').fire('click');
  eq('取消 → resolve(false)', await settle(p2, '取消'), false);

  // ---------- 3. 点遮罩 = 取消 ----------
  const p3 = confirm('t', 'm');
  const ov3 = body.children[body.children.length - 1];
  ov3.fire('click', {});           // target === overlay
  eq('点遮罩 → resolve(false)', await settle(p3, '点遮罩'), false);

  // ---------- 4. Esc = 取消，Enter = 确定 ----------
  const p4 = confirm('t', 'm');
  fireDoc('keydown', { key: 'Escape' });
  eq('Esc → resolve(false)', await settle(p4, 'Esc'), false);

  const p5 = confirm('t', 'm');
  fireDoc('keydown', { key: 'Enter' });
  eq('Enter → resolve(true)', await settle(p5, 'Enter'), true);

  // ---------- 5. 三个出口只结算一次（done 幂等）----------
  const p7 = confirm('t', 'm');
  const ov7 = body.children[body.children.length - 1];
  // 注意别把外层的 settle() 辅助函数遮蔽掉：同名 const 在 TDZ 里，
  // 上面那些 await settle(...) 会直接抛 "Cannot access before initialization"。
  const finish7 = self._reader_confirm_settle;
  finish7(true);
  eq('重复调用 settle 不抛错（done 幂等）', (() => { try { finish7(false); return 'no-throw'; } catch (e) { return e.message; } })(), 'no-throw');
  eq('确定后 resolve(true)', await settle(p7, '确定(幂等)'), true);

  // ---------- 6. 重开弹窗：上一个按取消结算，不得悬挂 ----------
  const p8 = confirm('first', 'm');
  const p9 = confirm('second', 'm');
  eq('连开两次：第一个按取消结算', await settle(p8, '连开两次·第一个'), false);
  body.children[body.children.length - 1].find('dr-reader-confirm-btn-danger').fire('click');
  eq('连开两次：第二个正常结算', await settle(p9, '连开两次·第二个'), true);
  eq('DOM 中不残留确认弹窗', body.children.filter((c) => c.className === 'dr-reader-confirm-overlay').length, 0);

  // ---------- 7. keydown 监听在结算后摘除 ----------
  eq('结算后 document 上无残留 keydown 监听', (docListeners.get('keydown') || []).length, 0);

  console.log('');
  console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})();

function ok_overlay(overlay) {
  eq('弹窗已挂载到 body', overlay && overlay.className, 'dr-reader-confirm-overlay');
  eq('弹窗带确认类按钮（危险操作样式）', !!(overlay && overlay.find('dr-reader-confirm-btn-danger')), true);
  eq('弹窗文案用 textContent（拼 innerHTML 会被这两条抓到）',
     overlay.find('dr-page-sidebar-title') === null &&
     overlay.find('dr-reader-confirm').children[0].tagName === 'DIV', true);
}
