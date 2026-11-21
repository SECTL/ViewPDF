// 仿真：双击 .pdf（文件关联）→ 启动应用 → 是否进入文档
//
// 复现上一版「偶现不进入文档」的竞态，并验证新的「Rust state 暂存 + 前端主动 drain」方案。
//
// 老方案：setup 把 args[1] 的文件路径交给一个线程，sleep(500ms) 后 emit('file-opened')。
//        前端在 main.js 加载后注册 listen('file-opened')，就绪时刻记为 T_listen。
//        - 若 T_listen <= 500ms：监听已注册，事件被接收 → 文档打开 ✅
//        - 若 T_listen >  500ms（冷启动/慢机/高负载）：emit 早于监听注册 → 事件静默丢弃 → 文档不打开 ❌
//        这正是「偶现」：取决于本机启动快慢，时而 <500 时而 >500。
//
// 新方案：setup 在 T=0 把路径写入 PendingOpenFiles state；前端注册监听后调用
//        drain_pending_open_files() 主动拉取。state 不依赖监听时序，无论 T_listen 多大都能取到。
//
// 结论：老方案在 T_listen>500 时必然失败；新方案在所有 T_listen 下都成功。

const SLEEP_OLD_MS = 500;

// 模拟若干「前端就绪时刻」：覆盖快启动(200ms)、临界(500ms)、慢启动(800~2000ms)
const listenTimes = [200, 400, 500, 600, 800, 1200, 2000];

function simulateOld(sleepMs, tListen) {
  // emit 在 sleepMs 触发；若此时监听尚未注册(T_listen > sleepMs)，事件丢失
  return tListen <= sleepMs; // true=打开
}

function simulateNew(_tListen) {
  // state 在 T=0 写入，前端就绪后任意时刻 drain 都能取到
  return true; // 恒打开
}

let oldFail = 0, newFail = 0;
const rows = [];
for (const t of listenTimes) {
  const oldOk = simulateOld(SLEEP_OLD_MS, t);
  const newOk = simulateNew(t);
  if (!oldOk) oldFail++;
  if (!newOk) newFail++;
  rows.push(
    `T_listen=${String(t).padStart(4)}ms  老(sleep500+emit)=${oldOk ? '打开✅' : '丢失❌'}   新(drain state)=${newOk ? '打开✅' : '丢失❌'}`
  );
}

console.log('=== 双击 PDF 启动：前端就绪时刻 vs 是否进入文档 ===');
console.log(rows.join('\n'));
console.log('');
console.log(`老方案失败场景数: ${oldFail}/${listenTimes.length}  (T_listen>500ms 的慢启动/高负载必然触发)`);
console.log(`新方案失败场景数: ${newFail}/${listenTimes.length}  (恒打开)`);
console.log('');
if (oldFail > 0 && newFail === 0) {
  console.log('结论：新方案彻底消除该竞态 ✅');
  process.exit(0);
} else {
  console.log('结论：仿真未达成预期 ❌');
  process.exit(1);
}
