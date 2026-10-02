import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
const lanAddress =
  Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address ?? '127.0.0.1';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3100',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    env: {
      PORT: '3100',
      HOST: '0.0.0.0',
      GATHER_PUBLIC_URL: `http://${lanAddress}:3100`,
      GATHER_DATA_DIR: mkdtempSync(join(tmpdir(), 'gather-browser-')),
    },
  },
});
