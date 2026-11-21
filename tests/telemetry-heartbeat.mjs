// 真跑遥测心跳调度的行为测试。
//
// 为什么必须单独一支：本次要修的 bug 是「统计一直接近 0」——启动只发一次心跳，
// 5 分钟窗口一过全部设备判为离线。这类失效**没有任何一条静态正则守卫能看见**：
// setInterval 写了、周期常量写了、endpoint 字符串写了，源码层一切正常，
// 跑起来才发现报告从来没发出去过（OOBE 窗口起定时器，紧接着进程重启）。
// AGENTS.md 记的 `const overlay` 重复赋值事故同理：静态全绿，运行时抛 TypeError。
//
// 这里加载**真实的** telemetry 模块图（Node 原生 ESM 解析相对导入，
// 不做源码改写），用假时钟驱动 setInterval/setTimeout，逐条断言调度语义。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// fileURLToPath 而非 new URL(...).pathname：后者在 Windows 上产出
// "/D:/code/..."，fs 解析时把开头的 "/" 当作当前盘根 → "D:\D:\code\..."。
const APP = process.env.VP_APP_SRC || fileURLToPath(new URL('../src', import.meta.url));
const TEL = path.join(APP, 'modules', 'telemetry');
const readSrc = f => fs.readFileSync(path.join(APP, f), 'utf8');
const readTel = f => fs.readFileSync(path.join(TEL, f), 'utf8');

// ⚠️ 必须在替换全局定时器**之前**抓住真定时器。
// settle() 的超时兜底依赖它；用被替换后的假 setTimeout 的话，
// 「Promise 永不结算」这种最该被抓的失效会变成「兜底也永不触发」→ 静默通过。
const realSetTimeout = globalThis.setTimeout;

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + str(got) + ' want=' + str(want));
};
function str(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function ok(label, got) { eq(label, !!got, true); }

// ---------- 假时钟 ----------
// 定时器条目必须自带 id：fireTimeout() 靠它把自己从表里摘掉（对齐浏览器语义 ——
// 一次性的 timeout 触发后就没了）。少了 id 会 delete(undefined) 静默失败，
// 表里留下一条已触发的僵尸，后续「定时器是否还在」的断言全错。
let timerSeq = 0;
let timers = new Map();
globalThis.setTimeout = (fn, ms) => { const id = ++timerSeq; timers.set(id, { id, fn, ms, kind: 'timeout' }); return id; };
globalThis.setInterval = (fn, ms) => { const id = ++timerSeq; timers.set(id, { id, fn, ms, kind: 'interval' }); return id; };
globalThis.clearTimeout = id => { timers.delete(id); };
globalThis.clearInterval = id => { timers.delete(id); };

const fireIntervals = () => {
  for (const t of [...timers.values()]) if (t.kind === 'interval') t.fn();
};
const fireTimeout = () => {
  for (const t of [...timers.values()]) if (t.kind === 'timeout') { timers.delete(t.id); t.fn(); }
};
const intervalPeriods = () => [...timers.values()].filter(t => t.kind === 'interval').map(t => t.ms);
const countTimers = kind => [...timers.values()].filter(t => t.kind === kind).length;

// ---------- 宿主环境桩 ----------
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: k => { store.delete(k); },
};
Object.defineProperty(globalThis, 'navigator', {
  value: { platform: 'Win32', userAgent: 'node' },
  configurable: true, writable: true,
});

// ---------- Tauri IPC 桩 ----------
const UUID = '23518b9f-99cb-4580-8ebe-7b03593ac96e';
let calls = [];            // 全部 invoke 的 {cmd, args}
let posts = [];            // telemetry_http_post 的已发请求
let telemetry_enabled = true;
let app_version = '0.3.0';
let post_impl = null;      // 覆盖 telemetry_http_post 的行为（抛错/挂起）
let settings_impl = null;  // 覆盖 settings_fetch_all（抛错）

globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case 'settings_fetch_all':
            if (settings_impl) return settings_impl();
            return { settings: { telemetryEnabled: telemetry_enabled } };
          case 'get_device_uuid':
            return UUID;
          case 'app_fetch_version':
            return app_version;
          case 'telemetry_http_post': {
            posts.push({ url: args.url, body: JSON.parse(args.body) });
            if (post_impl) return post_impl(args);
            return JSON.stringify({ success: true, online_count: 42, version_devices: 7 });
          }
          case 'telemetry_http_get':
            return JSON.stringify({ ip: '203.0.113.7', country_name: '中国', region: '广东', city: '深圳' });
          default:
            throw new Error('unexpected invoke: ' + cmd);
        }
      },
    },
  },
};

// 预置地理缓存，避免测试去碰 ipapi.co（translateGeo 对已翻译的名字是幂等的）
function seed_geo() {
  store.set('viewstage_geo_cache', JSON.stringify({
    ip: '203.0.113.7', country_name: '中国', region: '广东',
    city: '深圳', district: '南山区', fetched_at: Date.now(),
  }));
}

const flush = () => new Promise(r => realSetTimeout(r, 0));
async function settle(p, label) {
  const TIMED_OUT = Symbol('timed-out');
  const v = await Promise.race([p, new Promise(r => realSetTimeout(() => r(TIMED_OUT), 400))]);
  if (v === TIMED_OUT) {
    fail++;
    console.log('FAIL  ' + label + '   got=<Promise 永不结算：疑似悬挂> want=<已结算>');
    return '__hung__';
  }
  return v;
}

// Node 默认把未处理 rejection 升级为 uncaught 直接终止进程。生产代码里
// reportOnline 自己吞掉了异常，所以正常路径不该出现任何 unhandled rejection；
// 一旦有人重构到让它往外抛（`_tick_inflight` 只在成功路径清的那种回归），
// 进程会在断言跑到之前就死掉 —— 挂个记录器接住，断言才跑得到该红的那一条。
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

// ---------- 每条用例一份全新的模块实例 ----------
// telemetry.js 有四个模块级 let（两个 timer + 两个闸），必须逐例重置，
// 否则第二条用例会看到第一条留下的定时器，断言全靠假绿。
// 只给叶子模块加 cache-busting query：它的静态依赖（api/config/identity/geo）
// 本就无可变模块级状态，共用同一份实例正是我们想要的。
let modSeq = 0;
async function fresh_telemetry() {
  timerSeq = 0; timers = new Map();
  calls = []; posts = [];
  telemetry_enabled = true; app_version = '0.3.0';
  post_impl = null; settings_impl = null;
  store.clear();
  seed_geo();
  const href = pathToFileURL(path.join(TEL, 'telemetry.js')).href + '?n=' + (++modSeq);
  return await import(href);
}

// 身份常量住在 modules/sectl-client.js（telemetry-config 已不再持有 API base / 平台 ID）
const cfg = await import(pathToFileURL(path.join(TEL, 'telemetry-config.js')).href);
const identity = await import(pathToFileURL(path.join(APP, 'modules', 'sectl-client.js')).href);
const ONLINE_URL = identity.SECTL_API_BASE + cfg.API_ENDPOINT_ONLINE;
const VERSION_URL = identity.SECTL_API_BASE + cfg.API_ENDPOINT_VERSION;
const postsTo = url => posts.filter(p => p.url === url);

// ============================================================
(async () => {
  // ---------- 1. 周期常量本身 ----------
  console.log('--- 心跳周期 vs 服务端 5 分钟在线窗口 ---');
  eq('心跳周期 = 4 分钟（留 20% 余量）', cfg.HEARTBEAT_INTERVAL_MS, 4 * 60 * 1000);
  // 窗口是「最近 5 分钟内有过心跳」。周期一旦 ≥ 窗口，任何一次定时器漂移或请求 RTT
  // 都会让两次上报的实际间隔超过窗口 → 设备在每个周期末尾被判成离线一小段。
  // 折算成在线时长就是系统性偏低，并发峰值也跟着塌。所以必须留出余量。
  eq('心跳周期不超过在线判定窗口', cfg.HEARTBEAT_INTERVAL_MS <= 5 * 60 * 1000, true);
  ok('心跳周期留出 ≥20% 抖动余量（周期×1.2 ≤ 窗口）',
    cfg.HEARTBEAT_INTERVAL_MS * 1.2 <= 5 * 60 * 1000);

  // ---------- 2. 启动：延迟一次 + 起一个周期定时器 ----------
  console.log('--- 启动调度 ---');
  let T = await fresh_telemetry();
  await settle(T.telemetryInit(), 'telemetryInit 结算');
  eq('起且只起一个周期定时器', countTimers('interval'), 1);
  eq('周期定时器间隔 = 配置常量', intervalPeriods()[0], cfg.HEARTBEAT_INTERVAL_MS);
  eq('另有一次延迟启动上报', countTimers('timeout'), 1);
  eq('启动延迟已配置', [...timers.values()].find(t => t.kind === 'timeout').ms, cfg.HEARTBEAT_STARTUP_DELAY_MS);
  eq('延迟期间尚未发任何请求', posts.length, 0);

  fireTimeout();
  await flush(); await flush();
  eq('启动后立刻发一次在线心跳', postsTo(ONLINE_URL).length, 1);
  eq('启动后立刻发一次版本上报', postsTo(VERSION_URL).length, 1);
  eq('延迟定时器已自我移除（不会二次触发）', countTimers('timeout'), 0);

  // ---------- 3. 心跳请求体符合文档契约 ----------
  console.log('--- 请求体契约 ---');
  const online_body = postsTo(ONLINE_URL)[0].body;
  // 钉死上报用的 ID：必须是 Client ID。此前这里发的是服务端规范的平台 ID，
  // 而 /api/stats/online 只认 Client ID → 每次心跳都回 400 invalid_client；
  // 又因为 /api/stats/version 两种 ID 都收，版本上报一路绿灯，把故障掩盖了。
  eq('platform_id 用 Client ID（/online 只认这个）', online_body.platform_id, identity.SECTL_CLIENT_ID);
  eq('platform_id 不是服务端规范的平台 ID', online_body.platform_id === 'platform_9c8003bb30f77c70', false);

  eq('device_uuid 存在', online_body.device_uuid, UUID);
  eq('device_type 在枚举内', ['windows-desktop', 'windows-desktop-web'].includes(online_body.device_type), true);
  eq('地区四字段齐全（文档要求全必填）',
    ['country', 'province', 'city', 'district'].every(k => typeof online_body[k] === 'string' && online_body[k].length > 0), true);
  const version_body = postsTo(VERSION_URL)[0].body;
  eq('版本上报只有三个字段', Object.keys(version_body).sort().join(','), 'device_uuid,platform_id,version');
  eq('版本号取自 app_fetch_version', version_body.version, '0.3.0');

  // ---------- 4. 周期心跳只发在线，不发版本 ----------
  console.log('--- 周期心跳口径 ---');
  // 注意每次 fireIntervals() 之间都要 flush：telemetry_tick 在第一个 await **之前**
  // 就置了 _tick_inflight，所以同一同步块里连点两次，第二次会被在途闸挡掉 ——
  // 那是正确行为，不是 bug。断言「连点两次发两条」等于在要求关掉在途闸。
  fireIntervals(); await flush(); await flush();
  eq('一次 tick 追加一条在线心跳', postsTo(ONLINE_URL).length, 2);
  eq('tick 不重复上报版本（版本是安装口径，不是在线口径）', postsTo(VERSION_URL).length, 1);
  fireIntervals(); await flush(); await flush();
  fireIntervals(); await flush(); await flush();
  eq('再两次 tick 各一条，累计 4', postsTo(ONLINE_URL).length, 4);

  // ---------- 5. 幂等：串行重复 init ----------
  console.log('--- init 幂等 ---');
  T = await fresh_telemetry();
  await settle(T.telemetryInit(), 'init#1');
  await settle(T.telemetryInit(), 'init#2');
  await settle(T.telemetryInit(), 'init#3');
  eq('串行重复 init 仍只有一个定时器', countTimers('interval'), 1);
  fireTimeout(); await flush(); await flush();
  eq('串行重复 init 只发一次版本', postsTo(VERSION_URL).length, 1);

  // ---------- 6. 幂等：并发 init（_starting 闸） ----------
  // 这是最容易漏的一条：判据写在 await 之后的话，两个并发调用会同时看到
  // _heartbeat_timer === null，双双通过 → 两个定时器 → 心跳量翻倍。
  T = await fresh_telemetry();
  await settle(Promise.all([T.telemetryInit(), T.telemetryInit(), T.telemetryInit()]), '并发 init 结算');
  eq('并发 init 只起一个定时器', countTimers('interval'), 1);
  eq('并发 init 只排一次延迟上报', countTimers('timeout'), 1);
  fireTimeout(); await flush(); await flush();
  eq('并发 init 只发一次版本', postsTo(VERSION_URL).length, 1);

  // ---------- 7. 开关关闭 ----------
  console.log('--- 用户开关 ---');
  T = await fresh_telemetry();
  telemetry_enabled = false;
  await settle(T.telemetryInit(), '关闭态 init 结算');
  eq('关闭时不排周期定时器', countTimers('interval'), 0);
  eq('关闭时不排延迟上报', countTimers('timeout'), 0);
  eq('关闭时不发任何请求', posts.length, 0);

  // 开关中途关掉：定时器还在，但每个 tick 自己重读开关（第二道闸）
  T = await fresh_telemetry();
  await settle(T.telemetryInit(), '开启态 init 结算');
  telemetry_enabled = false;
  fireTimeout(); await flush(); await flush();
  eq('启动那一发也受开关约束', posts.length, 0);

  // settings 读取失败 → 保守当关闭
  T = await fresh_telemetry();
  settings_impl = () => { throw new Error('config unreadable'); };
  await settle(T.telemetryInit(), '设置读取失败 init 结算');
  eq('设置读取失败按关闭处理（不发数据）', posts.length, 0);
  eq('设置读取失败不起定时器', countTimers('interval'), 0);

  // ---------- 8. telemetry_stop ----------
  console.log('--- 停止 ---');
  T = await fresh_telemetry();
  await settle(T.telemetryInit(), 'init 后 stop');
  T.telemetry_stop();
  eq('stop 清掉周期定时器', countTimers('interval'), 0);
  eq('stop 清掉延迟上报（否则关开关后仍会漏发一条）', countTimers('timeout'), 0);
  fireIntervals(); fireTimeout(); await flush(); await flush();
  eq('stop 之后不再有任何请求', posts.length, 0);

  // stop → 再 init（重新打开开关）
  T = await fresh_telemetry();
  await settle(T.telemetryInit(), '重启前 init');
  T.telemetry_stop();
  await settle(T.telemetryInit(), '重启后 init');
  eq('stop 后可重新 init', countTimers('interval'), 1);
  fireTimeout(); await flush(); await flush();
  fireIntervals(); await flush(); await flush();
  eq('重新开启后心跳恢复', postsTo(ONLINE_URL).length, 2);

  // ---------- 9. 一次失败不得杀死心跳 ----------
  // 回归动机：若 _tick_inflight 只在成功路径上清，本次失败会永久卡住闸门，
  // 表现和「从来没起过定时器」一模一样 —— 统计悄悄归零，且没有任何报错。
  T = await fresh_telemetry();
  post_impl = () => { throw new Error('HTTP error: 429 rate_limited'); };
  await settle(T.telemetryInit(), '限流态 init');
  fireTimeout(); await flush(); await flush();
  eq('限流下请求确实发出去了（不是被静默吞掉）', postsTo(ONLINE_URL).length, 1);
  eq('失败后闸门已释放', T.telemetry_debug_state().tick_inflight, false);
  eq('失败没有逃逸成未处理 rejection', unhandled.length, 0);
  post_impl = null;
  fireIntervals(); await flush(); await flush();
  eq('恢复后下一次 tick 仍会发（心跳没被一次失败杀死）', postsTo(ONLINE_URL).length, 2);

  // ---------- 10. 在途闸：慢请求不得堆叠 ----------
  T = await fresh_telemetry();
  let release = null;
  post_impl = () => new Promise(r => { release = r; });
  await settle(T.telemetryInit(), '慢请求 init');
  fireTimeout(); await flush(); await flush();
  eq('慢请求已发出', postsTo(ONLINE_URL).length, 1);
  eq('在途标记已置位', T.telemetry_debug_state().tick_inflight, true);
  fireIntervals(); fireIntervals(); fireIntervals(); await flush(); await flush();
  eq('上一次未回时连点三次 tick 仍只有 1 条在途', postsTo(ONLINE_URL).length, 1);
  release(JSON.stringify({ success: true, online_count: 42 }));
  await flush(); await flush();
  eq('放行后在途标记清零', T.telemetry_debug_state().tick_inflight, false);
  fireIntervals(); await flush(); await flush();
  eq('放行后心跳恢复', postsTo(ONLINE_URL).length, 2);

  // ---------- 11. 版本号消毒 ----------
  console.log('--- 版本号消毒 ---');

  T = await fresh_telemetry();
  app_version = 'v1.8.0-beta.1';
  await settle(T.telemetryInit(), '版本消毒 init');
  fireTimeout(); await flush(); await flush();
  eq('剥掉 v 前缀', postsTo(VERSION_URL)[0].body.version, '1.8.0-beta.1');

  T = await fresh_telemetry();
  app_version = 'x'.repeat(200);
  await settle(T.telemetryInit(), '超长版本 init');
  fireTimeout(); await flush(); await flush();
  eq('超长版本截到服务端上限', postsTo(VERSION_URL)[0].body.version.length, cfg.VERSION_MAX_LENGTH);

  T = await fresh_telemetry();
  app_version = '   ';
  await settle(T.telemetryInit(), '空版本 init');
  fireTimeout(); await flush(); await flush();
  eq('空版本不上报（不发非法值换 400）', postsTo(VERSION_URL).length, 0);

  // ---------- 12. 地理字段解析（freeipapi → 上报体）----------
  console.log('--- 地理源与地区字段 ---');
  eq('地理源是 freeipapi（ipapi.co 已对所有客户端返 403 挑战页）', cfg.GEO_API_URL, 'https://freeipapi.com/api/json');
  {
    const geo = await import(pathToFileURL(path.join(APP, 'modules', 'telemetry', 'telemetry-geo.js')).href);
    const tr = await import(pathToFileURL(path.join(APP, 'modules', 'telemetry', 'telemetry-geo-translate.js')).href);
    const translate_geo = tr.translateGeo;
    const sp = geo.splitCityDistrict;
    const j = (v) => JSON.stringify(v);
    eq('实测形状：括号里是区名', j(sp('Jinrongjie (Xicheng District)')), j({ city: 'Jinrongjie', district: 'Xicheng District' }));
    eq('无括号时 district 为 null（交给 translateGeo 用 city 兜底）', j(sp('Shanghai')), j({ city: 'Shanghai', district: null }));
    eq('空值不抛', j(sp('')), j({ city: null, district: null }));
    eq('null 不抛', j(sp(null)), j({ city: null, district: null }));
    eq('undefined 不抛', j(sp(undefined)), j({ city: null, district: null }));
    eq('纯括号无市名 → 退回原值', j(sp('(Xicheng)')), j({ city: '(Xicheng)', district: null }));
    eq('多个括号只取最后一对', j(sp('A (B) (C)')), j({ city: 'A (B)', district: 'C' }));
    eq('非字符串输入不抛', j(sp(123)), j({ city: '123', district: null }));
    // 端到端：真实 freeipapi 载荷 → 上报体
    const shaped = translate_geo({
      ip: '183.218.240.181', country_name: 'China', region: 'Beijing',
      city: sp('Jinrongjie (Xicheng District)').city,
      district: sp('Jinrongjie (Xicheng District)').district,
    });
    eq('国家译成中文', shaped.country_name, '中国');
    eq('省份译成中文', shaped.region, '北京');
    ok('city 与 district 不再是同一个字符串', shaped.city !== shaped.district);
    eq('IP 透传', shaped.ip, '183.218.240.181');
  }

  // ---------- 13. 源码层守卫 ----------
  // 剥注释后再匹配：否则守卫会被自己写的注释骗过（README §1 记过这个坑）。
  console.log('--- 源码层守卫 ---');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(APP);

  const hits = (needle, re) => files
    .map(f => ({ f: path.relative(APP, f).replace(/\\/g, '/'), body: strip(fs.readFileSync(f, 'utf8')) }))
    .filter(x => re.test(x.body));

  eq('心跳周期常量只在 telemetry-config.js 定义',
    hits('x', /HEARTBEAT_INTERVAL_MS\s*=/).map(x => x.f).join(','), 'modules/telemetry/telemetry-config.js');
  eq('版本端点字面量只在 telemetry-config.js',
    hits('x', /['"]\/api\/stats\/version['"]/).map(x => x.f).join(','), 'modules/telemetry/telemetry-config.js');
  eq('心跳周期只在调度器里被消费',
    hits('x', /HEARTBEAT_INTERVAL_MS/).map(x => x.f).sort().join(','),
    'modules/telemetry/telemetry-config.js,modules/telemetry/telemetry.js');

  // OOBE 窗口起定时器必然发不出去：它紧接着就 app_restart，进程连同定时器一起没了。
  const oobe_src = strip(readSrc('oobe.js'));
  eq('oobe.js 不再引用遥测（该窗口随重启消亡）', /telemetry/.test(oobe_src), false);
  const init_src = strip(readSrc('init.js'));
  eq('init.js（主窗口）负责起心跳', /telemetryInit\(\)/.test(init_src), true);
  eq('main.js 在设置变更时联动启停', /telemetry_stop\(\)/.test(strip(readSrc('main.js'))), true);

  console.log('');
  console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('harness crashed:', e);
  process.exit(1);
});
