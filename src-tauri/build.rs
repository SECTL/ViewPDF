use std::path::PathBuf;

/// 构建身份声明（`src-tauri/build-info.json`）
///
/// ```json
/// { "prerelease": false, "beta": 0 }
/// ```
///
/// `prerelease: false` = 正式版，tag 固定 `v{CARGO_PKG_VERSION}`；
/// `prerelease: true` = 预发布版，`beta` 指明第几个，tag 为
/// `v{CARGO_PKG_VERSION}-Bata{beta}`。
///
/// ## 为什么不再探测 git tag
///
/// 原来靠 `git describe --tags --exact-match`，那要求**必须从打了 tag 的那个
/// 提交构建**。漏了不会报错，只会让 `-Bata2` 悄悄变成正式版 `v0.3.0` —— 于是
/// beta 用户跑的是「正式版」，正式版用户又会被提示「你在 beta 上」，两头都错。
/// 声明式文件把这件事变成一次显式编辑：diff 里看得见、review 得到、不依赖
/// 构建机器上有没有 tag。
///
/// ## 三条刻意的行为
///
/// 1. **环境变量 `VIEWPDF_BUILD_TAG` 仍然优先** —— CI 用它一次性覆盖，不必改
///    仓库里的声明文件。
/// 2. **改这个文件必须触发重新构建** —— `rerun-if-changed` 那行是刚需：少了它，
///    开发期改完 JSON 再 `cargo tauri dev` 会沿用旧产物，而界面上看不出任何异常。
/// 3. **声明错了就让构建失败** —— `prerelease: true` 却把 `beta` 填 0，或 JSON
///    语法错误 / 文件缺失，都直接 panic。这里刻意不做「回退成正式版」：把一个
///    没填好的 beta 声明当成正式版发出去，代价比构建失败大得多。
fn emit_build_tag() {
    // 声明文件就放在 crate 根（src-tauri/build-info.json），与 build.rs 同级。
    // 放在 crate 里而不是仓库根：build.rs 的 CARGO_MANIFEST_DIR 直接就是它，
    // 少一层 parent() 推导，也就不会在有人改了 Cargo.toml 布局时悄悄指错地方。
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR 未设置"));
    let decl_path = manifest_dir.join("build-info.json");

    // 少这一行，改 JSON 不会重新编译 —— 而症状是「改了没反应」，最难查
    println!("cargo:rerun-if-changed={}", decl_path.display());
    println!("cargo:rerun-if-env-changed=VIEWPDF_BUILD_TAG");

    // 1) CI / 临时覆盖优先
    if let Ok(tag) = std::env::var("VIEWPDF_BUILD_TAG") {
        let tag = tag.trim().to_string();
        if !tag.is_empty() {
            println!("cargo:rustc-env=VIEWPDF_BUILD_TAG={}", tag);
            return;
        }
    }

    let version = env!("CARGO_PKG_VERSION");
    let fallback = format!("v{}", version);

    // 2) 声明文件。缺失或语法错误都直接失败，不静默回退 —— 见函数注释第 3 条。
    let raw = std::fs::read_to_string(&decl_path).unwrap_or_else(|e| {
        panic!(
            "读不到构建身份声明 {}：{}\n\
             请在 src-tauri/ 下创建 build-info.json，内容如 {{\"prerelease\": false, \"beta\": 0}}",
            decl_path.display(),
            e
        )
    });

    let json: serde_json::Value = serde_json::from_str(&raw).unwrap_or_else(|e| {
        panic!(
            "build-info.json 解析失败：{}\n\
             合法内容如 {{\"prerelease\": false, \"beta\": 0}}",
            e
        )
    });

    let prerelease = json
        .get("prerelease")
        .and_then(|v| v.as_bool())
        .unwrap_or_else(|| {
            panic!(
                "build-info.json 的 `prerelease` 必须是布尔值（true = 预发布版，false = 正式版）"
            )
        });

    let tag = if prerelease {
        let beta = json
            .get("beta")
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| {
                panic!(
                    "build-info.json 声明了 prerelease: true，就必须给出 `beta`（第几个预发布）"
                )
            });
        assert!(
            beta >= 1,
            "build-info.json 的 `beta` 是第几个预发布，必须 >= 1；\
             想发正式版请把 prerelease 改成 false"
        );
        format!("v{}-Bata{}", version, beta)
    } else {
        fallback
    };

    println!("cargo:rustc-env=VIEWPDF_BUILD_TAG={}", tag);
}

fn main() {
    println!("cargo:rustc-env=DEP_TAURI_DEV=true");
    emit_build_tag();
    tauri_build::build()
}