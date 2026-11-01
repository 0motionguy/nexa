import { defineConfig, devices } from '@playwright/test';

const e2eAgentKeys = [
  process.env['NEXA_AGENT_KEYS']?.trim() || 'nx_live_7f3k_demo',
  'nx_live_e2e_mobile=live-mode-chromium-mobile@maze.test',
  'nx_live_e2e_desktop=live-mode-chromium-desktop@maze.test',
].join(',');

// Env-overridable ports so the suite can boot its own stack next to a live
// dev server (EADDRINUSE otherwise). Defaults match the historical values.
const WEB_PORT = Number(process.env['NEXA_WEB_PORT'] ?? 5173);
const API_PORT = Number(process.env['NEXA_API_PORT'] ?? 8090);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 2 : undefined,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium-mobile', use: { ...devices['Pixel 5'] }, testIgnore: /screenshots\.spec\.ts/ },
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /screenshots\.spec\.ts/ },
    // Visual capture only — the spec sets iPhone SE / iPhone 15 / Pixel widths itself.
    { name: 'screenshots', use: { ...devices['Pixel 5'] }, testMatch: /screenshots\.spec\.ts/ },
  ],
  webServer: [
    {
      command: 'pnpm dev',
      url: `http://localhost:${WEB_PORT}`,
      env: {
        ...process.env,
        NEXA_WEB_PORT: String(WEB_PORT),
        NEXA_API_PORT: String(API_PORT),
      },
      reuseExistingServer: false,
      timeout: process.env['CI'] ? 120_000 : 30_000,
    },
    {
      command: 'pnpm -C ../api exec tsx src/index.ts',
      url: `http://localhost:${API_PORT}/healthz`,
      env: {
        ...process.env,
        API_PORT: String(API_PORT),
        RATE_LIMIT_ENABLED: '0',
        NEXA_AGENT_KEYS: e2eAgentKeys,
      },
      reuseExistingServer: false,
      timeout: process.env['CI'] ? 120_000 : 30_000,
    },
  ],
});
