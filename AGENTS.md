# ViewPDF — Agent Instructions

## Build & Run

**Build (no Node.js needed):**
```
cargo tauri build
```

**Dev:**
```
cargo tauri dev
```
Frontend lives in `src/` and is served directly (no bundler). No `package.json`.



**CI** triggers on `v*` tags and manual dispatch. Requires `cargo install tauri-cli --locked` first.

## Rust Backend (`src-tauri/`)

- Lib crate is `viewstage_lib` (`_lib` suffix avoids Cargo issue #8519 on Windows, see `Cargo.toml:10-14`).
- `main.rs` calls `viewstage_lib::run()`.
- All Tauri commands registered in `lib.rs:2928-2971` — check there before adding new ones.
- Logging: `simplelog` writes to `%APPDATA%/SECTL/ViewPDF/log/viewpdf_{date}.log`.
- Config: `%APPDATA%/SECTL/ViewPDF/config.json`, with a config version migration system (`migrate_config`/`get_migrations`).
- Image save path: `~/Pictures/ViewPDF/`.

## Frontend (`src/`)

- **Entrypoint**: `src/index.html` loads `JS/pdf.min.js`, `JS/pdf.worker.min.js`, `i18n.js`, then module scripts `themes/theme.js`, `main.js`, `init.js`.
- **No bundler** — ES modules loaded directly; use `type="module"` for imports.
- Init flow: `init.js` DOMContentLoaded → init i18n → initDOM → initCanvas → bindAllEvents → load settings → openCamera.
- Architecture: image layer (`<img>`) + annotation layer (`<canvas>`) in a `canvas-wrapper`.
- `tauri.conf.json` enables `"withGlobalTauri": true` — access via `window.__TAURI__`.
- State management: global `state` object + global `dom` cache on `window`.
- Tauri v2 IPC: `window.__TAURI__.core.invoke(...)`.
- CSP currently allows `'unsafe-inline'` and `'unsafe-eval'`.

## Windows

- `oobe.html` — first-run setup window (960×540, no decorations).
- Settings — lazy-loaded in-app panel `#settingsPanel` (markup exported as a template string from `src/modules/settings/settings-panel.js` + styles `src/modules/settings/settings.css`; injected on first open by `settings_ensure_dom()` in `main.js`). Logic lives in `src/modules/settings/settings.js`, dynamically imported once by `main_show_settings_window()`; cross-window sync via `settings-changed` event.
- `doc-scan/index.html` — document scanning sub-app (fullscreen, undecorated).

## i18n

Locale files in `src/locales/{zh-CN,zh-TW,en-US}.json`. Setting stored in `config.json` under `language` key. i18n.init() called in init.js before anything else.

## Tests

No test framework / bundler / `package.json`. Verification is:

1. **Syntax**: `for f in $(git diff --name-only -- '*.js'); do node --check "$f"; done`
2. **Logic + architecture invariants**: `.workbuddy/verify/dpr-harness.mjs`
   ```
   node .workbuddy/verify/dpr-harness.mjs   # exits non-zero on failure
   ```
   Stubs `window`/`document`/`performance` in a `node:vm` sandbox, then loads the **real**
   `resolution-controller.js` + `overlay-manager.js` + `batch-draw.js` and runs assertions.
   Its tail section scans `src/` (comments stripped) and asserts single-source invariants:
   `devicePixelRatio` only in `resolution-controller.js`, `DRAW_CONFIG.dpr =` only there,
   `_transform* =` only in `overlay-manager.js`, no retired overlay APIs left behind.
   **When you change rendering/DPR/overlay code, extend this file rather than re-deriving
   the audit by hand.**

### Render perf tiers (`settings.renderPerfTier`)

Seven extra scripts, all `node <file>`, all exit non-zero on failure:

| Script | What it proves |
|---|---|
| `verify/perf-tier-apply.mjs` | Executes the real `apply_perf_tier` against a mock reader: all 13 params land on the right instance fields, invalid tiers fall back to `balanced`, canvas pool is trimmed, render-host throttle is released, no visibility rescan while closed |
| `verify/perf-tier-scoring.mjs` | OOBE `_autoPerfTier()` against fixed hardware profiles — incl. the 5th-gen i5 target and "WMI returned nothing" (must stay `balanced`, never silently `low`) |
| `verify/reader-momentum.mjs` | Inertial fling: per-frame cost is bounded, bounds are **not** recomputed mid-fling (DOM reads = 0), prerender pump is stopped on fling start, visibility is refreshed but rate-limited to ~33 ms, the closing pass doesn't scan twice |
| `verify/reader-rotation.mjs` | Page rotation: all three render paths (worker / main-thread / thumbnail) pass the same `rotation`, rotation invalidates the render guards, annotations + undo stack + coord base are cleared, rotation rides along with the tab view and persists |
| `verify/reader-confirm.mjs` | The reader's confirm dialog **executed** against a mock DOM: all exits settle, `done` is idempotent, re-opening settles the previous promise, no `keydown` leak |
| `verify/oobe-skip-check.mjs` | All 9 locales carry `oobe.updateSkipCheck`, and it stays **distinct** from `updateLater` — the two mean different things ("abandon the check" vs "skip this update"), so reusing one key silently merges them and no error surfaces |
| `verify/perf-tier-mutation.mjs` | Mutates each invariant and asserts the suite goes red (68 mutations). **Run it after editing any of the above or the tier table** — a guard that can't fail is worthless |

Static regex guards cannot see control-flow bugs. A real shipped regression — `const overlay` reassigned, throwing `TypeError` on every dialog open — passed **every** regex guard in `reader-rotation.mjs`. When you touch a code path that only manifests at runtime, add a test that *runs* it (`perf-tier-apply.mjs` and `reader-confirm.mjs` are the two examples).

Never `await` a promise in a test without a timeout race: a promise that never settles leaves an empty event loop, and Node exits **0** — the assertion is silently skipped and the test passes. `reader-confirm.mjs` has a `settle()` helper for exactly this.

Invariants they collectively defend (edit the table, not the field list):

- `RENDER_PERF_TIERS` in `document_reader.js` is the **only** param source; `apply_perf_tier` is its **only** runtime sink. Adding a param without consuming it is a silent no-op.
- Cost params must stay `low ≤ balanced ≤ high`. A typo that makes `low` costlier than `balanced` defeats the whole feature.
- Only `init.js` (startup replay) and `main.js` (`settings-changed`) may call `apply_perf_tier`. Calling it in the settings panel too would run the clear-cache + rescan pass twice per change.
- The per-tier hint text has exactly one writer (JS). Don't put `data-i18n` on `#renderPerfTierHint` — `render_page_texts()` would overwrite the tier-specific copy and language switching wouldn't refresh it.
- `_dr_update_move_bound()` reads DOM and is driven by **pinch/wheel (60–120 Hz)** plus `_dr_apply_scale`, *not* by the momentum tick (`_dr_update_canvas_position` only clamps). Its cache is invalidated by `_dr_mb_dom_dirty`, set from `_invalidate_page_positions()` and `_on_reader_geometry_changed()`. A `16ms TTL` "read once per frame" throttle can never hit at ~16.7 ms frames — that was the bug.
- Sidebar geometry is anchored to two single sources of truth: `--app-titlebar-h` (top) and `--dr-toolbar-band` (bottom, measured at runtime because the toolbar is ~63 px with labels and ~54 px without). Both are body-level overlays sharing the bottom-right corner.

Also note: grep the whole repo **must** be scoped to `src/` — `src-tauri/` has ~25k files
and will time out.

## Key Quirks

- Office document conversion uses PowerShell COM interop (Word/WPS/LibreOffice) — **Windows only**.
- `tauri.conf.json:bundle.targets` is `"all"` — produces both MSI and NSIS installers.
- NSIS installer hooks at `installer-hooks.nsh` — runs `ViewPDF.exe --uninstall-cleanup` on uninstall.
- `model/` and `cache/` dirs are gitignored; ONNX model files go under `%APPDATA%/SECTL/ViewPDF/models/`.
- `gen/` under `src-tauri/` is generated by Tauri build (schema files).



## Uninstall Cleanup

- `ViewPDF.exe --uninstall-cleanup` (or `--cleanup`) runs cleanup and exits without Tauri init.
- Called automatically via NSIS uninstall hook (`installer-hooks.nsh` → `NSIS_HOOK_PREUNINSTALL`).
- Cleans up: file association registry entries (ProgIDs, OpenWithProgids, UserChoice for .pdf/.docx/.doc) + deletes `ViewPDF_MemClean` scheduled task.
- Implementation in `lib.rs:3540-3558` (`uninstall_cleanup_perform`).
