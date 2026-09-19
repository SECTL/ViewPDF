#!/usr/bin/env bash
#
# patch-appimage-apprun.sh — 让 AppImage 优先使用宿主系统的 WebKitGTK。
#
# 背景（Issue #19）：
#   CI（ubuntu-latest）构建的 AppImage 捆绑了 Ubuntu 版 libwebkit2gtk-4.1，
#   但不捆绑 Mesa/libEGL。在 WebKitGTK/Mesa 较新的发行版（如 Fedora 40+，
#   Mesa ≥ 26.1）上，捆绑的 WebKitGTK 调用 eglGetPlatformDisplay() 的方式
#   会被宿主新 Mesa 拒绝（EGL_BAD_PARAMETER），且该失败发生在任何 WebKit
#   渲染 flag 生效之前 —— 因此 WEBKIT_DISABLE_DMABUF_RENDERER 等环境变量
#   全部无效。
#   修复策略（VoiceStudio v0.4.1 验证过的做法）：
#     - 默认优先宿主系统 WebKitGTK（与 .deb 包行为一致）；
#     - 宿主缺失 WebKitGTK 时，回退到捆绑副本（移入 usr/lib/webkit-bundled）；
#     - 设 VIEWPDF_FORCE_BUNDLED_WEBKIT=1 可强制使用捆绑副本。
#
# 实现说明：tauri v2 打包的 AppImage 内置的是 AppImageKit 的 AppRun **二进制**
# （tauri-bundler 下载 AppRun-x86_64），行为仅为：设 APPDIR/ARGV0/APPIMAGE、
# 把 $APPDIR/usr/lib 前置进 LD_LIBRARY_PATH 与 XDG_DATA_DIRS、按需设
# GIO_MODULE_DIR、exec usr/bin/<Exec>。本脚本用等价的 bash AppRun **整体替换**
# 该二进制，并叠加 WebKitGTK 选择逻辑。.deb/.rpm/Windows 产物不受影响。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUNDLE_DIR="$REPO_ROOT/src-tauri/target/release/bundle"

APPIMAGE="$(find "$BUNDLE_DIR" -maxdepth 3 -type f -name '*.AppImage' | head -n 1)"
if [ -z "$APPIMAGE" ]; then
  echo "ERROR: bundle 目录下未找到 AppImage: $BUNDLE_DIR" >&2
  exit 1
fi
echo "处理: $APPIMAGE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1. 解包 ──────────────────────────────────────────────────────
cd "$WORK"
"$APPIMAGE" --appimage-extract >/dev/null
APPDIR="$WORK/squashfs-root"

# ── 2. 把捆绑的 WebKitGTK 移出默认链接路径 ────────────────────────
BUNDLED_SUBDIR="usr/lib/webkit-bundled"
mkdir -p "$APPDIR/$BUNDLED_SUBDIR"
MOVED=0
for so in "$APPDIR"/usr/lib/libwebkit2gtk-4.1.so.* \
          "$APPDIR"/usr/lib/libwebkit2gtk-4.1.so \
          "$APPDIR"/usr/lib/libjavascriptcoregtk-4.1.so.* \
          "$APPDIR"/usr/lib/libjavascriptcoregtk-4.1.so; do
  if [ -e "$so" ]; then
    mv "$so" "$APPDIR/$BUNDLED_SUBDIR/"
    MOVED=1
  fi
done
if [ "$MOVED" -eq 0 ]; then
  echo "WARN: AppImage 内未找到捆绑的 WebKitGTK，跳过补丁（打包方式可能已变化）" >&2
  exit 0
fi

# ── 3. 确定可执行文件名（desktop 的 Exec 字段，兜底 usr/bin） ─────
EXEC_NAME="$(grep -h '^Exec=' "$APPDIR"/*.desktop 2>/dev/null | head -n 1 | cut -d= -f2 | awk '{print $1}')"
if [ -z "$EXEC_NAME" ]; then
  EXEC_NAME="$(find "$APPDIR/usr/bin" -maxdepth 1 -type f -perm -u+x | head -n 1 | xargs -r basename)"
fi
if [ -z "$EXEC_NAME" ]; then
  echo "ERROR: 无法确定应用可执行名（desktop 与 usr/bin 均未找到）" >&2
  exit 1
fi
if [ ! -x "$APPDIR/usr/bin/$EXEC_NAME" ]; then
  echo "ERROR: $APPDIR/usr/bin/$EXEC_NAME 不存在或不可执行" >&2
  exit 1
fi
echo "可执行文件: usr/bin/$EXEC_NAME"

# ── 4. 生成新 AppRun（替换二进制） ────────────────────────────────
cat > "$APPDIR/AppRun.new" <<'APPRUN_EOF'
#!/bin/bash
# ViewPDF AppRun — 由 src-tauri/scripts/patch-appimage-apprun.sh 生成，
# 取代 AppImageKit 的 AppRun 二进制（行为等价），并叠加
# 「优先宿主系统 WebKitGTK」逻辑（Issue #19）。
APPDIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
export APPDIR
export ARGV0="$0"
export APPIMAGE="${APPIMAGE:-$0}"

# —— 与 AppImageKit AppRun 二进制等价的环境变量 ——
export LD_LIBRARY_PATH="$APPDIR/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export XDG_DATA_DIRS="$APPDIR/usr/share${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
export XDG_DATA_DIRS="$APPDIR/share${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
if [ -d "$APPDIR/usr/lib/gio/modules" ]; then
  export GIO_MODULE_DIR="$APPDIR/usr/lib/gio/modules"
fi
if [ -d "$APPDIR/usr/lib/x86_64-linux-gnu/gio/modules" ]; then
  export GIO_MODULE_DIR="$APPDIR/usr/lib/x86_64-linux-gnu/gio/modules"
fi

# —— ViewPDF: 优先宿主系统 WebKitGTK ——
# 构建期已把捆绑的 libwebkit2gtk-4.1 移出 usr/lib（见补丁脚本）。
# 默认：宿主有 WebKitGTK 时走系统库（与 .deb 行为一致）；缺失时才把
# 捆绑副本加回链接路径。VIEWPDF_FORCE_BUNDLED_WEBKIT=1 跳过探测、
# 无条件使用捆绑副本。
if [ -n "${VIEWPDF_FORCE_BUNDLED_WEBKIT:-}" ]; then
  export LD_LIBRARY_PATH="$APPDIR/usr/lib/webkit-bundled${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
  HAVE_SYSTEM_WEBKIT=0
  if command -v ldconfig >/dev/null 2>&1; then
    if ldconfig -p 2>/dev/null | grep -q "libwebkit2gtk-4.1.so"; then
      HAVE_SYSTEM_WEBKIT=1
    fi
  fi
  if [ "$HAVE_SYSTEM_WEBKIT" -eq 0 ]; then
    for d in /usr/lib64 /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu /lib64 /usr/lib; do
      if [ -e "$d/libwebkit2gtk-4.1.so.0" ]; then
        HAVE_SYSTEM_WEBKIT=1
        break
      fi
    done
  fi
  if [ "$HAVE_SYSTEM_WEBKIT" -eq 0 ] && [ -d "$APPDIR/usr/lib/webkit-bundled" ]; then
    export LD_LIBRARY_PATH="$APPDIR/usr/lib/webkit-bundled${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  fi
fi

exec "$APPDIR/usr/bin/__EXEC_NAME__" "$@"
APPRUN_EOF

sed -i "s/__EXEC_NAME__/${EXEC_NAME}/" "$APPDIR/AppRun.new"
chmod +x "$APPDIR/AppRun.new"
mv "$APPDIR/AppRun.new" "$APPDIR/AppRun"

# ── 5. 重新打包 ──────────────────────────────────────────────────
# appimagetool 的 --appimage-extract-and-run 会在 cwd 释放 squashfs-root，
# 必须切到独立目录避免与上面解包的目录冲突。
TOOL_DIR="$WORK/tool"
mkdir -p "$TOOL_DIR"
curl -fsSL -o "$TOOL_DIR/appimagetool.AppImage" \
  https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x "$TOOL_DIR/appimagetool.AppImage"

(
  cd "$TOOL_DIR"
  ./appimagetool.AppImage --appimage-extract-and-run "$APPDIR" "$APPIMAGE.new"
)
mv "$APPIMAGE.new" "$APPIMAGE"

echo "OK: 已重打包（优先宿主 WebKitGTK）: $APPIMAGE"
