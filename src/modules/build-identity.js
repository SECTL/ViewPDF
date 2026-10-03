/**
 * 构建身份 —— 前端唯一读取口 + 开发期覆盖
 *
 * 正常路径只有一条：`resolve_build_identity()` 调 Tauri 的
 * `app_fetch_build_info`。这条间接是必要的：Cargo 版本**分不出通道** ——
 * `v0.3.0-Bata2` 与 `v0.3.0` 的 `CARGO_PKG_VERSION` 都是 `0.3.0`，只有
 * build.rs 编译期注入的 tag 才是事实来源（详见 `app_fetch_build_info`）。
 *
 * ## 开发期覆盖（为什么需要）
 *
 * 「预发布版才出现的东西」（设置侧栏横幅、「版本」栏显示 tag 原文）无法在正式版
 * 构建里看到 —— 除非改 Cargo 版本号重新构建，而那会污染整个构建产物。覆盖让
 * 开发者不用重新打包就能预览这些界面，以及验证更新判定逻辑。
 *
 * ## 三条边界，都是刻意的
 *
 * 1. **只存在于内存**。不写 config.json、不落盘，重启即失效。写成持久化就等于
 *    给发行版埋了一个「用户会误触发的假版本号」，而假版本号会一路影响到更新判定。
 * 2. **不影响遥测**。`telemetry-api.js` 的 `reportVersion` 直接调
 *    `app_fetch_version`，**不经过本模块** —— 否则开发期每次预览都会往服务端上报
 *    一个假版本号，把版本分布统计搅乱。改动时不要「顺手统一」成走这里。
 * 3. **形状必须与 Rust 的 `AppBuildInfo` 完全一致**（`version` / `tag` / `semver` /
 *    `prerelease`），消费方才能在覆盖与不覆盖时走同一段代码。特别地
 *    `version` 填**核心版本**（`0.3.0`）而不是带预发布后缀的全串 —— 否则覆盖出来的
 *    beta 与真实 beta 构建行为不一致，预览就失去意义了。
 *
 * ## 用法（webview 控制台）
 *
 *     ViewPDFDev.setVersion('v0.3.1-Bata3')   // 冒充预发布构建
 *     ViewPDFDev.setVersion('v0.3.0')        // 冒充正式版构建
 *     ViewPDFDev.getVersion()                // 看当前生效的身份
 *     ViewPDFDev.clearVersion()              // 恢复真实构建身份
 *
 * 设置面板若已打开会立即刷新；否则下次打开即为新身份。更新检查的版本比较也跟着变，
 * 正好用来验证「预发布构建不被要求重装自己」这类逻辑。
 */

import { strip_tag_prefix, parse_version } from './update/update-resolve.js';

// ── 覆盖状态（仅内存） ──────────────────────────────────────────────

let _override = null;
const _subscribers = new Set();

/**
 * 把用户输入规整成 `AppBuildInfo` 形状；解析不出来返回 null。
 *
 * **解析失败必须返回 null 而不是静默当正式版**：把 `Bata3` 这种明显不对的输入
 * 悄悄变成「正式版 0.0.0」，会让人以为覆盖生效了而看不出哪里错。
 */
export function parse_override(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const parsed = parse_version(s);
  if (!parsed) return null;

  const semver = strip_tag_prefix(s).split('+')[0];
  const has_v = /^[vV]/.test(s);
  return {
    // 核心版本，与 Cargo 版本对得上；真实 beta 构建的 `version` 也是核心版本
    version: parsed.core.join('.'),
    tag: has_v ? s : `v${s}`,
    semver,
    prerelease: parsed.pre.length > 0,
  };
}

/**
 * 设置覆盖。返回生效的身份；输入无法解析时抛错并**保持原状**。
 *
 * 抛错而不是静默忽略：控制台里敲错一个字符却毫无反馈，下一步就会去怀疑别的
 * 地方，白白花时间。
 */
export function set_version_override(raw) {
  const parsed = parse_override(raw);
  if (!parsed) throw new Error(`无法解析的版本号：${JSON.stringify(raw)}（示例：v0.3.1-Bata3）`);
  _override = parsed;
  _notify();
  return _override;
}

/** 清除覆盖，恢复真实构建身份。返回是否真的有覆盖被清掉（便于脚本判断）。 */
export function clear_version_override() {
  const had = _override !== null;
  _override = null;
  if (had) _notify();
  return had;
}

/** 当前覆盖，未设置时为 null */
export function get_version_override() {
  return _override;
}

/** 覆盖变化时通知订阅者（设置面板用它就地刷新，不必重开面板） */
export function on_build_identity_change(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

function _notify() {
  for (const fn of _subscribers) {
    try { fn(_override); } catch (e) { console.warn('构建身份变更回调失败:', e); }
  }
}

// ── 正常读取路径 ────────────────────────────────────────────────────

/**
 * 取当前生效的构建身份：有覆盖用覆盖，否则问 Tauri。
 *
 * 这是**唯一**该调 `app_fetch_build_info` 的地方（遥测那条路刻意不走这里，
 * 见文件头第 2 条边界）。
 *
 * @param invoke Tauri invoke；测试可注入
 */
export async function resolve_build_identity(invoke) {
  if (_override) return { ..._override };
  return invoke('app_fetch_build_info');
}

// ── webview 控制台入口 ──────────────────────────────────────────────

// 挂在 window 上是因为需求就是「在 webview 里可用」，而本模块除了这个工具
// 没有别的职责，所以显式写在这里而不是塞进 init.js —— 后者会让人误以为
// ViewPDFDev 有生命周期，而它其实只是一个内存里的开发期开关。
if (typeof window !== 'undefined') {
  window.ViewPDFDev = {
    setVersion: set_version_override,
    clearVersion: clear_version_override,
    getVersion: () => ({ ...(_override || { tag: '', version: '', semver: '', prerelease: false }) }),
    /** 覆盖生效中？（便于脚本先判断再决定要不要设） */
    isOverridden: () => _override !== null,
  };
}