# Kaleidosync Phase 2 - Functional Issues Audit

## Critical Issues by Area

### 1. Module System Unification (BLOCKER)
- `app/main.js` uses CommonJS `require()` but imports ES modules (`app/src/audio/audio-capture.js` has `export class`)
- `three@0.165+` is ESM-only, cannot be `require()`d in main process
- `package.json` missing `"type": "module"` or consistent module strategy

### 2. Audio Capture IPC Bridge (BLOCKER)
- `AudioCapture` emits `'analytics'` but `main.js` never forwards to renderer via `'audio:analytics-update'`
- `main.js` creates new `AudioCapture` instance per IPC call (no singleton)
- `pw-record --list-targets` parsing broken: reads stderr instead of stdout, regex doesn't match actual output
- Renderer registers `onAnalyticsUpdate` AFTER `startCapture` resolves (misses early data)

### 3. Catalog Loading (BLOCKER)
- `app/src/sketch-engine/sketch-engine.js:28` uses `fetch('assets/sketches.json')` in renderer
- Electron renderer uses `file://` protocol - relative fetch resolves to `file:///assets/sketches.json` (root), not app directory
- `init()` doesn't await catalog load before calling `selectSketch(0)`

### 4. Shader Compilation (BLOCKER)
- `THREE.GLSLShader` deprecated/removed in three.js r165+
- `wrapMainImage()` brace-counting parser fragile - fails on nested braces, comments, preprocessor directives
- Boolean uniforms declared as `uniform bool` but shader uses `precision highp float;` (GLSL ES 1.0) - incompatible
- Uniform name mismatch: shaders use `stream`/`volume` but renderer provides both `stream`/`iStream` causing duplicate declarations
- Shader-local functions (`kale`, `orb`, `swap`) collide with injected `k_kale`, `k_orb`, `k_swap`

### 5. Variant Interpolation
- `Tween`/`TweenProgress` uniforms added by `augmentUniformsWithTweens()` but not interpolated by `buildVariantInterpolator`
- Bool interpolation snaps at end (no smooth progress for `k_swap`)
- Unknown keys get full temperature causing wild variations

### 6. Renderer Issues
- `handleResize()` called every frame in `render()` - should only be on resize event
- Full-screen quad UVs wrong (2x2 UV space instead of [0,1])
- `setSize(..., false)` prevents canvas drawing buffer update on high DPR

### 7. UI Race Conditions
- `variantSelect` change → `selectVariant()` starts tween (async) → `applyCurrentSketch()` immediately applies pre-tween uniforms
- Prev/Next variant buttons update `variantSelect.value` AFTER `applyCurrentSketch()`
- `updateAudioUI()` writes directly to `renderer.uniforms` but `Renderer.updateUniforms()` overwrites with `|| time` fallback

### 8. Duplicate Files
- `src/` directory duplicates `app/src/` entirely - must be removed

### 9. HTML/Preload
- Duplicate `class` attribute on `btn-audio-stop`
- `app:get-version` and `app:quit` IPC handlers missing in main.js
- `onAnalyticsUpdate` cleanup function not stored in renderer

---

## Known pitfalls (learned the hard way)

### Stale AppImage masks fixes
`npm run dev` runs the live `app/renderer.bundle.js` (rebuilt by esbuild).
The **packaged** `app.asar` inside `dist/Kaleidosync-2.0.0.AppImage` /
`.deb` is a *snapshot* taken at build time. Editing source and only running
`npm run dev` leaves the installed artifact stale — a white/frozen canvas in
the AppImage can be an old bundle, not a bug in the new code.

Verify what is actually packaged before debugging further:

```bash
npx asar extract dist/linux-unpacked/resources/app.asar /tmp/asar && \
  grep -c "materialUniforms" /tmp/asar/app/renderer.bundle.js
```

Rebuild the artifact after every source change that must ship:

```bash
npm run build   # AppImage + deb (needs homepage + author.email in package.json)
```

### Material uniforms not refreshed
`Renderer` keeps two uniform maps: the standalone `this.uniforms` (tween /
external audio values) and `this.material.uniforms` (what the GPU sees).
After writing to `this.uniforms`, copy changed values into
`this.material.uniforms` or the render keeps using the previous frame's
values. Regression → blank/constant output.

### electron-builder required metadata
Without `homepage` (deb) and `author.email` (maintainer), `npm run build`
fails on the deb target and never emits artifacts. Both are now in
`package.json`.

---

## Fix Plan - Spawn Order

1. **Module System** - Convert to ESM or CommonJS consistently
2. **Audio Capture Core** - Fix pw-record parsing, singleton, IPC event forwarding
3. **Catalog Loading** - Move to main process IPC
4. **Renderer/Shaders** - Fix Three.js compatibility, uniform declarations, mainImage wrapping
5. **Sketch Engine** - Fix tweening, variant interpolation, catalog loading
6. **UI/Renderer Integration** - Fix race conditions, uniform updates
7. **Cleanup** - Remove src/, fix HTML, final integration test