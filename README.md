<div align="center">
    <img src="https://github.com/SECTL/ViewPDF/blob/main/src-tauri/icons/Square1024x1024Logo.png" width=15%>
    <h1>ViewPDF</h1>
    <p>基于 <strong>Tauri v2</strong> 构建的桌面演示批注应用，适用于教学、会议、产品展示等多种场景。</p>
    <p>无需 Node.js 构建前端 — 原生 ES Module 直接加载，零 bundler 依赖。</p>
</div>

<p align="center">
    <img src="https://img.shields.io/badge/version-0.20.0-blue.svg" alt="版本">
    <img src="https://img.shields.io/badge/Tauri-2-ffc131.svg" alt="Tauri v2">
    <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="许可证">
</p>

## 功能概览

| 类别 | 功能 |
|------|------|
| 🖼 **图片** | 导入本地图片，支持旋转与删除 |
| 📄 **文档** | 基于 PDF.js 渲染 PDF；通过 PowerShell COM 自动将 Word 文档（支持 Office/WPS/LibreOffice）转换为 PDF；支持系统文件关联直接打开 |
| ✏️ **批注** | 移动、批注、橡皮擦三种模式；支持压感笔锋与贝塞尔曲线平滑；可自定义颜色与粗细 |
| ↩️ **撤销** | 采用 Command 模式实现撤销与重做，上限 50 步，超限自动合并快照以控制内存 |
| 🎨 **主题** | 内置深色与浅色两套主题，支持导入 `.vst` 自定义主题文件，实时切换无需重启 |
| 🌐 **国际化** | 支持简体中文、繁体中文、英文、德语、西班牙语、法语、日语、韩语、俄语共九种界面语言 |
| ⚙️ **设置** | 统一管理画布、画笔、信号源、文件关联、缓存与日志；支持设置导入导出为 JSON 文件 |
| 🔄 **更新** | 自动检查 GitHub Release，支持多镜像源下载，显示下载进度条，支持自动安装 |
| 📸 **截图** | 画布内容合并导出为 PNG；切换信号源时自动保存批注快照 |
| 🧩 **源管理** | 图片与文档两种信号源统一管理，切换时自动保存缩放状态与批注，恢复时还原 |
| 🖥 **渲染** | 双图层分离渲染（图像层 + 批注层）、平铺策略、动态 DPR 适配、四叉树空间索引、自适应帧率调度 |
| 🚀 **其他** | OOBE 首次使用引导、Splashscreen 启动画面、无边框全屏窗口模式 |

## 技术栈

| 层级 | 技术 |
|------|------|
| **前端** | Vanilla HTML5 + CSS3 + JavaScript (ES Module) — 无 bundler、无 Node.js 构建 |
| **后端** | Rust |
| **桌面框架** | Tauri v2 |
| **PDF 渲染** | PDF.js |
| **Word 转换** | PowerShell COM 互操作 (Office/WPS/LibreOffice) |
| **日志** | simplelog |

> 项目无需 `npm` / `package.json`，前端直接以 ES Module 方式加载。

## 安装

从 [Releases](https://github.com/SECTL/ViewPDF/releases) 下载最新安装包（支持 MSI 和 NSIS 安装器），运行即用。

### 系统要求

- **操作系统**：Windows 10 或更高版本、Linux（x86_64）
- **运行时**：WebView2（[下载地址](https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section)）

### 硬件要求

- **摄像头**：用于展台功能（可选）
- **内存**：建议 4GB 以上
- **存储**：约 100MB（含运行时）

### 可选依赖

- **Microsoft Office** / **WPS Office** / **LibreOffice**：用于 Word 文档转换

## 开发

### 环境要求

- **Rust** 稳定版（[安装](https://rustup.rs/)）
- **Tauri CLI**：`cargo install tauri-cli --locked`

### 构建与运行

```bash
# 开发模式
cargo tauri dev

# 生产构建
cargo tauri build
```

CI 自动构建：推送 `v*` 标签触发，手动也可在 Actions 页面触发。

## 开源许可

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE)。

## 致谢

### 核心框架

- [Tauri](https://tauri.app/) — 构建更安全、更轻量的桌面应用
- [Tokio](https://tokio.rs/) — Rust 异步运行时

### 前端库

- [PDF.js](https://mozilla.github.io/pdf.js/) — Mozilla 的 PDF 渲染库
- [mammoth.js](https://github.com/mwilliamson/mammoth.js) — Word 文档转为 HTML
- [html2canvas](https://html2canvas.hertzen.com/) — HTML 元素渲染为 Canvas

### Rust 库

- [image](https://github.com/image-rs/image) — 图像编解码与处理
- [imageproc](https://github.com/image-rs/imageproc) — 图像处理算法
- [serde](https://serde.rs/) — 序列化框架
- [rayon](https://github.com/rayon-rs/rayon) — 数据并行计算
- [chrono](https://github.com/chronotope/chrono) — 日期时间库
- [reqwest](https://github.com/seanmonstar/reqwest) — HTTP 客户端
- [winreg](https://github.com/gentoo90/winreg-rs) — Windows 注册表操作（文件关联）
- [simplelog](https://github.com/dermesser/simplelog) — 日志记录
- [windows-sys](https://github.com/microsoft/windows-rs) — Windows API 绑定（内存清理 FFI）

### Tauri 插件

- [tauri-plugin-opener](https://github.com/tauri-apps/plugins-workspace) — 文件打开
- [tauri-plugin-fs](https://github.com/tauri-apps/plugins-workspace) — 文件系统
- [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) — 对话框
- [tauri-plugin-single-instance](https://github.com/tauri-apps/plugins-workspace) — 单实例

感谢所有开源社区的贡献！
