import { defineConfig } from '@playwright/test';

function port(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error('Invalid handwriting E2E port');
  return parsed;
}
const uiPort = port(process.env.HANDWRITING_E2E_UI_PORT, 3317);
const apiPort = port(process.env.HANDWRITING_E2E_API_PORT, 8317);
const ui = `http://127.0.0.1:${uiPort}`, api = `http://127.0.0.1:${apiPort}`;
process.env.HANDWRITING_E2E_API_URL = api;
export default defineConfig({
  testDir: './tests/e2e', testMatch: 'handwriting.spec.ts', timeout: 60000, workers: 1,
  outputDir: 'test-results/handwriting',
  use: { baseURL: ui, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: `cd ../backend && MODEL_MODE=demo DATA_DIR=data/e2e/handwriting ALLOWED_ORIGINS=${ui} uv run uvicorn app.main:app --host 127.0.0.1 --port ${apiPort}`, url: `${api}/health`, reuseExistingServer: false, timeout: 30000 },
    { command: `NEXT_PUBLIC_API_URL=${api} npm run dev -- --port ${uiPort}`, url: ui, reuseExistingServer: false, timeout: 120000 },
  ],
});
