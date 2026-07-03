/**
 * 更新模块 — 版本检查、下载、安装
 */

let _unlistenProgress = null;

export const PLATFORM_PATTERNS = {
  windows: /\.(exe|msi)$/i,
  linux: /\.(deb|AppImage)$/i,
  macos: /\.dmg$/i,
};

export function getPlatformPattern(platform) {
  return PLATFORM_PATTERNS[platform] || /\.(exe|msi|deb|AppImage|dmg)$/i;
}

export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function findAsset(release, platform) {
  if (!release || !release.assets || !release.assets.length) return null;
  const pattern = getPlatformPattern(platform);
  return release.assets.find(a => pattern.test(a.name)) || release.assets[0];
}

export async function checkForUpdate() {
  const { invoke } = window.__TAURI__.core;
  const currentVersion = await invoke('app_fetch_version');
  const result = await invoke('update_fetch_check');
  return { currentVersion, result };
}

export async function startDownload(release, platform, mirrorUrl = '') {
  const { invoke } = window.__TAURI__.core;
  const asset = findAsset(release, platform);
  if (!asset) throw new Error('No matching asset found for platform');
  return await invoke('update_download_file', {
    url: asset.browser_download_url,
    fileName: asset.name,
    mirrorUrl,
    versionTag: release.tag_name,
  });
}

export async function installDownload(filePath) {
  const { invoke } = window.__TAURI__.core;
  await invoke('update_install_release', { filePath });
}

export async function cancelDownload() {
  const { invoke } = window.__TAURI__.core;
  await invoke('update_download_cancel');
}

export async function onProgress(callback) {
  if (_unlistenProgress) _unlistenProgress();
  const { listen } = window.__TAURI__.event;
  _unlistenProgress = await listen('update-download-progress', (event) => {
    callback(event.payload);
  });
}

export function offProgress() {
  if (_unlistenProgress) {
    _unlistenProgress();
    _unlistenProgress = null;
  }
}
