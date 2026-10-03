use std::process::Command;

/// 注入构建时的 release tag。
///
/// 为什么需要它：仓库里预发布 tag（`v0.3.0-Bata1` / `v0.3.0-Bata2`）与正式 tag
///（`v0.3.0`）的 `Cargo.toml` 版本号**完全相同**（都是 `0.3.0`）。所以
/// `CARGO_PKG_VERSION` 根本区分不出「我跑的是 Bata2 还是正式版」，而更新检查
/// 必须知道自己在哪个通道上，否则运行 Bata2 的用户会永远看到
/// 「有新版本 0.3.0-Bata2」——那就是他自己正在跑的版本。
///
/// 优先读环境变量（CI 可显式指定），否则取 `git describe --exact-match`。
/// 取不到（无 git / 非 tag 提交 / 源码包构建）时回退 `v{CARGO_PKG_VERSION}`，
/// 即按正式版处理 —— 这是保守方向：宁可少提示一次预发布，不要对已是最新版的
/// 用户反复提示。
fn emit_build_tag() {
    if let Ok(tag) = std::env::var("VIEWPDF_BUILD_TAG") {
        let tag = tag.trim().to_string();
        if !tag.is_empty() {
            println!("cargo:rustc-env=VIEWPDF_BUILD_TAG={}", tag);
            return;
        }
    }

    let fallback = format!("v{}", env!("CARGO_PKG_VERSION"));
    let detected = Command::new("git")
        .args(["describe", "--tags", "--exact-match"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);

    println!("cargo:rustc-env=VIEWPDF_BUILD_TAG={}", detected);
}

fn main() {
    println!("cargo:rustc-env=DEP_TAURI_DEV=true");
    println!("cargo:rerun-if-env-changed=VIEWPDF_BUILD_TAG");
    emit_build_tag();
    tauri_build::build()
}
