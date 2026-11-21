// 变异测试：逐条破坏不变式，断言 telemetry-heartbeat.mjs 会变红。
//
// 为什么必须自证会红：AGENTS.md 记着一次「`const overlay` 被重复赋值、
// 每次弹窗抛 TypeError」的回归，**通过了当时全部正则守卫**。守卫一旦写错
// （断言方向反了、正则匹配不到、hook 没接上），它会一直绿着，把真正的回归
// 一起放行 —— 那比没有守卫更危险，因为它还给人「这块测过了」的错觉。
//
// 做法：把 src/ 整树复制到临时目录（不碰真实工作区，避免中途失败留下脏文件），
// 用 VP_APP_SRC 指过去，在副本上打补丁再跑 harness。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const HARNESSES = {
  'telemetry-heartbeat': path.join(ROOT, 'tests', 'telemetry-heartbeat.mjs'),
  'dpr-harness': path.join(ROOT, 'tests', 'dpr-harness.mjs'),
};

let pass = 0, fail = 0;
function report(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   ' + detail : ''));
}

/** 复制整棵树到临时目录（src/ 6 MB / 335 文件，复制成本可忽略） */
function fresh_copy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewpdf-telem-'));
  fs.cpSync(SRC, path.join(dir, 'src'), { recursive: true });
  return path.join(dir, 'src');
}

function patch(src_dir, rel, pairs) {
  const p = path.join(src_dir, rel);
  let body = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (!body.includes(from)) {
      throw new Error(`补丁锚点未命中 ${rel}: ${JSON.stringify(from.slice(0, 60))}`);
    }
    body = body.replace(from, to);
  }
  fs.writeFileSync(p, body);
}

function run(src_dir, which = 'telemetry-heartbeat') {
  const r = spawnSync(process.execPath, [HARNESSES[which]], {
    env: { ...process.env, VP_APP_SRC: src_dir },
    encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = [...out.matchAll(/^FAIL\s+(.*)$/gm)].map((m) => m[1].trim());
  return { code: r.status, failed, out };
}

const CFG = 'modules/telemetry/telemetry-config.js';
const API = 'modules/telemetry/telemetry-api.js';
const SCHED = 'modules/telemetry/telemetry.js';

/**
 * 每个变异：{ name, patches: [{file, pairs}], expect }
 * expect 是 harness 某条 FAIL 行的子串 —— 只要那条守卫真的抓到了这个变异即可。
 *
 * patches 刻意支持跨文件：一个不变式往往由两处共同保证，只改一半等于没变异。
 * 本轮就踩过：把 `_tick_inflight = false` 从 finally 挪到成功路径，harness 全绿 ——
 * 因为 reportOnline 内部自己吞掉了异常、永远不会 reject，那处改动在语义上是空变异。
 * 必须同时让异常能传播出去，才算真的破坏了这个不变式。
 */
const MUTATIONS = [
  {
    name: 'Client ID 退回服务端平台 ID（/online 回 400 invalid_client）',
    patches: [{ file: 'modules/sectl-client.js', pairs: [["export const SECTL_CLIENT_ID = '6a48ced10013cdd594f8';", "export const SECTL_CLIENT_ID = 'platform_9c8003bb30f77c70';"]] }],
    expect: 'platform_id 不是服务端规范的平台 ID',
  },
  {
    name: '地理源退回 ipapi.co（对所有客户端返 403 挑战页，兼底永久失效）',
    patches: [{ file: 'modules/telemetry/telemetry-config.js', pairs: [["export const GEO_API_URL = 'https://freeipapi.com/api/json';", "export const GEO_API_URL = 'https://ipapi.co/json/';"]] }],
    expect: '地理源',
  },
  {
    name: '不拆市名括号（city 与 district 变成同一个字符串）',
    patches: [{ file: 'modules/telemetry/telemetry-geo.js', pairs: [["    const m = /^(.*?)\\s*\\(([^()]*)\\)\\s*$/.exec(raw);\n    if (!m) return { city: raw, district: null };\n    const city = m[1].trim();\n    const district = m[2].trim();", "    const m = null;\n    if (!m) return { city: raw, district: null };\n    const city = m[1].trim();\n    const district = m[2].trim();"]] }],
    expect: '括号里是区名',
  },
  {
    name: '心跳周期退回 5 分钟（贴死在线窗口，无抖动余量）',
    patches: [{ file: CFG, pairs: [['HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000', 'HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000']] }],
    expect: '抖动余量',
  },
  {
    name: '心跳周期退回 10 分钟（周期 > 在线窗口）',
    patches: [{ file: CFG, pairs: [['HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000', 'HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000']] }],
    expect: '不超过在线判定窗口',
  },
  {
    name: '去掉 _starting 并发闸（两次并发 init 会起两个定时器）',
    patches: [{ file: SCHED, pairs: [['if (_starting || _heartbeat_timer !== null) {', 'if (_heartbeat_timer !== null) {']] }],
    expect: '并发 init 只起一个定时器',
  },
  {
    name: '去掉整个 init 幂等判据（重复 init 叠加定时器）',
    patches: [{ file: SCHED, pairs: [['if (_starting || _heartbeat_timer !== null) {', 'if (false) {']] }],
    expect: '串行重复 init 仍只有一个定时器',
  },
  {
    name: '_tick_inflight 只在成功路径清（一次失败永久卡死心跳）',
    patches: [
      {
        file: SCHED,
        pairs: [
          // 在成功路径补一次清闸
          ['        await reportOnline();\n    } finally {', '        await reportOnline();\n        _tick_inflight = false;\n    } finally {'],
          // 再把 finally 里那次删掉。只做第一步的话 finally 照样清闸，语义上是空变异。
          // 用字符串锚点而不是注释全文：注释里那些中文引号/破折号太容易对不上。
          // replace 只替换首个匹配，而成功路径那次后面跟的是 `} finally {`，
          // 所以这里命中的必然是 finally 里的那一次。
          ['_tick_inflight = false;\n    }\n}', '    }\n}'],
        ],
      },
      // 同时让 reportOnline 能把异常抛出去，否则上一处改动在语义上是空变异。
      // 注意不能用 `try {` → `if (1) {` 这种改法：后面还跟着 `} catch (e) {`，
      // 会直接变成语法错误、模块加载就崩，断言一条都跑不到（也是空变异）。
      { file: API, pairs: [["        console.warn('[telemetry] online report error:', e);\n        return null;", '        throw e;']] },
    ],
    expect: '心跳没被一次失败杀死',
  },
  {
    name: '去掉在途闸（慢请求时心跳无限堆叠）',
    patches: [{ file: SCHED, pairs: [['if (_tick_inflight) {', 'if (false) {']] }],
    expect: '只有 1 条在途',
  },
  {
    name: 'stop 不清延迟定时器（关开关后仍漏发一条）',
    patches: [{
      file: SCHED,
      pairs: [['    if (_startup_timer !== null) {\n        clearTimeout(_startup_timer);\n        _startup_timer = null;\n    }\n    console.log', '    console.log']],
    }],
    expect: 'stop 清掉延迟上报',
  },
  {
    name: '周期 tick 也上报版本（版本口径被在线口径污染）',
    patches: [{ file: SCHED, pairs: [['    try {\n        await reportOnline();', '    try {\n        reportVersion();\n        await reportOnline();']] }],
    expect: '不重复上报版本',
  },
  {
    name: '开关判据从发包出口移除（用户关了仍照发）',
    patches: [{
      file: API,
      pairs: [['    if (!(await telemetry_is_enabled())) {\n        console.log(\'[telemetry] disabled by user settings\');\n        return null;\n    }\n    const invoke = telemetry_invoke();', '    const invoke = telemetry_invoke();']],
    }],
    expect: '启动那一发也受开关约束',
  },
  {
    name: '设置读取失败改为默认开启（配置损坏时静默发数据）',
    patches: [{
      file: API,
      pairs: [["console.warn('[telemetry] failed to fetch settings, treat as disabled:', e);\n        return false;", "console.warn('[telemetry] failed to fetch settings, treat as disabled:', e);\n        return true;"]],
    }],
    expect: '设置读取失败',
  },
  {
    name: '心跳调度搬回 OOBE 窗口（随 app_restart 一起消亡）',
    patches: [{
      file: 'oobe.js',
      pairs: [['    // 注意：这里**不要**起遥测。', "    import('./modules/telemetry/telemetry.js').then(m => { m.telemetryInit(); });\n    // 注意：这里**不要**起遥测。"]],
    }],
    expect: 'oobe.js 不再引用遥测',
  },
  {
    name: '版本上报字段夹带时间戳（服务端会忽略，但契约被污染）',
    patches: [{
      file: API,
      pairs: [['            device_uuid: installId\n        });', '            device_uuid: installId,\n            updated_at: new Date().toISOString()\n        });']],
    }],
    expect: '版本上报只有三个字段',
  },
  {
    name: '去掉版本号长度夹（发非法值换服务端 400）',
    patches: [{ file: API, pairs: [['.slice(0, VERSION_MAX_LENGTH)', '']] }],
    expect: '超长版本截到服务端上限',
  },
  {
    name: '停用主窗口启动入口（心跳永不开始）',
    patches: [{
      file: 'init.js',
      pairs: [["        import('./modules/telemetry/telemetry.js')\n            .then(m => m.telemetryInit())\n            .catch(e => console.warn('[init] telemetry start failed:', e));", '']],
    }],
    expect: 'init.js（主窗口）负责起心跳',
  },
  {
    name: '心跳周期常量在第二个文件里被重新定义（双事实来源）',
    patches: [{
      file: SCHED,
      pairs: [['import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STARTUP_DELAY_MS }', 'const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;\nimport { HEARTBEAT_STARTUP_DELAY_MS }']],
    }],
    expect: '心跳周期常量只在 telemetry-config.js 定义',
  },
  {
    // 这条守的是 dpr-harness.mjs 里的「发包出口唯一」正则，不是 harness 的行为断言。
    // 判据上移到 telemetry_post 之后，任何绕过它直发 telemetry_http_post 的旁路
    // 都等于把开关判据作废。两支脚本各守一半，合起来才完整。
    name: '加一条绕过开关的旁路发包口（开关判据被架空）',
    patches: [{
      file: API,
      pairs: [["    const invoke = telemetry_invoke();\n    if (!invoke) return null;\n", "    const invoke = telemetry_invoke();\n    if (!invoke) return null;\n    invoke('telemetry_http_post', { url: API_BASE + API_ENDPOINT_ONLINE, body: '{}' });\n"]],
    }],
    harness: 'dpr-harness',
    expect: 'telemetry_http_post 全文件只有一个调用点',
  },
];

console.log('--- 变异测试：每个不变式被破坏时，harness 必须变红 ---');

// 先确认基线是绿的，否则「全都变红」也说明不了什么
{
  const dir = fresh_copy();
  const base = run(dir);
  report('基线（未变异）全绿', base.code === 0, base.code === 0 ? '' : base.failed.join(' | '));
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}

for (const m of MUTATIONS) {
  const dir = fresh_copy();
  let thrown = null;
  try {
    for (const p of m.patches) patch(dir, p.file, p.pairs);
  } catch (e) {
    thrown = e.message;
  }
  if (thrown) {
    report(m.name, false, '补丁未落地: ' + thrown);
  } else {
    const r = run(dir, m.harness);
    const caught = r.failed.some((f) => f.includes(m.expect));
    report(
      m.name,
      caught,
      caught
        ? ''
        : (r.code === 0
          ? `${m.harness || 'telemetry-heartbeat'} 仍然全绿 —— 这条守卫抓不到该变异，等于没守`
          : '变红了但没命中预期标签: ' + r.failed.join(' | ')),
    );
  }
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);
