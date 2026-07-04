fn main() {
    println!("cargo:rustc-env=DEP_TAURI_DEV=true");
    tauri_build::build()
}
