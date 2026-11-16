# Kaleidosync Phase 2 — Strict Implementation Instructions

## 0. Scope and non-negotiables
- **Goal:** ship a standalone desktop app that renders Kaleidosync visuals **reliably synced to Spotify/system audio** and includes **all visualizers (sketches) from the kaleidoscope/kaleidosync reference**, not just the 4 userscript presets.
- **Audio source:** capture OS/loopback/monitor audio (the stream Spotify is playing through the system). Do **not** depend on Spotify Web API, tokens, PKCE, track analysis endpoints, or DOM media-element tapping.
- **Visual parity:** port the full sketch library and the uniform/variant/tween behavior from the reference (`/tmp/kilo/kaleidosync-docker/`, primarily `@wearesage/vue/src/stores/sketches.ts` and `@wearesage/vue/src/composables/graphics/useShader.ts`). Do not hand-wave missing sketches; inventory and port every one.
- **Renderer contract:** preserve the reference shader environment (`resolution/time/stream/volume` + `iResolution/iTime/iStream/iVolume`, GLSL utils, boolean-uniform tween helpers, `vUv`, `main()`/`mainImage` handling) so imported sketches compile and behave correctly.
- **Responsiveness:** must render correctly at any window size/aspect ratio and device pixel ratio (fullscreen, resize, rotation/multi-monitor where applicable).
- **No regressions from Phase 1:** keep/port the working shader harness, GLSL utils, resize handling, and visualizer switching UX.

## 1. Baseline inventory (do before coding)
1.1 **Reference sources (read-only):**
- `/tmp/kilo/kaleidosync-docker/node_modules/@wearesage/vue/src/stores/sketches.ts` — canonical sketch set (~50 `shader` entries) with per-sketch `variants` (uniform values) and bool uniforms that imply `<name>Tween`/`<name>TweenProgress` handling.
- `/tmp/kilo/kaleidosync-docker/node_modules/@wearesage/vue/src/composables/graphics/useShader.ts` — uniform set/init/update, `mainImage` wrapping, bool tween uniform synthesis.
- `/tmp/kilo/kaleidosync-docker/node_modules/@wearesage/vue/src/constants/glsl-util.ts` (and `@wearesage/editor/.../glsl-util.ts`) — GLSL helpers.
- `/tmp/kilo/kaleidosync-docker/node_modules/@wearesage/vue/src/util/{generate-variant,build-variant-interpolator,uniform-range-utils,...}` — variant generation/magic-tween interpolation (d3-interpolate semantics).
- `/home/brgjr10/Projects/kaleidosync-tm/{kaleidosync.user.js,renderer.js,audio.js,glsl-utils.js,shader-source.frag.glsl}` — Phase 1 implementation to reuse/adapt.

1.2 **Extract and freeze the sketch catalog:**
- Write a deterministic extractor script (Node or Python) that parses `sketches.ts` and emits `assets/sketches.json` (or `.ts`) containing, for each sketch: stable `id` (index/order + hash), `shader` source, `variants[]` (exact uniform objects/values), and derived `uniformSchema` (name, type: float|bool|vec2|vec3 inferred from value, default/first variant value).
- **Acceptance:** extracted count must equal the reference shader count (verify against `sketches.ts`), and each entry round-trips its `shader` and `variants` verbatim (no dropped/rewritten GLSL). Commit the generated artifact and the extractor.

1.3 **GLSL utility parity:**
- Ensure utils include at minimum: `k_hue`, `k_kale`, `k_orb`, `k_rainbow`, `k_rotate2d`, `k_swap`, `k_sphere`, `k_uv_to_sphere`, `k_uv` (compare to `@wearesage/.../glsl-util.ts`). Phase 1 `glsl-utils.js` currently lacks `k_swap` — add it and any other missing helpers.
- Confirm sketches that define their own helpers (many inline `kale/orb/rotate/hue/palette/swap`) still compile with utils prepended (no duplicate-symbol errors given injected declarations order); if conflicts occur, adopt the reference injection order/guarding.

## 2. Desktop app architecture (recommended stack)
2.1 **Stack (choose and document; default recommendation):** Electron (Chromium WebGL + Node) or Tauri v2 with a WebGL frontend. Either is acceptable if it satisfies OS audio capture below.
- Rationale: reuse Three.js/WebGL shader harness and the extracted GLSL with minimal rewrite; Node/native side handles loopback capture.
- Create project at `/home/brgjr10/Projects/kaleidosync-desktop/` (monorepo-style: `app/` UI, `native/` or `audio/` capture module, `assets/` sketches).

2.2 **Modules (must be separated):**
- `audio-capture`: OS loopback input, device selection, start/stop, ring buffer/frames.
- `audio-analysis`: produces `volume` and `stream` per render tick (same semantics as Phase 1/reference: normalized energy + accumulating stream driven by energy) at stable rate; exposes diagnostics (levels, device, sample rate).
- `renderer`: Three.js `ShaderMaterial` harness (ported from `useShader.ts`/`renderer.js`) with full uniform support and responsive resize.
- `sketch-engine`: loads `assets/sketches.json`, selects sketch/variant, applies uniform values, handles bool tween uniforms (`<name>`, `<name>Tween`, `<name>TweenProgress`) per `useShader.ts`, and supports variant interpolation/"magic tween" per `build-variant-interpolator`/`generate-variant`.
- `ui`: overlay/controls for play state, sketch browser/next-prev, variant/magic controls, audio device picker, FPS/debug.

## 3. OS audio capture (critical path)
3.1 **Linux (PipeWire/PulseAudio, primary dev env):**
- Capture from the default sink monitor (e.g. Pulse monitor source of the active sink) so Spotify app/web playback is heard. Use a native capture path such as `parec`/`pw-record` piping PCM, PortAudio, or a Node binding (e.g. `naudiodon`, `node-portaudio` alternatives) capable of monitor/loopback devices. **Do not require microphone permission as the audio source.**
- Provide device enumeration and a selector; default to "system output/monitor". Document required packages (e.g. PipeWire/Pulse utils) and permissions.

3.2 **Windows/macOS (implement or explicitly gate):**
- Windows: WASAPI loopback capture of render endpoint. macOS: system loopback (ScreenCaptureKit/BlackHole-style) — if not implemented, the app must detect unsupported capture and show a clear actionable message, but Linux support is mandatory.

3.3 **Analysis pipeline:**
- Feed captured PCM into FFT/frequency data (Web Audio `AnalyserNode` in renderer process, or an equivalent FFT in Node/native) and compute `volume`/`stream` per frame using the Phase 1/reference algorithm as baseline (adaptive sample window, instantaneous+adaptive blend for responsiveness). Tune so beats/transients are visible; expose smoothing/gain in settings.
- **Acceptance:** with Spotify playing, diagnostics show non-zero changing levels and visuals clearly react to loud/quiet/beat changes; when silent/paused, motion/brightness settle (or follow defined fallback) without freezing.

## 4. Renderer and sketch engine (full visualizer parity)
4.1 **Shader harness parity (match `useShader.ts`):**
- Uniforms always present: `resolution` (vec2), `time` (float), `stream` (float), `volume` (float), `iResolution` (vec3), `iTime`, `iStream`, `iVolume`, plus all sketch/variant uniforms.
- For every boolean uniform `<name>`, also provide `<name>Tween` (bool) and `<name>TweenProgress` (float) and drive them during transitions exactly as reference (see stores/composables tween logic). Many sketches branch on these (`k_swap`/inline tween mixes).
- Inject declarations + GLSL utils + shader body. Support shaders with `void main()` and with `void mainImage(out vec4, in vec2)` (wrap to `main` as reference/Phase 1). Keep `varying vec2 vUv;` and `k_uv()` working. Prefer the reference `defs`/injection order to avoid redefinition issues.
- Auto-resize every frame (or on resize + DPR change): update drawing buffer, camera/projection as needed, and `iResolution/resolution` so any aspect ratio is correct.

4.2 **Port ALL sketches (mandatory):**
- Load every sketch from the extracted catalog (all ~50 from `sketches.ts`). Do **not** ship a partial subset.
- Implement sketch selection: next/prev, indexed/jump, random, and (if feasible) thumbnail/list browser. Preserve/implement "magic" behavior: variant tweening/interpolation and random-variant generation using `build-variant-interpolator` and `generate-variant` semantics (respect types: numbers interpolated, bools held, vec/arrays component-wise as reference).
- Handle uniform ranges/steps consistently with `uniform-range-utils` where applicable for generated/tweened values.
- **Acceptance:** every catalog entry can be selected and renders without shader compile/link errors; bool-tween sketches (e.g. warp/mirror/invert/kaleidoscope/dotted variants present in catalog) transition correctly; magic/randomize produces valid variants.

4.3 **Shader compatibility fixes (expected):**
- Some catalog shaders redefine helpers already in utils (`kale/orb/rotate/hue/palette/swap`) or declare local `PI`/precision. Resolve by (a) matching reference concatenation/wrapping so duplicates are tolerated, or (b) namespacing/deduping in the injector — but **never** by deleting sketch logic. Validate by compiling each shader headlessly/in-app at startup in a debug pass and log failures; zero compile failures required at release.

## 5. UX, controls, and packaging
5.1 **Controls:** toggle UI/overlay, fullscreen, next/prev/random/magic sketch, shader list, FPS + audio diagnostics (device, tapped/level, volume/stream). Hotkeys documented in-app.
5.2 **Persistence:** remember last sketch/variant, audio device, and settings.
5.3 **Packaging:** provide a reproducible build/run (`npm/yarn/pnpm` scripts or Tauri cargo) with README: prerequisites (Node/Rust, PipeWire/Pulse on Linux), install, `dev`, `build`, and audio-device troubleshooting. Add a one-command dev start.
5.4 **Repo hygiene:** keep Phase 1 userscript intact at `/home/brgjr10/Projects/kaleidosync-tm/` (reference/fallback); put Phase 2 under `/home/brgjr10/Projects/kaleidosync-desktop/` (or a clearly named sibling) with its own README.
5.5 **CI — build final app files (required):**
- Add CI configuration in the Phase 2 repo (e.g. `.github/workflows/build.yml` for GitHub Actions, or equivalent for the chosen host) that builds and packages the **final distributable app files/installers**.
- **Triggers:** run on push and pull requests to main branches, on version tags/releases, and support manual dispatch (`workflow_dispatch`).
- **Jobs/matrix:** at minimum build Linux distributables in CI (primary target). Include Windows and/or macOS build jobs when the stack/toolchain supports them; if a platform is not yet supported, include an explicit gated/skipped job with a documented reason (do not silently omit).
- **Steps (strict):** checkout; set up required runtimes/toolchains (Node, Rust/cargo if Tauri, platform system deps for audio/build/packaging); install dependencies with lockfile and frozen/immutable install; run lint/typecheck/tests and sketch-catalog validation (count/parity/compile checks) when present; build/package **release** artifacts (e.g. Electron Builder or Tauri bundles such as AppImage/deb/rpm/tar.gz/dmg/msi/exe/zip as applicable to the stack and OS); fail the workflow on any error.
- **Artifacts:** upload the final app files/installers as CI artifacts with clear names including OS, arch, and version. On version tags/releases, attach or publish artifacts to the release per host conventions.
- **Reproducibility:** pin CI action versions, cache dependencies/build caches safely, and ensure builds are reproducible from a clean checkout. Document CI prerequisites and how to download built artifacts in the README.

## 6. Verification checklist (must pass)
- [ ] `assets/sketches.json` contains **all** sketches from `@wearesage/vue/src/stores/sketches.ts` (count matches) with verbatim shaders/variants.
- [ ] GLSL utils include `k_swap` (and full parity set); all sketches compile/link with zero errors.
- [ ] App captures system/monitor audio on Linux and visuals react to Spotify playback (observable beat/level correlation); diagnostics confirm active signal.
- [ ] `volume/stream` (and `i*` counterparts) drive shaders each frame; bool `<name>Tween`/`<name>TweenProgress` uniforms function.
- [ ] Renders correctly at arbitrary window sizes/aspect ratios, resize, and fullscreen (no stretching/distortion beyond intended shader math, no undefined-uniform errors).
- [ ] Next/prev/random/magic and variant switching work across the full catalog.
- [ ] No Spotify Web API/tokens/PKCE/DOM-tap dependency for audio reactivity.
- [ ] CI workflow builds and packages final distributable app files (Linux at minimum), runs required checks, and uploads release artifacts successfully from a clean checkout.
- [ ] Build/run instructions verified from a clean checkout.

## 7. Deliverables
- `/home/brgjr10/Projects/kaleidosync-desktop/` app with source, `assets/sketches.json`, extractor, README, build scripts, and CI workflow configuration that produces final distributable app files/installers.
- Short `MIGRATION_NOTES.md` documenting: audio-capture approach per OS, CI/build targets and artifact locations, any sketches that needed injector/compat fixes (and why), and known gaps.
- Phase 1 userscript left in place with a note pointing to Phase 2 for reliable audio sync.

## 8. Known context (from Phase 1)
- v0.9.2 userscript works for render/resize/shader-swap but **cannot** tap Spotify web audio in the tested case (`media: []`, `tapped: false`, `ctxState: null`); OS-level capture in Phase 2 is the intended fix.
- Port the proven analyser→shader responsiveness tuning and the resize-every-frame approach; do not regress them.
