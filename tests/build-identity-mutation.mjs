// 变异测试：破坏构建身份声明的不变式，断言 build-identity.mjs 变红。
//
// 这一块的守卫尤其需要自证能力：它的每种坏法都**不产生编译错误、也不产生运行时
// 错误**，只是安静地把一个 beta 构建变成「正式版」发出去 —— 两头都错（beta 用户
// 以为自己在正式版，正式版用户被提示「你在 beta 上」），而控制台干干净净。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 指向 **crate 目录**（src-tauri/），不是仓库根 —— 声明文件现在就在那里
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HARNESS = path.join(ROOT, 'tests', 'build-identity.mjs');
const BUILD_RS = 'src-tauri/build.rs';
const DECL = 'src-tauri/build-info.json';

let pass = 0, fail = 0;
function report(label, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   ' + detail : ''));
}

function fresh_copy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewpdf-buildtag-'));
  const crate = path.join(dir, 'src-tauri');
  fs.mkdirSync(crate, { recursive: true });
  fs.copyFileSync(path.join(ROOT, BUILD_RS), path.join(dir, BUILD_RS));
  fs.copyFileSync(path.join(ROOT, DECL), path.join(dir, DECL));
  return dir;
}

function patch(src_dir, rel, pairs) {
  const p = path.join(src_dir, rel);
  let body = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (!body.includes(from)) throw new Error(`补丁锚点未命中 ${rel}: ${JSON.stringify(from.slice(0, 70))}`);
    body = body.replace(from, to);
  }
  fs.writeFileSync(p, body);
}

function patch_decl(src_dir, pairs) {
  const p = path.join(src_dir, DECL);
  let body = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    if (!body.includes(from)) throw new Error(`补丁锚点未命中 ${DECL}: ${from}`);
    body = body.replace(from, to);
  }
  fs.writeFileSync(p, body);
}

function run(src_dir) {
  // 用 VP_BUILD_ROOT 指向**副本的 crate 目录**：harness 里 build.rs 与
  // build-info.json 都从那里读（VP_BUILD_ROOT 的语义是 crate 目录，不是仓库根）
  const r = spawnSync(process.execPath, [HARNESS], {
    cwd: ROOT,
    env: { ...process.env, VP_BUILD_ROOT: path.join(src_dir, 'src-tauri') },
    encoding: 'utf8',
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const failed = [...out.matchAll(/^FAIL\s+(.*)$/gm)].map((m) => m[1].trim());
  return { code: r.status, failed, out };
}

const MUTATIONS = [
  {
    // 最阴的一条：少一行 rerun-if-changed，开发期改完 JSON 再构建会沿用旧产物。
    // 编译通过、运行正常、界面上看不出任何异常 —— 只是「改了没反应」。
    name: '少了 rerun-if-changed（改 build-info.json 不触发重建 → 改了没反应）',
    pairs: [['    println!("cargo:rerun-if-changed={}", decl_path.display());', '    // 漏了：改声明文件不会触发重新构建']],
    expect: 'rerun-if-changed',
  },
  {
    name: 'rerun-if-changed 指向了错的路径（等于没配）',
    pairs: [['println!("cargo:rerun-if-changed={}", decl_path.display());', 'println!("cargo:rerun-if-changed=nothing.txt");']],
    expect: 'rerun-if-changed',
  },
  {
    name: 'beta 序号被忽略（Bata3 被编成 Bata0，等于分不清是第几个）',
    pairs: [['format!("v{}-Bata{}", version, beta)', 'format!("v{}-Bata{}", version, 0)']],
    expect: '→ v0.3.0-Bata1',
  },
  {
    // 最要命的一条：声明错了不报错，安静回退成正式版发出去。
    // ⚠️ 补丁必须**语法合法**：第一版把 panic 闭包换成 `let _unused = |e| {...}`，
    // 于是文件仍会在下一步 JSON 解析处 panic —— 构建照样失败、测试照样通过，
    // 但验的已经不是这一条（断言变成恒真）。这里直接换成一份合法的默认值。
    name: 'beta 填 0 时不报错（没填好的 beta 声明被当成正式版发出去）',
    pairs: [[
      '        assert!(\n            beta >= 1,\n            "build-info.json 的 `beta` 是第几个预发布，必须 >= 1；\\\n             想发正式版请把 prerelease 改成 false"\n        );\n',
      '',
    ]],
    expect: '构建失败',
  },
  {
    name: '声明文件缺失时回退成正式版（beta 构建被静默当成正式版）',
    pairs: [[
      '    let raw = std::fs::read_to_string(&decl_path).unwrap_or_else(|e| {\n        panic!(\n            "读不到构建身份声明 {}：{}\\n\\\n             请在 src-tauri/ 下创建 build-info.json，内容如 {{\\"prerelease\\": false, \\"beta\\": 0}}",\n            decl_path.display(),\n            e\n        )\n    });',
      '    let raw = std::fs::read_to_string(&decl_path)\n        .unwrap_or_else(|_| String::from(r#"{"prerelease": false, "beta": 0}"#));',
    ]],
    expect: '构建失败',
  },
  {
    name: 'JSON 语法错误时回退成正式版',
    pairs: [[
      '    let json: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|e| {\n        panic!(\n            "build-info.json 解析失败：{}\\n\\\n             合法内容如 {{\\"prerelease\\": false, \\"beta\\": 0}}",\n            e\n        )\n    });',
      '    let json: serde_json::Value = serde_json::from_str(&raw)\n        .unwrap_or_else(|_| serde_json::json!({ "prerelease": false, "beta": 0 }));',
    ]],
    expect: '构建失败',
  },
  {
    name: '环境变量覆写被去掉（CI 无法指定 tag）',
    pairs: [['    if let Ok(tag) = std::env::var("VIEWPDF_BUILD_TAG") {', '    if let Ok(tag) = std::env::var("VIEWPDF_BUILD_TAG_DISABLED") {']],
    expect: 'VIEWPDF_BUILD_TAG 压过声明文件',
  },
  {
    name: '空环境变量不再视为未给（tag 变成空串）',
    pairs: [['        let tag = tag.trim().to_string();\n        if !tag.is_empty() {', '        let tag = tag.trim().to_string();\n        if true {']],
    expect: '空环境变量视为未给',
  },
  {
    name: 'prerelease=false 时也去读 beta（正式版被编成 Bata0）',
    pairs: [['    let tag = if prerelease {', '    let tag = if true {']],
    expect: 'tag 固定为 v{Cargo 版本}',
  },
  {
    // 这一条是刻意的设计决定，不是 bug：beta:0 + prerelease:true 必须失败。
    // 如果有人「顺手」把它改成容错，守卫就该红。
    name: 'beta 序号从 1 起改成从 0 起（-Bata0 不是合法预发布标识，semver 工具链会拒）',
    pairs: [['        assert!(\n            beta >= 1,', '        assert!(\n            beta >= 0,']],
    expect: '构建失败',
  },
  {
    name: '声明文件被 gitignore（别人克隆下来就没有它，构建立刻炸）',
    decl: null,
    expect: 'build-info.json 存在',
  },
  {
    // 搬目录时最容易漏的一条：根目录旧副本没删，两处都有时改哪一份生效没人知道
    name: '仓库根残留第二份声明（改了根目录那份却毫无反应）',
    rootCopy: true,
    expect: '仓库根没有残留的第二份声明',
  },
  {
    name: '声明文件只搬到仓库根（build.rs 只看 crate 目录 → 构建立刻炸）',
    moveDeclToRoot: true,
    expect: 'build-info.json 存在',
  },
];

console.log('--- 变异测试：每处接错都必红 ---');

{
  const root = fresh_copy();
  const base = run(root);
  report('基线（未变异）全绿', base.code === 0, base.code === 0 ? '' : base.failed.join(' | '));
  fs.rmSync(root, { recursive: true, force: true });
}

for (const m of MUTATIONS) {
  const root = fresh_copy();
  let thrown = null;
  try {
    if (m.pairs) patch(root, BUILD_RS, m.pairs);
    if (m.decl === null) fs.rmSync(path.join(root, DECL));
    if (m.rootCopy) fs.copyFileSync(path.join(root, DECL), path.join(root, 'build-info.json'));
    if (m.moveDeclToRoot) fs.renameSync(path.join(root, DECL), path.join(root, 'build-info.json'));
  } catch (e) {
    thrown = e.message;
  }
  if (thrown) {
    report(m.name, false, '补丁未落地: ' + thrown);
  } else {
    const r = run(root);
    const caught = r.failed.some((f) => f.includes(m.expect));
    report(m.name, caught, caught ? '' : (r.code === 0
      ? 'harness 仍然全绿 —— 这条守卫抓不到该变异，等于没守'
      : '变红了但没命中预期标签: ' + r.failed.join(' | ')));
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);