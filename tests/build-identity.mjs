// 真跑 build.rs 的 tag 推导（用真实的 build.rs，不复刻逻辑）。
//
// 为什么非做不可：这一段的失败模式全是**静默**的 —— 声明填错、rerun-if 少了、
// 或者误删了 git 探测，都会让 beta 构建安静地变成「正式版」。复刻一份逻辑来测
// 等于什么都没测：复制品永远是绿的。
//
// 做法：把 build.rs + 一个最小 Cargo.toml 复制到临时目录，逐个场景改
// build-info.json 后 `cargo build`，从产物的环境变量里读出 VIEWPDF_BUILD_TAG。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// VP_BUILD_ROOT 让 build-identity-mutation.mjs 能把 build.rs 与 build-info.json
// 复制到临时目录再打补丁跑，从而在不碰真实工作区的前提下做变异。
// 它指的是 **crate 目录**（src-tauri/），不是仓库根 —— 声明文件现在就在那里。
const CRATE = process.env.VP_BUILD_ROOT || fileURLToPath(new URL('../src-tauri', import.meta.url));
const BUILD_RS = path.join(CRATE, 'build.rs');
const DECL_REL = 'build-info.json';

let pass = 0, fail = 0;
const str = (v) => (typeof v === 'string' ? v : String(v));
function eq(label, got, want) {
  const ok = Object.is(got, want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + str(got) + ' want=' + str(want));
}
function ok(label, got) { eq(label, !!got, true); }

const build_rs = fs.readFileSync(BUILD_RS, 'utf8');

/**
 * 在临时目录里真的编译一次 build.rs，读出它 emit 的 VIEWPDF_BUILD_TAG。
 * 失败/报错时返回 { error } —— 期望构建失败的场景正是靠这个判。
 */
function run_build_rs(decl, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewpdf-tag-'));
  try {
    // 声明文件与 build.rs 同级（crate 根）：临时目录里 CARGO_MANIFEST_DIR
    // 就是 <dir>/crate，所以声明写在那一层。
    fs.mkdirSync(path.join(dir, 'crate', 'src'), { recursive: true });
    if (decl !== null) fs.writeFileSync(path.join(dir, 'crate', DECL_REL), decl, 'utf8');
    // 复制真实的 build.rs，但把 `tauri_build::build()` 换成空实现 —— 它只生成
    // tauri 的 config/permissions，与 tag 推导毫无关系，而探针 crate 不该依赖
    // tauri-build（拖进来几百个包，每个场景都要重编一遍）。
    // ⚠️ 被测的 `emit_build_tag()` 一个字都不动。
    const src = fs.readFileSync(BUILD_RS, 'utf8');
    fs.writeFileSync(path.join(dir, 'crate', 'build.rs'),
      src.replace('tauri_build::build()', '/* 探针不跑 tauri codegen */'), 'utf8');
    fs.writeFileSync(path.join(dir, 'crate', 'Cargo.toml'),
      '[package]\nname = "tagprobe"\nversion = "0.3.0"\nedition = "2021"\n' +
      'build = "build.rs"\n\n[build-dependencies]\nserde_json = "1"\n\n[dependencies]\n',
      'utf8');
    fs.writeFileSync(path.join(dir, 'crate', 'src', 'lib.rs'), '', 'utf8');

    const env = { ...process.env, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      CARGO_HOME: process.env.CARGO_HOME, USERPROFILE: process.env.USERPROFILE };
    // 显式给一个非 git 的临时目录，避免万一还残留 git 探测时被仓库的 tag 命中
    delete env.VIEWPDF_BUILD_TAG;
    if (opts.envTag) env.VIEWPDF_BUILD_TAG = opts.envTag;

    const r = spawnSync('cargo', ['build', '--offline', '--quiet'],
      { cwd: path.join(dir, 'crate'), env, encoding: 'utf8', shell: true });
    if (r.status !== 0) return { error: ((r.stderr || '') + (r.stdout || '')).trim() };

    // 从 build script 输出目录里找出 emit 的环境变量与 rerun-if 指令
    const outDir = path.join(dir, 'crate', 'target');
    const found = [];
    const rerun = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.startsWith('output')) continue;
        for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
          const m = /^cargo:rustc-env=VIEWPDF_BUILD_TAG=(.*)$/.exec(line);
          if (m) found.push(m[1]);
          const r = /^cargo:rerun-if-changed=(.*)$/.exec(line);
          if (r) rerun.push(r[1].trim());
        }
      }
    };
    walk(outDir);
    return { tags: found, rerun };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('--- 声明为正式版 ---');
{
  const r = run_build_rs(JSON.stringify({ prerelease: false, beta: 0 }));
  ok('构建成功', !r.error);
  eq('tag 固定为 v{Cargo 版本}', (r.tags || [])[0], 'v0.3.0');
}

console.log('--- 声明为预发布版 ---');
for (const beta of [1, 2, 3, 12]) {
  const r = run_build_rs(JSON.stringify({ prerelease: true, beta }));
  ok(`beta=${beta} 构建成功`, !r.error);
  eq(`beta=${beta} → v0.3.0-Bata${beta}`, (r.tags || [])[0], `v0.3.0-Bata${beta}`);
}

console.log('--- 声明错了必须让构建失败（不能静默发成正式版）---');
{
  const r = run_build_rs(JSON.stringify({ prerelease: true, beta: 0 }));
  ok('prerelease:true + beta:0 → 构建失败', !!r.error);
  ok('失败信息点名 beta 要 >=1', /beta/.test(r.error || ''));
}
{
  const r = run_build_rs(JSON.stringify({ prerelease: true }));
  ok('prerelease:true 但没有 beta → 构建失败', !!r.error);
}
{
  const r = run_build_rs(JSON.stringify({ beta: 2 }));
  ok('缺少 prerelease 字段 → 构建失败', !!r.error);
}
{
  const r = run_build_rs(JSON.stringify({ prerelease: "true", beta: 2 }));
  ok('prerelease 不是布尔 → 构建失败', !!r.error);
}
{
  const r = run_build_rs('{ 这不是 JSON ');
  ok('JSON 语法错误 → 构建失败', !!r.error);
}
{
  const r = run_build_rs(null);
  ok('声明文件缺失 → 构建失败（不能默认当正式版）', !!r.error);
}

console.log('--- CI 覆写口仍然优先 ---');
{
  const r = run_build_rs(JSON.stringify({ prerelease: true, beta: 5 }),
    { envTag: 'v9.9.9-CI7' });
  eq('VIEWPDF_BUILD_TAG 压过声明文件', (r.tags || [])[0], 'v9.9.9-CI7');
}
{
  const r = run_build_rs(JSON.stringify({ prerelease: false, beta: 0 }),
    { envTag: '  v0.3.0-Bata8  ' });
  eq('环境变量两侧空白被 trim', (r.tags || [])[0], 'v0.3.0-Bata8');
}
{
  // 空字符串视为「没给」，应当回落到声明文件，而不是变成空 tag
  const r = run_build_rs(JSON.stringify({ prerelease: true, beta: 2 }), { envTag: '   ' });
  eq('空环境变量视为未给', (r.tags || [])[0], 'v0.3.0-Bata2');
}

console.log('--- 不再探测 git tag ---');
{
  const code = build_rs.replace(/\/\/.*$/gm, '');
  ok('build.rs 不再调 git', !/\bgit\b/.test(code));
  ok('不再 import std::process::Command', !build_rs.includes('std::process::Command'));
  ok('VIEWPDF_BUILD_TAG 环境变量变更也会触发重建',
    /rerun-if-env-changed=VIEWPDF_BUILD_TAG/.test(build_rs));

  // 这条最关键，而且必须从**真实构建产物**里验，不能读源码。
  // 少了 rerun-if-changed，改完 build-info.json 再 cargo tauri dev 会沿用旧产物 ——
  // 编译通过、运行正常、界面上看不出任何异常，症状只有「改了没反应」。
  //
  // ⚠️ 之前这条写成了 `源码里有 rerun-if-changed 字样 || 源码里有 decl_path.display()`，
  // 结果那个 `||` 兜底恒真：把 println 整行删掉，decl_path 仍然出现在 panic 消息里，
  // 守卫照样绿。变异测试判定「抓不到」才把它摆出来。
  const r = run_build_rs(JSON.stringify({ prerelease: false, beta: 0 }));
  ok('构建成功', !r.error);
  ok('build script 确实 emit 了指向 build-info.json 的 rerun-if-changed',
    (r.rerun || []).some((p) => p.replace(/\\/g, '/').endsWith('build-info.json')));
}

console.log('--- 仓库里那份声明本身 ---');
{
  const p = path.join(CRATE, DECL_REL);
  ok('build-info.json 存在', fs.existsSync(p));
  ok('声明文件与 build.rs 同级（src-tauri/build-info.json）',
    path.dirname(p) === path.dirname(BUILD_RS));
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  ok('prerelease 是布尔值', typeof j.prerelease === 'boolean');
  ok('beta 是数字', typeof j.beta === 'number');
  ok('两者组合合法（beta>=1 或 prerelease=false）',
    j.prerelease === false || j.beta >= 1);
  // 仓库根不该再残留一份 —— 两处都有的话，改了哪一份生效只有人知道
  ok('仓库根没有残留的第二份声明',
    !fs.existsSync(path.join(path.resolve(CRATE, '..'), DECL_REL)));
  ok('文件未被 gitignore',
    spawnSync('git', ['check-ignore', DECL_REL], { cwd: CRATE, encoding: 'utf8' }).status !== 0);
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);