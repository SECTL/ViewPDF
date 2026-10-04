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
| `verify/reader-offpage-pan.mjs` | Panning from the **grey margin around the page**, **executed**: the `inputDown` / `inputMove` handlers and `_dr_begin_pan` are cut out of the real source and run against a mock. The fix is one control-flow line (`if (!target) return;`), which no regex can judge — and it only shows up at runtime (drag on the margin and nothing happens). Covers: margin pans in **all three** modes, margin does *not* switch page, in-page behaviour unchanged per mode, the anchor math, gesture-velocity reset, and that the margin never starts a stroke |
| `verify/reader-offpage-pan-mutation.mjs` | Mutates each invariant and asserts `reader-offpage-pan.mjs` goes red (20 mutations). **The two riskiest are scope-bound**: `dr_start_drag_x = …` and `_dr_gesture_vy = 0` also appear in the pinch-recovery path, so an unscoped `replace` mutates the *wrong* copy and the assertions still pass |
| `verify/move-cursor-icon.mjs` | The optional Windows-cursor icon for the **Move** tool, **executed**: `theme_fetch_icon_path` / `theme_set_user_move_cursor_icon` / `theme_fetch_move_cursor_icon` are cut out of the real `theme.js` and run against a mock theme package. Covers the redirect (only `move`, exact match, idempotent), value normalisation in **both** setter and getter, the setter actually reloading already-inserted `<img>`s, both built-in themes shipping an identical `move-cursor.svg`, and the full wiring (panel → save → apply → startup → Rust default → 9 locales) |
| `verify/move-cursor-icon-mutation.mjs` | Mutates each invariant and asserts `move-cursor-icon.mjs` goes red (21 mutations). Several exist because the first draft of the guards was **tautological** and would have shipped green: a missing `setMoveCursor(true)` made the "other icons unaffected" group vacuous, and asserting the setter *through* the getter's `=== true` hid a setter that stored values unnormalised. Assert the **stored** value, not the getter's reading |
| `verify/fullscreen-button.mjs` | The reader toolbar's **fullscreen** button + the `showFullscreenButton` settings switch, **executed**: `_toggle_fullscreen` / `_set_fullscreen_btn_visible` / `_apply_fullscreen_state` / `_setup_fullscreen_state_sync` / `_update_fullscreen_btn_visibility` are cut out of `document_reader.js` and `main_toggle_fullscreen` / `main_fetch_fullscreen` out of `main.js`, then run against mocks. Covers the four things static guards cannot see: the icon must be driven by the helper's **returned** state (a rejected `setFullscreen` otherwise leaves it claiming fullscreen, and the user can then never get out), the **generation token** that drops stale `isFullscreen()` IPC replies, the `show !== false` default direction (must stay same-sense as the Rust default, or every pre-upgrade config hides the button), and the i18n keys the code actually references existing in all 9 locales (scanned out of the extracted body, not hand-copied) |
| `verify/fullscreen-button-mutation.mjs` | Mutates each invariant and asserts `fullscreen-button.mjs` goes red (49 mutations). Two exist because the first draft had **real holes**: the mock's `classList` lacked `remove`, so a mutation swapping `toggle` for `remove` crashed the harness instead of tripping a guard; and the toolbar markup carried an **HTML comment inside a template literal** naming `theme_load_icons()` — `stripComments` only removes `/* */` and `//`, so `includes('theme_load_icons')` matched the comment and the "did `_create_toolbar` fill the icons" guard stayed green with the call deleted. **HTML comments inside template literals are not stripped** — keep implementation identifiers out of them, or put them in a `/* */` comment |
| `verify/mount-gate.mjs` | The continuous-motion DOM mount gate, **executed**: `_mount_allowed_offscreen` and `_dr_mark_render_gesture` are cut out of the real source and run against a mock. Constants are **parsed from the source**, not re-declared locally — a local copy means "someone changed the idle window to 2000ms" passes, because the behaviour assertions were only verifying the harness. Also pins both mount paths (`_prerender_page` **and** the pump's own premount loop), the tail exemptions, and that `_prerender_for_navigation` stays ungated |
| `verify/mount-gate-mutation.mjs` | Mutates each invariant and asserts `mount-gate.mjs` goes red (12 mutations), including the two real bugs from the first draft: the pump's premount loop ungated (a **no-op exactly while scrolling**) and the gate placed after the mount. Both initially passed — the surrounding explanatory comments *name the identifiers*, so `includes()` matched the comment text. Hence `stripComments` before every source-text assertion |
| `verify/stroke-width-scale.mjs` | Stroke width vs. zoom, **executed**: `_start_stroke` / `_save_stroke_point` are cut out of the real source and run against a mock reader. The load-bearing assertion is the **aspect ratio** (width ÷ length) coming out identical at scale 1/2/4/0.5/3, with a counter-proof that leaving the width unfolded makes it scale linearly. Also pins `eraserSizeRaw` staying unfolded (so the renderer's `eraserSizeRaw / scale` fallback reconstructs the same value) and the eraser hint (`cached_draw_line_width * dr_scale`) still equalling the real erase diameter |
| `verify/stroke-width-scale-mutation.mjs` | Mutates each invariant and asserts `stroke-width-scale.mjs` goes red (13 mutations). Two exist because the first draft had **real coverage holes**: the zoom list omitted 4, and nothing touched the eraser branch of `_save_stroke_point` — so "that branch unfolded" was undetectable until the mutation runner named it |
| `verify/oobe-skip-check.mjs` | All 9 locales carry `oobe.updateSkipCheck`, and it stays **distinct** from `updateLater` — the two mean different things ("abandon the check" vs "skip this update"), so reusing one key silently merges them and no error surfaces |
| `verify/perf-tier-mutation.mjs` | Mutates each invariant and asserts the suite goes red (68 mutations). **Run it after editing any of the above or the tier table** — a guard that can't fail is worthless |
| `verify/telemetry-heartbeat.mjs` | Stats heartbeat scheduling, **executed** against the real telemetry modules with a fake clock: 4-minute cadence keeps ≥20% margin under the server's 5-minute online window, one interval per launch (serial *and* concurrent `telemetryInit`), in-flight gate, `finally`-released gate, `telemetry_stop` clears both timers, toggle honored at every exit, request bodies match the API contract, version sanitization |
| `verify/telemetry-mutation.mjs` | Mutates each heartbeat/telemetry invariant and asserts `telemetry-heartbeat.mjs` (or `dpr-harness.mjs` for the single-send-choke-point guard) goes red (20 mutations). **Run it after editing the scheduler, the API layer, or either harness** |
| `verify/update-resolve.mjs` | Update resolution, **executed** against the real `update-resolve.js`: semver precedence incl. prerelease, "beta build must not be nagged to install itself", Windows `.exe` beats `.msi` regardless of array order, generic (`os=通用`) packages must not outrank platform-specific ones, `$id`→`package_id` normalization, candidate chain order (mirror → gh-proxy → GitHub), "up to date shows the *current* version's notes". Plus the two that shipped broken once: `build_latest_tag_url` must keep the `repo` slash **literal** (`%2F` → server 404s), and `probe_channel` must keep the two same-status 404s apart — empty channel (has a `channel` field) vs. lookup failure (doesn't) — so a server failure can never again be reported as "已是最新". Both 404 bodies in the fixtures are **verbatim production responses**, not invented. Also **runs the real `checkForUpdate`** (via its `opts.invoke` seam) across all four paths — normal / up-to-date / empty channel / lookup failure — asserting the returned shape and that neither call site destructures it |
| `verify/update-mutation.mjs` | Mutates each update invariant and asserts `update-resolve.mjs` goes red (36 mutations; `ORCHESTRATOR` / `ORCHESTRATOR_CALLER_*` mutations patch `update.js` and the two call sites, the rest patch `update-resolve.js`). **Run it after touching `update-resolve.js`, `update.js`, `oobe.js`'s update step, or `settings.js`'s update panel** |
| `verify/oobe-titlebar.mjs` | OOBE's **standalone switch steps**, **executed**: the switches that each own a step (currently the macOS title bar and toolbar text labels) live in one `SWITCHES` table, and `gatherStepData` / `mergeSettings` / `setupTitleBar` / `setupToolbarText` are extracted from the real `oobe.js` and run against a stub DOM — the `change` listeners are dispatched for real, because a regex over the source can't tell a live listener from the same assignment sitting in `gatherStepData`. Guards the silent-failure modes: key missing from `mergeSettings`, `checked` falling back the **wrong way** when the element is absent, an imported value being overwritten by the default. Also pins each JS default against `lib.rs` `settings_defaults` (and against the `default` recorded in `SWITCHES`), checks all 9 locales carry the label + hint, and checks `STEP` / `STEPS` / `STEP_TPL` / the `renderStepContent` dispatch stay consistent (a missing entry = a blank page; a stale index = a silently wrong page). **Adding a third standalone switch = one row in `SWITCHES`**, both the behaviour and the source guards follow |
| `verify/oobe-titlebar-mutation.mjs` | Mutates each wiring and asserts `oobe-titlebar.mjs` goes red (26 mutations, generated per switch from the `SW` table). **Run it after touching OOBE's step table or settings wiring** |
| `verify/build-identity.mjs` | Build-channel declaration, **by compiling the real `build.rs`**: copies it into a throwaway crate, rewrites `build-info.json` per scenario, runs `cargo build`, and reads the actual emitted `VIEWPDF_BUILD_TAG` out of the build-script output. Covers stable / beta 1,2,3,12, the four declaration errors (beta 0, missing `prerelease`, non-boolean, malformed JSON, absent file), `VIEWPDF_BUILD_TAG` override + trim, and — read from the artifact, not the source — that `rerun-if-changed` really points at the declaration file. **It deliberately does not re-implement the logic**: a copy is always green, so it would prove nothing |
| `verify/build-identity-mutation.mjs` | Mutates each declaration invariant and asserts `build-identity.mjs` goes red (14 mutations). Every failure mode here is **silent**: a bad declaration ships a beta as stable, or `beta:0`/`missing field`/`missing file` quietly fall back to `0.3.0`. The two riskiest mutations are "drop the `rerun-if-changed` line" and "don't panic on a bad declaration" |
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
- **The grey margin around the page pans the document in every tool mode, not just `move`.** The default mode is `comment` (`draw_mode` initial value), so gating it on `move` leaves the default state unfixable. It must also *not* switch page or start a stroke — the batch/eraser branches run **only** when a page was hit, and the "stroke started in-page, dragged off-page" case still goes through `inputMove`'s out-of-bounds auto-commit, untouched.
- **Icon swaps go through `theme_fetch_icon_path`, never through `data-icon` attributes.** `drBtnMove` and `bbBtnMove` are two independently created DOM nodes and the blackboard toolbar is lazy-loaded, so rewriting the attribute in either place misses the other — and misses icons that don't exist yet. The redirect there (`move` → `move-cursor`) is exact-match and must stay idempotent: a `startsWith('move')` check plus a concatenated output turns `move-cursor` into `move-cursor-cursor`, which renders blank **only while the toggle is on**. `theme_set_user_move_cursor_icon` must call `theme_load_icons()` — refreshing existing `<img>`s is the only thing that makes the toggle take effect without a restart, and the next load may never come.
- **DOM virtualisation is gated on page count, and the gate has to be that one predicate.** `_dom_virtualize()` used to read `window.state.domVirtualize`, which had **zero writers** — so it was permanently true and every `!this._dom_virtualize()` branch was dead code. It now also requires `> DOM_VIRTUALIZE_MIN_PAGES` (100). Two things that silently produce a blank document if undone: `_build_page_dom`'s `K = 2` first-screen window is only valid *while virtualising* (a non-virtualised document must build every page, or the rest stay at `page_element = null` **and** get skipped by the visibility scan); and `position: absolute` is set in `_ensure_page_element`, not `_spawn_page_element`, so flex flow only works because the former is never reached.
- **Mount window is ±50 pages, and ±50 is deliberately not a tier parameter.** `_wrapper_keep_distance` is 50 in all three `RENDER_PERF_TIERS` (was 3/6/8). It counts *empty wrappers*; render cost is governed by `raster_max_dev_w` / `*_keep_distance` / cache bytes. Splitting it across tiers means low-end machines re-experience the same stutter during scrolls — the exact thing the wide window fixes.
- **`_in_mount_window` exists because a symmetric window empties the document end.** A ±N window is `active ± N` and `active` can at most reach `total - 1`, so near the tail the window can no longer cover what the user is looking at — the closer to the end, the emptier it gets, exactly where content matters most. Within `MOUNT_TAIL_KEEP_PAGES` of the end the tail is included whole.
- **The continuous-motion mount gate lives in `_dr_mark_render_gesture` and gates *offscreen* pages only.** Two things are easy to mistake here. First, the **urgent prerender pump** has its own DOM premount loop (`_dr_prerender_pump_tick`) *and* dispatches `_render_pdf_page_direct` during gestures — neither goes through `_prerender_page`, so a gate placed only there is a **no-op exactly while scrolling**, which is the only case it exists for. Second, visible pages must never be gated (they have nowhere to draw otherwise), and `_prerender_for_navigation` must stay ungated: page turns are single-frame impulses that mount their target neighbourhood by direct `_ensure_page_element` call, and gating them shows up as a blank page right after a page turn.
- **Renew the mount window in `_dr_mark_render_gesture`, never per pan input source.** Impulse operations (page turns, jumps) go through `_dr_sync_transform(true)` and skip that method entirely, so per-input timestamps make a page turn look like "still sliding". `MOUNT_IDLE_AFTER_MS` (100) is deliberately separate from the render-pause window (120): they answer different questions, and moving either one drags a different subsystem along.
- **Stroke width is folded into document coordinates at authoring time, and so is `stroke.scale`.** Points are already converted with `dr_cached_inv_scale` in `inputMove`, so the width must use the *same* factor — otherwise the same 100 px swipe renders as 100×5 at scale 1 but 100×10 at scale 2. Three places independently confirm this is the intended design: the `stroke-renderer.js` header ("线宽在书写时已按当时的缩放折算进 `stroke.lineWidth`，渲染侧不需要再乘缩放"), its `eraserSizeRaw / stroke.scale` fallback, and `drawing-engine.js` (the blackboard) which has always written `* inv_scale`. The reader was the only one of the three missing it. Fold `lineWidth`, `eraserSize`, `current_line_width`, `last_line_width` **and** both `cached_draw_line_width` resets in `_save_stroke_point` — the reset runs per point, so leaving it unfolded makes the line jump at lift-off. Leave `eraserSizeRaw` unfolded: it is the pre-fold original that the renderer divides back out.
- **Strip comments before any source-text assertion.** The explanatory comments here are unusually long, and they *name the identifiers they explain* — a comment saying "`_mount_allowed_offscreen` 的门控必须在这里也接一道" makes `includes('_mount_allowed_offscreen')` pass on the comment, and makes `indexOf` measure comment-vs-code ordering. Both "delete the gate" and "move the gate after the mount" mutations then pass silently while the report reads green.
- **Never `git checkout <commit>` / `git checkout -- .` with uncommitted work.** Both discard it silently — the lost edit is not in `git reflog` and not recoverable. This cost a full round of `AGENTS.md` + `CHANGELOG.md` edits once already. To verify that intermediate commits stand on their own, check them out in a **separate worktree** (`git worktree add <tmp> <sha>`), or copy the files out first.
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
- Prerelease builds share the **Cargo version** with the stable release (`v0.3.0-Bata2` and `v0.3.0` are both `0.3.0`), so `app_fetch_version` cannot identify the channel. Use `app_fetch_build_info`, never the bare version, for update decisions.
- **The build channel is declared in `src-tauri/build-info.json`** (`{ "prerelease": false, "beta": 0 }`), next to `build.rs` — *not* inferred from `git describe --exact-match` any more. That inference required building from a tagged commit; missing the tag didn't error, it just turned a `-Bata2` build into stable `v0.3.0` (wrong in both directions, clean console). `prerelease:false` → `v{Cargo version}`; `prerelease:true, beta:N` → `v{Cargo version}-BataN`. `VIEWPDF_BUILD_TAG` still overrides for CI. **A wrong declaration must fail the build** (`beta: 0` with `prerelease: true`, malformed JSON, missing file) — never fall back to stable. The `rerun-if-changed` on that file is load-bearing: without it, editing the declaration and re-running `cargo tauri dev` reuses the old artifact, which compiles, runs, and shows nothing wrong.
- **`build-identity.js` is the single reader of build identity on the frontend**, and the **only** place that calls `invoke('app_fetch_build_info')`. Both `settings.js` and `update.js` go through `resolve_build_identity()`; `update-resolve.mjs` counts the real call sites to keep it at one. Its `ViewPDFDev` global (`setVersion` / `clearVersion` / `getVersion` / `isOverridden`) is a **dev-only, in-memory** override — `init.js` side-loads the module so the global exists at startup, since both consumers are lazy and the settings panel is only imported once the user opens it. Three boundaries, each guarded: memory only (persisting it would ship a user-triggerable fake version that then drives update decisions), shape identical to Rust's `AppBuildInfo` with `version` set to the **core** version so an overridden beta behaves exactly like a real one, and **telemetry stays on `app_fetch_version`** — routing `reportVersion` through the override would report fake versions to the server on every preview. Invalid input **throws**: silently treating `Bata3` as stable `0.0.0` makes the next step be "wonder why the override didn't work".
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
