import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the packaged-app Electron smoke test.
 *
 * - Drives the electron-builder output via `_electron`, so no Playwright
 *   browser binaries are required. Install with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
 *   (set job-wide in CI) to skip the ~300 MB browser download.
 * - Only e2e/smoke.spec.js is collected. It lives outside test/ because
 *   `node --test test/` treats every file under test/ as a node:test file and
 *   would try (and fail) to run the Playwright spec under the node runner.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /smoke\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  }
});