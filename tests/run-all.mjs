// ViewPDF 验证套件统一入口。
//
// node tests/run-all.mjs                 跑全部（含慢速）
// node tests/run-all.mjs --skip-slow     跳过需要 cargo 的构建身份测试
// node tests/run-all.mjs --group=core    只跑一组
// node tests/run-all.mjs --list          只列出清单
//
// 白名单制：tests/ 里的 spec/自检查工具不能当普通回归测试跑
// （large-doc-harness 是尚未实现的伸缩性规格，_strip-mutation-check 会临时改坏
// dpr-harness）。每组都在这里显式登记。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GROUPS = {
  core: [
    'dpr-harness.mjs',
    'perf-tier-apply.mjs',
    'perf-tier-scoring.mjs',
    'reader-momentum.mjs',
    'flip-perf.mjs',
    'flip-prerender-layout.mjs',
    'display-canvas-pool.mjs',
    'reader-rotation.mjs',
    'reader-confirm.mjs',
    'reader-offpage-pan.mjs',
    'mount-gate.mjs',
    'move-cursor-icon.mjs',
    'fullscreen-button.mjs',
    'oobe-titlebar.mjs',
    'oobe-skip-check.mjs',
    'telemetry-heartbeat.mjs',
    'system-font-fallback.mjs',
    'update-resolve.mjs',
    'stroke-width-scale.mjs',
    'blackboard-stroke-shift.mjs',
  ],
  mutation: [
    'perf-tier-mutation.mjs',
    'reader-offpage-pan-mutation.mjs',
    'mount-gate-mutation.mjs',
    'move-cursor-icon-mutation.mjs',
    'fullscreen-button-mutation.mjs',
    'oobe-titlebar-mutation.mjs',
    'telemetry-mutation.mjs',
    'update-mutation.mjs',
    'stroke-width-scale-mutation.mjs',
    'blackboard-stroke-shift-mutation.mjs',
    'reader-confirm-mutation.mjs',
    'reader-rotation-mutation.mjs',
    'reader-momentum-mutation.mjs',
    'flip-perf-mutation.mjs',
    'flip-prerender-layout-mutation.mjs',
    'display-canvas-pool-mutation.mjs',
    'oobe-skip-check-mutation.mjs',
  ],
  sim: [
    'doc-rotation-math-sim.mjs',
    'pdf-file-open-race-sim.mjs',
    'blackboard-overlay-align-sim.mjs',
    'blackboard-pipeline-align-sim.mjs',
  ],
  extra: [
    // 从 .workbuddy/verify/ 迁来的其余断言型脚本，均实跑通过
    'icon-refs-resolve.mjs',
    'oobe-nav-no-back.mjs',
    'oobe-option-group-reuse.mjs',
    'reader-rotation-overlap.mjs',
  ],
  slow: [
    'build-identity.mjs',            // 内部跑 cargo build，数分钟
    'build-identity-mutation.mjs',   // 14 次 cargo build
  ],
  spec: [
    // 手写触发：规格/自检查工具，不进默认套件
    'large-doc-harness.mjs',          // 尚未实现的伸缩性规格，对当前代码 21+ FAIL
    '_strip-mutation-check.mjs',      // 会临时改坏 dpr-harness，跑完恢复
  ],
  legacy: [
    // 期望的是被废弃的 drawnScale/renderScale 设计（19 failed），
    // 与当前「书写时已折算进 stroke.lineWidth」的口径冲突，保留作历史记录但不跑。
    'stroke-width-invariant.mjs',
    'stroke-width-invariant-mutation.mjs',
  ],
};

const args = process.argv.slice(2);
const only = args.find(a => a.startsWith('--group='))?.split('=')[1];
const skipSlow = args.includes('--skip-slow');
const listOnly = args.includes('--list');

if (listOnly) {
  for (const [g, files] of Object.entries(GROUPS)) {
    console.log(`[${g}] ${files.length}`);
    for (const f of files) console.log('  ' + f);
  }
  process.exit(0);
}

let pass = 0, fail = 0, skip = 0;
const failures = [];
for (const [group, files] of Object.entries(GROUPS)) {
  if (only && group !== only) continue;
  console.log('\n==== ' + group + ' ====');
  for (const f of files) {
    if (group === 'legacy' || group === 'spec' || (group === 'slow' && skipSlow)) {
      const why = group === 'legacy' ? '过期设计，见文件头'
        : group === 'spec' ? '规格/自检查工具，需手写触发'
        : '--skip-slow';
      console.log('SKIP  ' + f + '  (' + why + ')');
      skip++;
      continue;
    }
    const t0 = Date.now();
    let out = '';
    try {
      // cwd 是仓库根（脚本内部都用相对根的路径读源文件），所以必须给完整相对路径
      out = execFileSync(process.execPath, [path.join('tests', f)], {
        cwd: ROOT, encoding: 'utf8', timeout: 600000,
      });
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log('PASS  ' + f.padEnd(42) + sec + 's');
      pass++;
    } catch (e) {
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      out = (e.stdout || '') + (e.stderr || '');
      console.log('FAIL  ' + f.padEnd(42) + sec + 's');
      failures.push(f);
      fail++;
    }
    // 失败时把最后几行留作诊断，成功时吃掉避免刷屏
    if (failures.includes(f)) {
      console.log(out.split('\n').filter(l => l.trim()).slice(-6).map(l => '        ' + l).join('\n'));
    }
  }
}

console.log('\n==================== 汇总 ====================');
console.log(`  PASS ${pass}   FAIL ${fail}   SKIP ${skip}`);
if (failures.length) console.log('  失败: ' + failures.join(', '));
if (fail) process.exitCode = 1;
