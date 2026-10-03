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
| `verify/telemetry-heartbeat.mjs` | Stats heartbeat scheduling, **executed** against the real telemetry modules with a fake clock: 4-minute cadence keeps ≥20% margin under the server's 5-minute online window, one interval per launch (serial *and* concurrent `telemetryInit`), in-flight gate, `finally`-released gate, `telemetry_stop` clears both timers, toggle honored at every exit, request bodies match the API contract, version sanitization |
| `verify/telemetry-mutation.mjs` | Mutates each heartbeat/telemetry invariant and asserts `telemetry-heartbeat.mjs` (or `dpr-harness.mjs` for the single-send-choke-point guard) goes red (20 mutations). **Run it after editing the scheduler, the API layer, or either harness** |
| `verify/update-resolve.mjs` | Update resolution, **executed** against the real `update-resolve.js`: semver precedence incl. prerelease, "beta build must not be nagged to install itself", Windows `.exe` beats `.msi` regardless of array order, generic (`os=通用`) packages must not outrank platform-specific ones, `$id`→`package_id` normalization, candidate chain order (mirror → gh-proxy → GitHub), "up to date shows the *current* version's notes". Plus the two that shipped broken once: `build_latest_tag_url` must keep the `repo` slash **literal** (`%2F` → server 404s), and `probe_channel` must keep the two same-status 404s apart — empty channel (has a `channel` field) vs. lookup failure (doesn't) — so a server failure can never again be reported as "已是最新". Both 404 bodies in the fixtures are **verbatim production responses**, not invented. Also **runs the real `checkForUpdate`** (via its `opts.invoke` seam) across all four paths — normal / up-to-date / empty channel / lookup failure — asserting the returned shape and that neither call site destructures it |
| `verify/update-mutation.mjs` | Mutates each update invariant and asserts `update-resolve.mjs` goes red (36 mutations; `ORCHESTRATOR` / `ORCHESTRATOR_CALLER_*` mutations patch `update.js` and the two call sites, the rest patch `update-resolve.js`). **Run it after touching `update-resolve.js`, `update.js`, `oobe.js`'s update step, or `settings.js`'s update panel** |
| `verify/oobe-titlebar.mjs` | OOBE's **standalone switch steps**, **executed**: the switches that each own a step (currently the macOS title bar and toolbar text labels) live in one `SWITCHES` table, and `gatherStepData` / `mergeSettings` / `setupTitleBar` / `setupToolbarText` are extracted from the real `oobe.js` and run against a stub DOM — the `change` listeners are dispatched for real, because a regex over the source can't tell a live listener from the same assignment sitting in `gatherStepData`. Guards the silent-failure modes: key missing from `mergeSettings`, `checked` falling back the **wrong way** when the element is absent, an imported value being overwritten by the default. Also pins each JS default against `lib.rs` `settings_defaults` (and against the `default` recorded in `SWITCHES`), checks all 9 locales carry the label + hint, and checks `STEP` / `STEPS` / `STEP_TPL` / the `renderStepContent` dispatch stay consistent (a missing entry = a blank page; a stale index = a silently wrong page). **Adding a third standalone switch = one row in `SWITCHES`**, both the behaviour and the source guards follow |
| `verify/oobe-titlebar-mutation.mjs` | Mutates each wiring and asserts `oobe-titlebar.mjs` goes red (26 mutations, generated per switch from the `SW` table). **Run it after touching OOBE's step table or settings wiring** |
| `verify/add-update-channel-i18n.mjs` | One-shot writer + checker for locale keys across all 9 locales. **Refuses to silently overwrite an existing key with a different value** — that collision is invisible in the diff (it looks like "a value changed"), and the symptom only surfaces much later as a UI string that makes no sense. Register an intentional override in `OVERRIDE`. `add-oobe-toolbar-text-i18n.mjs` and `add-missing-settings-labels-i18n.mjs` are the same pattern for the two most recent key batches |
| `verify/_strip-mutation-check.mjs` | Self-check for the harness itself: reverts `stripSrc` to the broken version and asserts the URL guards go red. Run it after editing the comment stripper |

⚠️ **`.workbuddy/` is gitignored** — the entire verification suite (including the
pre-existing `dpr-harness` / `perf-tier-*` / `reader-*`) lives only on the machine that
wrote it. `git ls-files .workbuddy/` returns nothing. A fresh clone has **no** regression
suite, and CI cannot run any of it. Decide deliberately whether that is intended; if not,
the fix is a `.gitignore` exception rather than remembering to re-add files.

Static regex guards cannot see control-flow bugs. A real shipped regression — `const overlay` reassigned, throwing `TypeError` on every dialog open — passed **every** regex guard in `reader-rotation.mjs`. When you touch a code path that only manifests at runtime, add a test that *runs* it (`perf-tier-apply.mjs` and `reader-confirm.mjs` are the two examples).

Never `await` a promise in a test without a timeout race: a promise that never settles leaves an empty event loop, and Node exits **0** — the assertion is silently skipped and the test passes. `reader-confirm.mjs` has a `settle()` helper for exactly this.

Invariants they collectively defend (edit the table, not the field list):

- `RENDER_PERF_TIERS` in `document_reader.js` is the **only** param source; `apply_perf_tier` is its **only** runtime sink. Adding a param without consuming it is a silent no-op.
- Cost params must stay `low ≤ balanced ≤ high`. A typo that makes `low` costlier than `balanced` defeats the whole feature.
- Only `init.js` (startup replay) and `main.js` (`settings-changed`) may call `apply_perf_tier`. Calling it in the settings panel too would run the clear-cache + rescan pass twice per change.
- The per-tier hint text has exactly one writer (JS). Don't put `data-i18n` on `#renderPerfTierHint` — `render_page_texts()` would overwrite the tier-specific copy and language switching wouldn't refresh it.
- `_dr_update_move_bound()` reads DOM and is driven by **pinch/wheel (60–120 Hz)** plus `_dr_apply_scale`, *not* by the momentum tick (`_dr_update_canvas_position` only clamps). Its cache is invalidated by `_dr_mb_dom_dirty`, set from `_invalidate_page_positions()` and `_on_reader_geometry_changed()`. A `16ms TTL` "read once per frame" throttle can never hit at ~16.7 ms frames — that was the bug.
- Sidebar geometry is anchored to two single sources of truth: `--app-titlebar-h` (top) and `--dr-toolbar-band` (bottom, measured at runtime because the toolbar is ~63 px with labels and ~54 px without). Both are body-level overlays sharing the bottom-right corner.
- Stats heartbeats belong to the **main window** (`init.js`), never to `oobe.js`: `oobe_submit_complete` calls `app_restart`, so a timer started there dies with the process before it ever fires. This is not theoretical — it is exactly why the console showed near-zero online/peak for months.
- The heartbeat cadence must stay **below** the server's 5-minute online window, not equal to it. `setInterval` drift plus request RTT guarantees the real gap between two received heartbeats exceeds the period; at 1:1 the device drops out of the window every cycle and the peak under-reports. `telemetry-heartbeat.mjs` enforces ≥20% margin.
- `telemetry_post` in `telemetry-api.js` is the **only** send path and the only place the user toggle is checked. Keep the switch check there, not in individual reporters — that is why `reportVersion` didn't need a second copy, and why the dpr-harness guard counts `telemetry_http_post` call sites.
- `_tick_inflight` must be cleared in a `finally`. Clearing it only on the success path converts one failed heartbeat into "no heartbeat ever again", which is indistinguishable from the original bug.

## Updates / distribution

Data source is the SECTL distribution API, **not** GitHub. See `https://sectl.cn/docs?doc=API/分发/软件分发.md`.

- `GET /api/software/latest-tag?repo=SECTL/ViewPDF&channel=stable|prerelease` gives the authoritative tag and whether a prerelease leads, but **carries no changelog and no assets**.
- **`repo`'s `/` must go out literally — never `encodeURIComponent` it.** The server compares the raw string against its configured repo and does *not* decode, so `SECTL%2FViewPDF` misses and returns `404 {"error":"not_found","error_description":"Software project or GitHub repository is not configured"}`. Probed 2026-10-03, A/B 4/4 rounds: `%2F` → 404, literal slash → 200 `latest.tag=v0.3.0`. `build_latest_tag_url` uses `encodeURI` for exactly this reason.
- **That endpoint returns HTTP 404 for two completely different things**, and conflating them reports a server failure to the user as "你已是最新":
  | | body | must be treated as |
  |---|---|---|
  | channel genuinely empty | `error:not_found` + `"No leading prerelease version found…"` + **`channel` and `project` fields present** | business result — `channel_empty`, no red banner |
  | lookup failed | `error:not_found` + `"…repository is not configured"`, **no `channel` / `project`** | **failure — throw**, red banner |
  Distinguish on the **presence of the `channel` field**, not on `error_description` text — the wording is the server's to change, the field structure is not. `probe_channel` is the only place that decides; `checkForUpdate` throws on `error`, sets `channel_empty` on `empty`, and re-throws on any *unrecognised* state rather than letting it fall through to "up to date".
- `GET /api/software/distribution?platformId=…` carries `versions[].changelog` and `packages[]` (installer name/size/os/arch/`$id`). All logic lives in `modules/update/update-resolve.js` (pure, testable); Rust only transports.
- **SECTL identity lives in exactly one place: `src/modules/sectl-client.js`.** Do not re-export it from a feature module — two import paths to one value is how this went wrong before. There are two similar-looking IDs and **the Client ID is the only one a client ever sends**:
  - Platform ID `platform_9c8003bb30f77c70` — the server's canonical id, only echoed back in responses
  - Client ID `6a48ced10013cdd594f8` — **send this**

  Measured behaviour (probed 2026-10-03): `POST /api/stats/online` rejects the Platform ID with `400 invalid_client`; `GET /api/software/distribution?platformId=<Platform ID>` returns **HTTP 200 with three empty arrays**. `/api/stats/version` is the trap — it **accepts either** and silently normalises to the canonical id, so a green version report proves nothing about the online endpoint. Never use it as a probe.
- **`?projectSlug=` and `?projectId=` are silently ignored by `/api/software/distribution`** — both return all 11 projects (probed). `platformId` is the only parameter that actually filters. Don't "improve readability" by switching to them; that disables filtering and leaves correctness to the local slug match.
- `packages[].$id` is the `packageId` the download endpoint wants. `select_package` normalizes it; without that, the mirror candidate silently vanishes from the chain.
- **A package must be resolved client-side, then downloaded by `packageId`.** `download?projectSlug=…&tag=…&os=Windows&arch=x64` returns **409 `ambiguous_package`** because both `viewpdf_…_x64-setup.exe` and `viewpdf_…_x64_en-US.msi` are Windows/x64. Never pick by array order (`assets.find(regex)` got the `.exe` purely by luck).
- Prerelease builds share the **Cargo version** with the stable release (`v0.3.0-Bata2` and `v0.3.0` are both `0.3.0`), so `app_fetch_version` cannot identify the channel. `build.rs` injects `VIEWPDF_BUILD_TAG` from `git describe --exact-match`; use `app_fetch_build_info`, never the bare version, for update decisions.
- The download artifact is **executed** by `update_install_release`, so `url_validate_update_source` is a trust boundary. It checks the initial URL *and* the post-redirect URL — validating only the initial one turns any 302 into a whitelist bypass.
- Semver caveat pinned by a test: alphanumeric prerelease identifiers compare as **strings**, so `-Bata10` sorts *below* `-Bata2`. Use `-beta.N` if the 10th prerelease ever ships.
- **`checkForUpdate` returns the result object itself — there is no `{ result }` wrapper.** Both call sites must read `const result = await checkForUpdate(...)`. Writing `const { result } = await ...` destructures `undefined`, and both UIs open with `if (!result) → 检查更新失败`, so *every* check is reported as failed while nothing throws and the console stays clean. This shipped once: it lives **across** the boundary between the function's return value and the call site, so no amount of testing inside `update-resolve.js` can see it. `checkForUpdate` therefore takes an `opts.invoke` seam (defaulting to `window.__TAURI__`) purely so the real function can be executed in tests — normal / up-to-date / empty-channel / lookup-failure paths are all run, not just regex-matched.
- If you add a scenario to `update-resolve.mjs`, wrap it in `settle()`. A single uncaught throw skips **every later assertion**, and the mutation runner then reports "went red but missed the expected label" — which reads like a broken guard when actually the guard never ran. Same reason mutation patches must stay **syntactically valid**: a malformed patch makes the module fail to import, the harness crashes with zero FAIL lines, and "crashed" is not "guard fired".

## OOBE

- **Step indices live in one table: `STEP` in `oobe.js`.** Never write a bare step number
  elsewhere. Inserting a step silently re-points every `doTransition(7)` that meant "go to
  Complete" — the number is unchanged, the meaning is not, and nothing throws. `STEPS` is
  derived from `STEP`, so the two cannot drift; `renderStepContent` must dispatch every
  entry, `STEP_TPL` must have exactly one template per entry, and `STEPS_WITHOUT_NAV`
  must **not** contain any step the user has to click through. `oobe-titlebar.mjs` checks all of it.
- The standalone switch steps sit **after** Check Update, in table order (`titleBar: 7`,
  `toolbarText: 8`). Completing the update check must therefore land on `STEP.titleBar`, never
  on `STEP.complete` — `STEP.complete` is reachable only from the install-failure retry.
  Skipping one looks like "the new step never appeared".
- **Each standalone switch's missing-element fallback is its own Rust default, and the two
  current ones point opposite ways**: `macosTitleBar` falls back to `true`, `showToolbarText`
  to `false`. There is no single "safe" direction — the invariant is *"fall back to whatever
  `settings_defaults` says"*, which `oobe-titlebar.mjs` checks by reading `lib.rs` rather than
  by trusting a constant written twice. Getting it wrong silently rewrites a preference for
  users who never touched the switch.
- `importConfig` adopts an imported `macosTitleBar` / `showToolbarText`: `mergeSettings` lets
  OOBE-managed keys override the imported config, so without this an imported `false` is
  quietly rewritten to the default with nothing visible happening (same reason
  `renderPerfTier` adopts it). `importConfig` runs Tauri's dialog/fs so the harness can only
  assert this at source level — anchor the regex on the **function body**, otherwise the same
  `typeof settings.X === 'boolean'` written anywhere else satisfies it.
- Every i18n key referenced by a step must exist in **all 9 locales**, not just zh-CN/en-US.
  `format_translate` returns the **key itself** on a miss, so a gap renders the literal string
  `settings.toolbarText` in the UI — it does not blank out and does not log as an error the
  user would notice. `oobe-titlebar.mjs` checks every locale; that check is what caught
  `settings.macosTitleBar` / `settings.toolbarText` missing from 6 locales.

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
