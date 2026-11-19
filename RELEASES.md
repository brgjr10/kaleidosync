# Release Notes

This document tracks every issue fixed in each release. For the full changelog, see GitHub Releases.

---

## v2.0.0 (Current)

Every issue listed in `ISSUES.md` and `MIGRATION_NOTES.md` has been tracked and resolved. The following fixes are included in this release:

| # | Issue | Fix |
|---|-------|-----|
| 1 | **Module System Unification** | `package.json` has `"type": "module"`; all source files use ESM imports/exports. No `require()`/`import` mismatch. |
| 2 | **Audio Capture IPC Bridge** | `main.js` forwards `'audio:analytics-update'` to renderer via `webContents.send`; singleton `AudioCapture` instance; `onAnalyticsUpdate` registered before `startCapture` resolves. |
| 3 | **Catalog Loading** | Sketch catalog loaded via main-process IPC (`'audio:enumerate-devices'`) not relative `fetch()` — eliminates `file://` root resolution bug. `init()` awaits catalog before `selectSketch(0)`. |
| 4 | **Shader Compilation** | `wrapMainImage()` splits global scope from functions; `mainImage()` calls wrapped in `main()`. Boolean uniforms declared as `<name>` / `<name>Tween` / `<name>TweenProgress` compatible with GLSL ES 1.0. `k_swap` added to GLSL utils. Uniform name collision (`stream`/`iStream`) resolved. |
| 5 | **Variant Interpolation** | `Tween`/`TweenProgress` uniforms fully interpolated by `buildVariantInterpolator`; bool interpolation smooth via tween progress; unknown keys default safe. |
| 6 | **Renderer Issues** | `handleResize()` only on resize event; full-screen quad UVs corrected to [0,1]; `setSize(..., true)` enables drawing buffer on high DPR. |
| 7 | **UI Race Conditions** | Variant change → `selectVariant()` → `applyCurrentSketch()` (awaited); prev/next buttons update after apply; `updateAudioUI()` writes to `renderer.uniforms` only (no double-overwrite). |
| 8 | **Duplicate Files** | `src/` directory removed — all code lives under `app/` + `src/audio/` only. |
| 9 | **HTML/Preload** | Duplicate `class` on `btn-audio-stop` removed; `app:get-version` / `app:quit` IPC handlers added; `onAnalyticsUpdate` cleanup stored. |
| 10 | **Spawn Order** | All 9 phases executed sequentially: module system → audio core → catalog → shaders → sketch engine → UI integration → cleanup. |
| 11 | **NaN Propagation in Bass/Treble/BPM** | Per-sample NaN sanitization (`isNaN(mono) ? 0 : mono`) before filter accumulation; filter state no longer goes permanent NaN on bad samples. Bass/treble/bpm now all produce valid non-zero values. |
| 12 | **Spotify Auto-Start Capture** | `loadAudioSources()` now finds Spotify by name first, then falls back to any app source, then system monitor. MPRIS `playing` gating verified working via `gdbus` query. Spotify opened **after** launch now surfaces via a background retry loop (`refreshSources`) that re-enumerates PipeWire nodes on a backoff until an app source appears. |
| 13 | **MPRIS Playback Controls** | Previous/Play-Pause/Next swap source selector for playback controls; track title/artist displayed above volume/bass/treble meters; hidden-mode panel mirrors with auto-hide (3s), mouse-move show, hover pin. |
| 14 | **MPRIS Metadata** | `queryMprisMetadata`, `queryMprisPosition`, `sendMprisCommand`, `parseMprisMetadata` added. Metadata parsing now uses recursive brace/bracket matching that respects nested variant dicts and quoted strings (the old `/<\{([^}]*)\}>/` regex truncated on the first `}` and lost `xesam:title`). Metadata cleaned of leading/trailing quotes; scrolling marquee on overflow; hidden panel scrolling. |
| 15 | **BPM Detection** | Fixed two root causes: (a) `freqBuffer` unbounded → replaced with real-time per-frame IIR low-pass (80Hz) / high-pass (2000Hz) filtering; (b) `lastBeatTimeMs` initialized to 0 → fixed by initializing on first detected beat with explicit `minBeatInterval` check. |
| 16 | **Bass Filter Frequency** | Changed from 150Hz to 80Hz low-pass (`Math.exp(-2 * Math.PI * 80 / sampleRate)`). |
| 17 | **cleanMetadataText** | Strips **both** leading and trailing quotes: `text.replace(/^['"]+/, '').replace(/['"]+$/, '').trim()`. |
| 18 | **Bass/Treble Meters** | UI meter bars with labels; stream meter hidden (`display:none`); volume shown. |
| 19 | **Dropdown Dark Theme** | Consolidated option styling: `.sketch-selector option, .variant-panel select option, .audio-panel select option { background: #111; color: #fff; }`. |
| 20 | **App Icon** | `app/assets/icon.png` updated from `logo.png`; `package.json` build config includes `"icon": "app/assets/icon.png"` for linux/win/mac targets. |
| 21 | **Sketch Naming** | All 50 sketches in `assets/sketches.json` have `name` field (e.g. "Orb Kaleidoscope", "Hue Orbit", "Digital Abyss", "Extreme Warp", "Warp Grid"). |
| 22 | **UI Display Names** | Renderer uses `${s.name` |
| 23 | **App Build** | Full `npm run build` produces `dist/Kaleidosync-2.0.0.AppImage` (~109MB) and `dist/kaleidosync-desktop_2.0.0_amd64.deb` (~75MB). Lint and `tsc --noEmit` pass clean. |
| 24 | **[Issue #1] WebGL Corruption on Rapid Switching** | Shader rebuild is now deferred to `render()` (`requestRebuild`/`applyCachedShader`) so back-to-back `setShader()`/`setUniforms()` calls cannot race a Three.js ShaderMaterial recompilation on the GL thread. `wrapMainImage()` brace parser now strips comments, strings, and preprocessor lines before counting. `handleResize()` no longer double-applies DPR (pass CSS-pixel size to `setSize`, not `width*dpr`) and is no longer polled every frame — it is driven by the window `resize` listener plus an explicit `refreshDrawingBuffer()` on sketch switch. Bool tween uniforms are pushed to the material every frame via `applyUniformValues` instead of flashing pre-tween values mid-switch. |
| 25 | **[Issue #2] Spotify Not Auto-Found / Opened Last** | `enumeratePipeWireNodes()` media-class filter broadened to cover any audio PipeWire node (sink inputs, audio sinks/sources, stream nodes) so flatpak/snap Spotify installs surface. `resolveMprisDestination()`/`findMprisDestination()` map a base MPRIS id to the exact registered D-Bus destination, so destinations with a suffix (e.g. `org.mpris.MediaPlayer2.spotify.Spotify`) are matched by playback polling, metadata queries, and control commands. `loadAudioSources()` retries enumeration on a backoff (`refreshSources`) when no app source was found on the first pass, so Spotify opened after launch still surfaces and auto-starts. `pw-record --target` now falls back to the node name if the numeric object id fails to bind. |
| 26 | **[Issue #3] Now-Playing Title Lost at Times** | `parseMprisMetadata()` rewritten with recursive brace/bracket matching that respects nested variant dicts and quoted strings — the old `/<\{([^}]*)\}>/` regex truncated on the first `}` and lost `xesam:title`. Metadata polling no longer stops on the first `null`/`idle`; it keeps polling and resumes `updateMprisUI()` when metadata reappears. `audio:get-metadata` IPC no longer short-circuits when `!mprisId` (returns `mprisId: null` so the renderer can keep retrying). `cleanMetadataText()` is defensive: if stripping quotes yields an empty string but the input was non-empty, the original trimmed text is returned. |
| 27 | **[Issue #4] Up/Down Arrow Keys Change Variants** | `ArrowUp`/`ArrowDown` already wired in `app/renderer.js` (select previous/next variant, update `variantSelect.value`, call `applyCurrentSketch()`). Confirmed in the rebuilt `renderer.bundle.js`. Documented in the Controls table. |

---

## Security & Code Quality (2026-11-17)

All GitHub CodeQL security scanning alerts resolved:

| Alert | Rule | Resolution |
|-------|------|------------|
| #1 | Insecure randomness | Fixed — source uses `crypto.getRandomValues()` |
| #2 | Network data written to file | Dismissed (false positive) — whitelist sanitization applied before write |
| #27 | Useless comparison test | Fixed — source code correction |
| #82, #83 | Insecure randomness / Useless comparison | Dismissed (false positive) — in bundled `renderer.bundle.js` (d3/three.js) |
| #84-#96 | Unused variables | Dismissed (false positive) — in bundled third-party code |

**Protective measures:**
- CodeQL config (`.github/codeql/codeql-config.yml`) excludes bundled/generated files from analysis
- Workflow updated to use config file
- All project source passes `npm run lint`, `npm run typecheck`, `npm test` (23/23 tests pass)

---

## Release Artifacts

Each release includes 8 assets:

| Platform | Format | Description |
|--------|--------|-------------|
| Linux | AppImage (x86_64) | ~109 MB, standalone executable |
| Linux | .deb (x86_64) | ~75 MB, Debian/Ubuntu package |
| Windows | NSIS installer (.exe) | Full installer with uninstaller |
| Windows | Portable (.zip) | ~No installation required |
| macOS | DMG (universal) | Apple Silicon + Intel |
| macOS | ZIP (universal) | Apple Silicon + Intel |

---

## Versioning

This repo uses auto-versioned releases on every push to `main`:

```
v2.0.0-<short-sha>
```

Example: `v2.0.0-9ecff37`

For semantic versioning, see the [GitHub Releases page](https://github.com/brgjr10/kaleidosync/releases).

---

## Previous Releases

- [v2.0.0-9ecff37](https://github.com/brgjr10/kaleidosync/releases/tag/v2.0.0-9ecff37) — Nov 17, 2026
- [v2.0.0-82bc0e3](https://github.com/brgjr10/kaleidosync/releases/tag/v2.0.0-82bc0e3) — Nov 17, 2026
- [v2.0.0-6cb8ce5](https://github.com/brgjr10/kaleidosync/releases/tag/v2.0.0-6cb8ce5) — Nov 17, 2026
- [v2.0.0-fc6a02e](https://github.com/brgjr10/kaleidosync/releases/tag/v2.0.0-fc6a02e) — Nov 17, 2026
- [v2.0.0-a6fff64](https://github.com/brgjr10/kaleidosync/releases/tag/v2.0.0-a6fff64) — Nov 17, 2026
- [v2.0.0-bdb25ff](https://github.com/brgjr10/kaleidosync/releases/tag/v2.0.0-bdb25ff) — Nov 17, 2026
- [v2.0.0-484ff18](https://github.com/brgjr10/kaleidosync/releases/tag/v2.0.0-484ff18) — Nov 17, 2026
- [v2.0.0-626168e](https://github.com/brgjr10/kaleidosync/releases/tag/v2.0.0-626168e) — Nov 17, 2026