// 变异测试：逐个改坏 history.js / history-compactor.js 的不变式，
// 断言 history-compactor.mjs 变红。影子目录里改，不碰真实源码、不碰 git；
// 每条变异跑完都在 finally 里写回原文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HARNESS = 'tests/history-compactor.mjs';
const HISTORY = 'src/modules/history.js';
const COMPACTOR = 'src/modules/canvas/history-compactor.js';
const readNorm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const FILES = {
  [HISTORY]: readNorm(HISTORY),
  [COMPACTOR]: readNorm(COMPACTOR),
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-mut-'));
fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
fs.copyFileSync(HARNESS, path.join(tmpDir, 'tests', 'history-compactor.mjs'));
for (const rel of Object.keys(FILES)) {
  const dst = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, FILES[rel], 'utf8');
}

const M = [
  // ── history.js ──
  {
    label: 'MAX_HISTORY_STEPS 从 50 改成 25（压缩/裁剪阈值全变）',
    file: HISTORY, expect: 'MAX_HISTORY_STEPS 常量 = 50',
    from: 'export const MAX_HISTORY_STEPS = 50;',
    to: 'export const MAX_HISTORY_STEPS = 25;',
  },
  {
    label: 'undo 硬裁剪阈值从 MAX 改成 MAX*2（只裁到 100，留太多历史）',
    file: HISTORY, expect: '执行 101 次后 undo 栈裁到 50',
    from: 'const excessCount = history_state.undo_list.length - MAX_HISTORY_STEPS;',
    to: 'const excessCount = history_state.undo_list.length - MAX_HISTORY_STEPS * 2;',
  },
  {
    label: 'undo 失败不回滚栈（redo 里躺着未撤销的命令）',
    file: HISTORY, expect: 'undo 失败后命令回到 undo 栈',
    from: '        if (command !== undefined) {\n            history_state.redo_list.pop();\n            history_state.undo_list.push(command);\n        }',
    to: '        /* 失败不回滚 */',
  },
  {
    label: 'redo 失败不回滚栈',
    file: HISTORY, expect: 'redo 失败后命令回到 redo 栈',
    from: '        if (command !== undefined) {\n            history_state.undo_list.pop();\n            history_state.redo_list.push(command);\n        }',
    to: '        /* 失败不回滚 */',
  },
  {
    label: 'undo 不把命令压入 redo 栈（重做永远失效）',
    file: HISTORY, expect: 'undo 后 redo 栈 1 条',
    from: '        command = history_state.undo_list.pop();\n        history_state.redo_list.push(command);',
    to: '        command = history_state.undo_list.pop();',
  },
  {
    label: 'redo 不把命令压回 undo 栈（撤销/重做后栈形状错位）',
    file: HISTORY, expect: 'redo 后 undo 栈 1 条',
    from: '        command = history_state.redo_list.pop();\n        history_state.undo_list.push(command);',
    to: '        command = history_state.redo_list.pop();',
  },
  {
    label: '压缩判定 > 改成 >=（恰好 50 条就误判需要压缩）',
    file: HISTORY, expect: '边界：恰好 50 条时不需要压缩',
    from: 'export function history_validate_compact() {\n    return history_state.undo_list.length > MAX_HISTORY_STEPS;\n}',
    to: 'export function history_validate_compact() {\n    return history_state.undo_list.length >= MAX_HISTORY_STEPS;\n}',
  },
  {
    label: 'format compact 的 <=0 改成 <0（count=0 也照压不误）',
    file: HISTORY, expect: 'explicitCount=0 不压缩',
    from: '    if (compactCount <= 0) return false;',
    to: '    if (compactCount < 0) return false;',
  },
  {
    label: 'format compact 保留段从 slice(count) 改成 slice(0)（旧命令没被替换掉）',
    file: HISTORY, expect: '压缩后 undo 栈 = 1 快照 + 剩余 50',
    from: '        ...history_state.undo_list.slice(compactCount)',
    to: '        ...history_state.undo_list.slice(0)',
  },
  {
    label: '待压缩列表 slice(0,count) 改成 slice(0)（把整栈都当旧命令压缩）',
    file: HISTORY, expect: '待压缩条数 = 55 - 50 = 5',
    from: '    return history_state.undo_list.slice(0, compactCount);',
    to: '    return history_state.undo_list.slice(0);',
  },
  {
    label: 'delete_all 不清 redo 栈（清空后仍能重做出旧笔画）',
    file: HISTORY, expect: 'delete_all 清空 redo 栈',
    from: 'export function history_delete_all() {\n    history_state.undo_list = [];\n    history_state.redo_list = [];',
    to: 'export function history_delete_all() {\n    history_state.undo_list = [];',
  },
  {
    label: 'reset_executing 变成空操作（异常后永久卡在执行锁）',
    file: HISTORY, expect: 'reset_executing 解锁',
    from: 'export function history_reset_executing() {\n    history_state.is_executing = false;\n}',
    to: 'export function history_reset_executing() {\n    /* 不解锁 */\n}',
  },
  {
    label: 'trim_undo_front 从 pop 尾端裁剪（留下的不是最新步数）',
    file: HISTORY, expect: 'trim_undo_front 保留最新两条',
    from: '        history_state.undo_list.shift();',
    to: '        history_state.undo_list.pop();',
  },
  {
    label: 'DrawCommand.execute 不去重（同一笔画重复入栈）',
    file: HISTORY, expect: '重复 execute 不重复入栈',
    from: '        if (!this.strokeHistoryRef.includes(this.stroke)) {',
    to: '        if (true) {',
  },
  {
    label: 'DrawCommand.undo 总删第一个（误删别人的笔画）',
    file: HISTORY, expect: 'DrawCommand.undo 只移除自己的笔画',
    from: '            this.strokeHistoryRef.splice(index, 1);',
    to: '            this.strokeHistoryRef.splice(0, 1);',
  },
  {
    label: 'SnapshotCommand.undo 不恢复压缩前笔画（撤销后内容丢失）',
    file: HISTORY, expect: '快照 undo 恢复压缩前全部笔画',
    from: '        this.beforeStrokes.forEach(s => this.strokeHistoryRef.push(s));',
    to: '        /* 不恢复 beforeStrokes */',
  },
  {
    label: 'SnapshotCommand.redo 不恢复压缩后笔画（重做后内容丢失）',
    file: HISTORY, expect: '快照 redo 回到压缩后状态',
    from: '        this.afterStrokes.forEach(s => this.strokeHistoryRef.push(s));',
    to: '        /* 不恢复 afterStrokes */',
  },

  // ── history-compactor.js ──
  {
    label: 'initCompaction 不做隔离态检查',
    file: COMPACTOR, expect: '隔离态不排空闲回调',
    from: '        initCompaction() {\n            if (window.__HISTORY_ISOLATED) return;',
    to: '        initCompaction() {\n            /* 不检查隔离态 */',
  },
  {
    label: '没有压缩目标时不提前返回（空笔画也走一遍快照）',
    file: COMPACTOR, expect: '无压缩目标时直接返回',
    from: '            if (commandsToCompact.length === 0) return;',
    to: '            /* 不提前返回 */',
  },
  {
    label: '压缩执行前不再复查撤销栈（二次 validate 失效）',
    file: COMPACTOR, expect: '压缩期间撤销栈变化时取消（第二次 validate）',
    from: "            if (!deps.historyValidateCompact()) {\n                console.log('压缩期间撤销栈已变化，取消压缩');",
    to: "            if (false) {\n                console.log('压缩期间撤销栈已变化，取消压缩');",
  },
  {
    label: 'loadId 过期不取消（新底图加载抢占后仍提交旧快照）',
    file: COMPACTOR, expect: 'loadId 过期时不改 strokeHistory',
    from: '            if (loadId !== state.baseImageLoadId) {\n                deps.releaseOffscreenCanvas(offscreen);',
    to: '            if (false) {\n                deps.releaseOffscreenCanvas(offscreen);',
  },
  {
    label: 'compactSnapshotId 过期不取消',
    file: COMPACTOR, expect: 'compactSnapshotId 过期时不改 strokeHistory',
    from: "            if (compactSnapshotId !== state.compactSnapshotId) {\n                console.log('压缩快照已过期,取消操作');",
    to: "            if (false) {\n                console.log('压缩快照已过期,取消操作');",
  },
  {
    label: 'remaining 过滤反向（只剩被压缩的笔画）',
    file: COMPACTOR, expect: '压缩后 strokeHistory 只剩未压缩笔画',
    from: '            const remainingStrokes = state.strokeHistory.filter(s => !strokesToCompactSet.has(s));',
    to: '            const remainingStrokes = state.strokeHistory.filter(() => true);',
  },
  {
    label: '压缩后不更新 baseImageURL（底图还是旧的）',
    file: COMPACTOR, expect: 'baseImageURL 更新为压缩后底图',
    from: '            state.baseImageURL = afterImageURL;',
    to: '            /* 忘记更新底图 URL */',
  },
  {
    label: '不调用 historyFormatCompact（撤销栈里没有快照命令）',
    file: COMPACTOR, expect: 'historyFormatCompact 收到快照与压缩目标条数',
    from: '            deps.historyFormatCompact(snapshotCmd, compactTargetCount);',
    to: '            /* 忘记格式化压缩 */',
  },
  {
    label: 'beforeStrokes 不深拷贝（压缩原地改写后快照内容也被改）',
    file: COMPACTOR, expect: '快照 beforeStrokes 是独立深拷贝数组',
    from: '            const beforeStrokes = deps.cloneStrokeDeep(state.strokeHistory);',
    to: '            const beforeStrokes = state.strokeHistory;',
  },
  {
    label: '图片 onload 不校验 loadId（过期图片仍被回填为底图）',
    file: COMPACTOR, expect: 'onload 遇到过期 loadId 不恢复 baseImageObj',
    from: '                if (loadId === state.baseImageLoadId) {',
    to: '                if (true) {',
  },
  {
    label: '去重集合每次塞新对象（同一笔画重复渲染，Set 形同虚设）',
    file: COMPACTOR, expect: '去重后只渲染唯一笔画（命令 3 条，唯一 2 条）',
    from: '                if (cmd.stroke) strokesToCompactSet.add(cmd.stroke);',
    to: '                if (cmd.stroke) strokesToCompactSet.add({ ...cmd.stroke });',
  },
  {
    label: '压缩目标不看命令列表，直接拿整条 strokeHistory（全量压缩）',
    file: COMPACTOR, expect: 'render 收到将被压缩的笔画（去重后的 s1/s2）',
    from: '                if (cmd.stroke) strokesToCompactSet.add(cmd.stroke);',
    to: '                state.strokeHistory.forEach(s => strokesToCompactSet.add(s));',
  },
];

let pass = 0, fail = 0, skip = 0, uncaught = 0;

for (const m of M) {
  const orig = FILES[m.file];
  const hits = orig.split(m.from).length - 1;
  if (hits !== 1) {
    skip++;
    console.log('[SKIP]  ' + m.label + '  → 锚点出现 ' + hits + ' 次（必须恰好 1 次）');
    continue;
  }
  const mutated = orig.replace(m.from, m.to);
  if (mutated === orig) {
    fail++;
    console.log('FAIL  [' + m.label + '] 变异是空操作');
    continue;
  }
  const dst = path.join(tmpDir, m.file);
  fs.writeFileSync(dst, mutated, 'utf8');
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [HARNESS], { cwd: tmpDir, encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
    code = typeof e.status === 'number' ? e.status : 1;
  }
  const lines = out.split(/\r?\n/);
  const caught = lines.some((l) => l.startsWith('FAIL') && l.includes(m.expect));
  if (caught) {
    pass++;
    console.log('PASS  ' + m.label + '   → ' + m.expect);
  } else if (code !== 0) {
    uncaught++;
    console.log('[UNCAUGHT]  ' + m.label + '  → harness 崩了但没有预期 FAIL 行\n' +
      lines.filter((l) => l.startsWith('FAIL')).slice(0, 3).map((l) => '        ' + l).join('\n'));
  } else {
    fail++;
    console.log('FAIL  [' + m.label + '] 没抓到（预期 ' + m.expect + '）');
  }
  fs.writeFileSync(dst, orig, 'utf8');   // 还原，避免上一条变异污染下一条
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('\n==== ' + pass + ' captured, ' + fail + ' fail, ' + skip + ' skip, ' + uncaught + ' uncaught ====');
if (fail || skip || uncaught) process.exitCode = 1;
