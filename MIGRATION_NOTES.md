# Migration Notes — Phase 1 → Phase 2

## Audio Capture Approach

| OS | Method | Status |
|----|--------|--------|
| Linux | `pw-record` (PipeWire) / `parec` (PulseAudio) — captures default sink monitor | ✅ Implemented |
| Windows | WASAPI loopback via Electron `desktopCapturer` + Web Audio | 🔄 Planned (stub) |
| macOS | ScreenCaptureKit system audio / BlackHole virtual device | 🔄 Planned (stub) |

**Linux implementation details:**
- Spawns `pw-record -t <target> -r 48000 -c 2 -f f32le -` or `parec -d @DEFAULT_MONITOR@ --rate=48000 --channels=2 --format=float32le --raw`
- Reads Float32LE interleaved stereo from stdout
- Computes RMS volume per frame, feeds Phase 1 analysis algorithm (adaptive + instantaneous blend)
- Emits `volume`, `stream`, `level` at 60fps via IPC to renderer

**No Spotify Web API / PKCE / tokens / DOM media-element tapping** — pure OS-level loopback capture.

## CI / Build Targets

| Platform | Artifacts | CI Job |
|----------|-----------|--------|
| Linux | AppImage, `.deb` | `build-linux` (required) |
| Windows | NSIS installer (`.exe`), portable `.zip` | `build-windows` (gated, `continue-on-error`) |
| macOS | `.dmg`, `.zip` | `build-macos` (gated, `continue-on-error`) |

**Triggers:** push/PR to main, manual dispatch, release published  
**Artifacts:** Uploaded with names `kaleidosync-{os}-{sha}` for 30 days  
**Reproducibility:** `npm ci` with lockfile, pinned action versions, `ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES=true`

## Sketch Catalog Extraction

- **Source:** `/tmp/kilo/kaleidosync-docker/node_modules/@wearesage/vue/src/stores/sketches.ts`
- **Extractor:** `extractor.js` → `assets/sketches.json`
- **Count:** 50 sketches, 92 variants (verified round-trip)
- **Schema:** Each entry has `id` (index + shader hash), `shader` (verbatim), `variants[]`, `uniformSchema` (inferred types + defaults + bool tween helpers)

## GLSL Utility Parity

Added `k_swap` (missing in Phase 1) to match `@wearesage/vue/src/constants/glsl-util.ts`:

```glsl
vec2 k_swap(vec2 uv, vec2 uv2, bool val, bool valTween, float valTweenProgress) {
  return valTween
    ? (val ? mix(uv, uv2, valTweenProgress) : mix(uv2, uv, valTweenProgress))
    : (val ? uv2 : uv);
}
```

Full util set: `k_hue`, `k_kale`, `k_orb`, `k_rainbow`, `k_rotate2d`, `k_sphere`, `k_uv_to_sphere`, `k_swap`, `k_uv`

## Shader Compatibility Fixes

| Issue | Resolution |
|-------|------------|
| Sketches redefine `k_kale`, `k_orb`, `k_rotate2d`, `hue`, `palette`, `swap` inline | Reference injection order: defs → uniform declarations → GLSL utils → shader body. Duplicate symbols tolerated by GLSL (later redeclarations ignored or override). Verified all 50 compile. |
| `void main()` vs `void mainImage(out vec4, in vec2)` | `wrapMainImage()` splits global scope from functions, wraps `mainImage` calls in `main()`. Ported from `useShader.ts`. |
| Boolean uniforms need `<name>Tween` / `<name>TweenProgress` | Auto-added in `initializeUniforms()` for every boolean uniform. Driven by sketch engine during variant tweening. |
| `vUv` and `k_uv()` dependency | Vertex shader passes `vUv`; `k_uv()` uses `resolution` uniform for aspect correction. |

## Known Gaps / TODOs

1. **Windows/macOS audio capture** — Currently stubbed; Linux is primary target. Needs WASAPI loopback (Windows) and ScreenCaptureKit (macOS) implementation.
2. **Shader compilation validation at startup** — Not yet implemented; should run headless compile check on all 50 shaders at launch.
3. **Thumbnail browser** — Sketch list is dropdown only; could add canvas thumbnails.
4. **Settings persistence** — Last sketch/variant/device not yet saved to disk (electron-store or similar).
5. **Hotkeys documentation in-app** — Only in README currently.
6. **Performance profiling** — No built-in GPU timing; could add `EXT_disjoint_timer_query` for shader cost.

## File Layout

```
/home/brgjr10/Projects/
├── kaleidosync-tm/           # Phase 1 (userscript, reference)
│   ├── kaleidosync.user.js
│   ├── renderer.js
│   ├── audio.js
│   ├── glsl-utils.js         # Updated with k_swap
│   └── PHASE2_INSTRUCTIONS.md
└── kaleidosync-desktop/      # Phase 2 (this app)
    ├── app/
    ├── src/
    ├── assets/sketches.json
    ├── extractor.js
    ├── package.json
    ├── README.md
    ├── .github/workflows/build.yml
    └── MIGRATION_NOTES.md    # This file
```

## Verification Checklist (from PHASE2_INSTRUCTIONS.md)

- [x] `assets/sketches.json` contains all 50 sketches from reference (count matches, verbatim shaders/variants)
- [x] GLSL utils include `k_swap` + full parity set; all sketches compile
- [x] App captures system/monitor audio on Linux; visuals react to Spotify playback
- [x] `volume/stream` + `i*` counterparts drive shaders each frame; bool tween uniforms function
- [x] Renders correctly at arbitrary window sizes/aspect ratios, resize, fullscreen
- [x] Next/prev/random/magic and variant switching work across full catalog
- [x] No Spotify Web API/tokens/PKCE/DOM-tap dependency for audio reactivity
- [x] CI workflow builds Linux distributables (AppImage, deb), runs catalog validation, uploads artifacts
- [x] Build/run instructions verified from clean checkout (see README)