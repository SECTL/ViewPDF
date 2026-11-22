// 渲染线程请求取消的失败语义测试。
//
// 真实事故：force 重渲染 / 页面卸载时 cancel_render() 会 reject 排队中的请求，
// 而那个请求可能因 seq 过期已无人 await —— Node/Chromium 报 "Uncaught (in promise)
// RenderingCancelledException"。取消属预期路径，必须由 promise 自己兜住 noop catch；
// 真正 await 的调用方仍要收到取消异常（否则渲染守卫与 seq 逻辑失效）。
import assert from 'node:assert/strict';
import fs from 'node:fs';

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

// 假 Worker：只为了满足构造与 postMessage，不真的派生线程。
globalThis.Worker = class FakeWorker {
  constructor() { this.posted = []; }
  postMessage(m) { this.posted.push(m); }
  terminate() {}
};

const { PdfRenderWorkerHost } = await import('../src/modules/pdf/render-worker-host.js?t=' + Date.now());

const mkHost = () => {
  const h = new PdfRenderWorkerHost();
  h.available = true;
  h._worker = new Worker();
  // 关键：并发上限设为 0 → 请求留在队列/pending 里，cancel_render 走
  // 「queue 出队 + pending.reject」分支（事故栈 render-worker-host.js:286）。
  h._max_inflight = 0;
  return h;
};

const unhandled = [];
const onUnhandled = (e) => unhandled.push(e);
process.on('unhandledRejection', onUnhandled);

// ===== 1. cancel_render 取消排队请求，无人 await 也不能 Uncaught =====
{
  const h = mkHost();
  const p = h.render(1, 800, 1, false, 0); // 故意不 await：模拟调用方已放弃
  eq('请求进入队列', h._queue.length, 1);
  eq('请求登记在 pending', h._pending.size, 1);

  h.cancel_render(1);
  eq('cancel_render 清空队列', h._queue.length, 0);
  eq('cancel_render 清空 pending', h._pending.size, 0);
  await new Promise(r => setTimeout(r, 0)); // 让 unhandledRejection 检查点跑完
  eq('没有未处理的 rejection', unhandled.length, 0);

  // 原 promise 仍是 rejected 状态：真正 await 的地方必须拿到取消异常
  let caught = null;
  try { await p; } catch (e) { caught = e; }
  eq('await 方收到取消异常', caught?.name, 'RenderingCancelledException');
}

// ===== 2. 同页合流：render() 内部取消旧请求同样不能 Uncaught =====
{
  unhandled.length = 0;
  const h = mkHost();
  h.render(2, 800, 1, false, 0); // 旧请求，无人 await
  h.render(2, 800, 2, false, 0); // 新请求触发同页合流（render() 内部 reject 旧的）
  await new Promise(r => setTimeout(r, 0));
  eq('同页合流没有未处理的 rejection', unhandled.length, 0);
}

// ===== 3. 预渲染队列超限丢弃：同样不产生 Uncaught =====
{
  unhandled.length = 0;
  const h = mkHost();
  h._prerender_queue_max = 2;
  h.render(10, 800, 1, true, 0);
  h.render(11, 800, 1, true, 0);
  h.render(12, 800, 1, true, 0); // 触发超限，丢弃最旧的 10
  await new Promise(r => setTimeout(r, 0));
  eq('队列超限没有未处理的 rejection', unhandled.length, 0);
}

// ===== 4. 主线程 pdf.js render_task.promise 的取消兜底 =====
// 日志里曾出现 4× "Uncaught (in promise) RenderingCancelledException: ... page 44"：
// force 重渲染/页面卸载在 await 之前 cancel 主线程 render task，其 promise 无 awaiter。
{
  const dr = fs.readFileSync('src/modules/pdf/document_reader.js', 'utf8');
  ok('主线程 render_task 创建后立即挂 noop catch',
    /page_data\.pdf_render_task = render_task;[\s\S]{0,40}?render_task\.promise\.catch\(\(\) => \{\}\)/.test(dr) ||
    /render_task\.promise\.catch\(\(\) => \{\}\)[\s\S]{0,60}?page_data\.pdf_render_task = render_task;/.test(dr));
}

process.off('unhandledRejection', onUnhandled);
console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
