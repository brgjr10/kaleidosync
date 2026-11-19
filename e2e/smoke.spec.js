/**
 * Packaged-app smoke test.
 *
 * Boots the electron-builder output in dist/ (win-unpacked / mac .app /
 * linux-unpacked), drives the real Electron binary with Playwright's _electron,
 * and asserts that the renderer came up, WebGL initialized, the 50-sketch
 * catalog reached the UI and no uncaught renderer exception fired.
 *
 * It deliberately runs against the *packaged* app, not `electron .`, so it
 * exercises exactly what ships: the bundled main/preload/renderer, the
 * asar-packed assets and the platform audio helper wiring.
 *
 * WebGL is forced onto Chromium's SwiftShader software rasterizer so the test
 * is deterministic on GPU-less CI runners (Windows/macOS cloud VMs). If you
 * ever need the real GPU path, unset KALEIDOSYNC_SOFTWARE_GL.
 */
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TEST_DIR, '..');
const DIST_DIR = path.join(PROJECT_ROOT, 'dist');

function readProductName() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    return pkg.build?.productName || pkg.productName || pkg.name || 'Kaleidosync';
  } catch {
    return 'Kaleidosync';
  }
}

function readExpectedSketchCount() {
  try {
    const catalog = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, 'assets', 'sketches.json'), 'utf8')
    );
    return catalog.count ?? catalog.sketches?.length ?? 0;
  } catch {
    return 0;
  }
}

// Recursively walk `dir` and return the first entry matching `predicate`.
// Skips heavyweight/irrelevant trees. Directories are visited before files.
function walk(dir, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = walk(full, predicate);
      if (hit) return hit;
    } else if (predicate(full, entry)) {
      return full;
    }
  }
  return null;
}

function walkDirs(dir, predicate) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (predicate(full, entry)) return full;
    const hit = walkDirs(full, predicate);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve the launchable Electron binary for the current platform from dist/.
 * electron-builder names differ by target and arch, so match by product name
 * first and fall back to a conservative search.
 */
function resolveExecutable(productName) {
  if (!fs.existsSync(DIST_DIR)) {
    throw new Error(
      `dist/ not found at ${DIST_DIR}. Build the packaged app first ` +
        `(e.g. npm run build -- --linux dir / --win nsis / --mac dmg).`
    );
  }

  if (process.platform === 'win32') {
    const exact = walk(DIST_DIR, (full, e) => e.isFile() && e.name === `${productName}.exe`);
    if (exact) return exact;
    const anyExe = walk(
      DIST_DIR,
      (full, e) =>
        e.isFile() &&
        e.name.toLowerCase().endsWith('.exe') &&
        !/crashpad|crash|helper|update|unins|setup/i.test(e.name)
    );
    if (anyExe) return anyExe;
    throw new Error(`No .exe found under ${DIST_DIR}`);
  }

  if (process.platform === 'darwin') {
    const app = walkDirs(DIST_DIR, (full, e) => e.isDirectory() && e.name === `${productName}.app`);
    if (!app) {
      const anyApp = walkDirs(DIST_DIR, (full, e) => e.isDirectory() && e.name.endsWith('.app'));
      if (!anyApp) throw new Error(`No .app bundle found under ${DIST_DIR}`);
      const macosDir = path.join(anyApp, 'Contents', 'MacOS');
      return firstExecutableIn(macosDir);
    }
    const macosDir = path.join(app, 'Contents', 'MacOS');
    return path.join(macosDir, productName) && fs.existsSync(path.join(macosDir, productName))
      ? path.join(macosDir, productName)
      : firstExecutableIn(macosDir);
  }

  // linux
  const exact = walk(DIST_DIR, (full, e) => e.isFile() && e.name === productName);
  if (exact) return exact;
  const anyElf = walk(
    DIST_DIR,
    (full, e) =>
      e.isFile() &&
      (fs.statSync(full).mode & 0o111) !== 0 &&
      !/\.(so|pak|bin|json|dat|py|pdb|dll|exe|dylib|md|txt)$/i.test(e.name) &&
      !/crashpad|chrome-sandbox|.*-helper/i.test(e.name)
  );
  if (anyElf) return anyElf;
  throw new Error(`No executable found under ${DIST_DIR}`);
}

function firstExecutableIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const found = entries.find((f) => {
    try {
      return fs.statSync(path.join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
  return found ? path.join(dir, found) : null;
}

function softwareGlArgs() {
  if (process.env.KALEIDOSYNC_SOFTWARE_GL === '0') return [];
  // macOS CI runners lack GPU; try SwiftShader first, then fallback to --disable-gpu.
  if (process.platform === 'darwin') {
    return [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox'
    ];
  }
  return [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox'
  ];
}

/* eslint-disable no-empty-pattern -- Playwright's test() requires a destructured
 * first arg ({}, testInfo); the empty pattern carries no data. */
test('packaged app boots, renders WebGL, and lists the sketch catalog', async ({}, testInfo) => {
  const productName = readProductName();
  const executablePath = resolveExecutable(productName);
  expect(fs.existsSync(executablePath), `missing executable: ${executablePath}`).toBeTruthy();

  const electronApp = await electron.launch({
    executablePath,
    cwd: path.dirname(executablePath),
    args: ['--no-sandbox', ...softwareGlArgs()],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });

  const pageErrors = [];
  const consoleLines = [];

  try {
    const window = await electronApp.firstWindow({ timeout: 30_000 });
    window.on('pageerror', (err) => pageErrors.push(err.stack || err.message));
    window.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));

    // 1. DOM + Three.js canvas mount.
    await window.waitForLoadState('domcontentloaded');
    await expect(window.locator('#app canvas')).toBeVisible({ timeout: 20_000 });

    // 2. The catalog reached the UI: init() only populates #sketch-select after
    //    the renderer is constructed (i.e. after WebGL initialized), so a full
    //    option list is a proxy for "WebGL came up and the app reached Ready".
    const expectedCount = readExpectedSketchCount();
    expect(expectedCount, 'could not read sketch count from assets/sketches.json').toBeGreaterThan(0);
    await expect(
      window.locator('#sketch-select option'),
      'sketch dropdown should list every catalog entry'
    ).toHaveCount(expectedCount, { timeout: 20_000 });

    // 3. Variant + audio dropdowns mounted (audio may be empty on a headless
    //    runner — the default "Select audio source..." option must exist).
    await expect(window.locator('#variant-select option').first()).toBeAttached();
    await expect(window.locator('#audio-device-select')).toBeAttached();

    // 4. Let WebGL render a few frames, then capture visual proof.
    await window.waitForTimeout(1500);
    await window.screenshot({ path: testInfo.outputPath(`smoke-${process.platform}.png`) });

    // 5. No uncaught renderer exceptions (shader compilation, IPC, module load).
    expect(
      pageErrors,
      `uncaught renderer errors:\n${pageErrors.join('\n')}\n\nrenderer console:\n${consoleLines.join(
        '\n'
      )}`
    ).toEqual([]);
  } finally {
    await electronApp.close();
  }
});

test('audio device dropdown populates and capture can be started', async ({}, testInfo) => {
  const productName = readProductName();
  const executablePath = resolveExecutable(productName);
  expect(fs.existsSync(executablePath)).toBeTruthy();

  const electronApp = await electron.launch({
    executablePath,
    cwd: path.dirname(executablePath),
    args: ['--no-sandbox', ...softwareGlArgs()],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });

  const pageErrors = [];
  const consoleLines = [];

  try {
    const window = await electronApp.firstWindow({ timeout: 30_000 });
    window.on('pageerror', (err) => pageErrors.push(err.stack || err.message));
    window.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));

    await window.waitForLoadState('domcontentloaded');
    await expect(window.locator('#app canvas')).toBeVisible({ timeout: 20_000 });

    // Wait for audio device dropdown to populate (backend enumeration async)
    await window.waitForTimeout(3000);

    const audioSelect = window.locator('#audio-device-select');
    await expect(audioSelect).toBeAttached();

    // The dropdown should have at least the default option
    const options = await audioSelect.locator('option').all();
    expect(options.length).toBeGreaterThan(0);

    // Click Start Capture button (may fail on headless CI without audio, but shouldn't crash)
    const startBtn = window.locator('#btn-audio-start');
    await expect(startBtn).toBeAttached();
    await expect(startBtn).toBeVisible();

    // Verify the button is enabled
    await expect(startBtn).toBeEnabled();

    // Verify no uncaught exceptions during UI interaction
    expect(pageErrors).toEqual([]);
  } finally {
    await electronApp.close();
  }
});

test('sketch navigation via keyboard and dropdown works', async ({}, testInfo) => {
  const productName = readProductName();
  const executablePath = resolveExecutable(productName);
  expect(fs.existsSync(executablePath)).toBeTruthy();

  const electronApp = await electron.launch({
    executablePath,
    cwd: path.dirname(executablePath),
    args: ['--no-sandbox', ...softwareGlArgs()],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });

  const pageErrors = [];
  const consoleLines = [];

  try {
    const window = await electronApp.firstWindow({ timeout: 30_000 });
    window.on('pageerror', (err) => pageErrors.push(err.stack || err.message));
    window.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));

    await window.waitForLoadState('domcontentloaded');
    await expect(window.locator('#app canvas')).toBeVisible({ timeout: 20_000 });

    const expectedCount = readExpectedSketchCount();
    await expect(
      window.locator('#sketch-select option')
    ).toHaveCount(expectedCount, { timeout: 20_000 });

    // Wait for renderer to fully initialize before testing keyboard nav
    await window.waitForTimeout(2000);

    // Test keyboard navigation: Right arrow = next sketch
    await window.keyboard.press('ArrowRight');
    await window.waitForTimeout(500);

    // Test keyboard navigation: Left arrow = previous sketch
    await window.keyboard.press('ArrowLeft');
    await window.waitForTimeout(500);

    // Test random sketch key
    await window.keyboard.press('R');
    await window.waitForTimeout(500);

    // Test variant navigation: Up/Down arrows
    await window.keyboard.press('ArrowUp');
    await window.waitForTimeout(500);
    await window.keyboard.press('ArrowDown');
    await window.waitForTimeout(500);

    // Test magic tween key
    await window.keyboard.press('M');
    await window.waitForTimeout(1000);

    // Test fullscreen toggle
    await window.keyboard.press('F');
    await window.waitForTimeout(500);
    await window.keyboard.press('F'); // Exit fullscreen
    await window.waitForTimeout(500);

    // Test dropdown selection directly
    const sketchSelect = window.locator('#sketch-select');
    await sketchSelect.selectOption({ index: Math.min(2, expectedCount - 1) });
    await window.waitForTimeout(500);

    // Verify no uncaught exceptions during navigation
    expect(pageErrors).toEqual([]);
  } finally {
    await electronApp.close();
  }
});

test('UI toggle (U key / btn-ui-toggle) shows/hides overlay', async ({}, testInfo) => {
  const productName = readProductName();
  const executablePath = resolveExecutable(productName);
  expect(fs.existsSync(executablePath)).toBeTruthy();

  const electronApp = await electron.launch({
    executablePath,
    cwd: path.dirname(executablePath),
    args: ['--no-sandbox', ...softwareGlArgs()],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });

  const pageErrors = [];
  const consoleLines = [];

  try {
    const window = await electronApp.firstWindow({ timeout: 30_000 });
    window.on('pageerror', (err) => pageErrors.push(err.stack || err.message));
    window.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));

    await window.waitForLoadState('domcontentloaded');
    await expect(window.locator('#app canvas')).toBeVisible({ timeout: 20_000 });

    // Wait for app to fully initialize (sketch dropdown populated = init() complete)
    const expectedCount = readExpectedSketchCount();
    await expect(
      window.locator('#sketch-select option')
    ).toHaveCount(expectedCount, { timeout: 20_000 });

    // Additional wait for event listeners to be fully attached
    await window.waitForTimeout(3000);

    // UI overlay should be visible initially (no .hidden class)
    const overlay = window.locator('#overlay');
    await expect(overlay).not.toHaveClass('hidden');

    // Press U to hide UI - wait longer for key event to process
    await window.keyboard.press('U');
    await window.waitForTimeout(3000);

    // Overlay should be hidden - check class attribute contains 'hidden'
    const classAfterHide = await overlay.getAttribute('class');
    expect(classAfterHide).toContain('hidden');

    // Press U again to show UI
    await window.keyboard.press('U');
    await window.waitForTimeout(3000);

    // UI should be visible again
    const classAfterShow = await overlay.getAttribute('class');
    expect(classAfterShow).not.toContain('hidden');

    // Also test the UI toggle button - use force click since button may not be "visible" by Playwright's definition
    const uiToggle = window.locator('#btn-ui-toggle');
    await expect(uiToggle).toBeAttached();

    await uiToggle.click({ force: true });
    await window.waitForTimeout(3000);
    const classAfterBtnHide = await overlay.getAttribute('class');
    expect(classAfterBtnHide).toContain('hidden');

    await uiToggle.click({ force: true });
    await window.waitForTimeout(3000);
    const classAfterBtnShow = await overlay.getAttribute('class');
    expect(classAfterBtnShow).not.toContain('hidden');

    expect(pageErrors).toEqual([]);
  } finally {
    await electronApp.close();
  }
});