import { defineConfig } from '@playwright/test';
const frontendPort = process.env.E2E_FRONTEND_PORT || '3100';
const backendPort = process.env.E2E_BACKEND_PORT || '8100';
for (const port of [frontendPort, backendPort]) if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error('E2E port must be between 1024 and 65535');
const dataDir = backendPort === '8100' ? 'data/e2e' : `data/e2e-${backendPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const backendUrl = `http://127.0.0.1:${backendPort}`;
export default defineConfig({
  testDir: './tests/e2e', timeout: 60000, fullyParallel: false, workers: 1,
  use: { baseURL: frontendUrl, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: `cd ../backend && MODEL_MODE=demo DATA_DIR=${dataDir} ALLOWED_ORIGINS=${frontendUrl} uv run uvicorn app.main:app --host 127.0.0.1 --port ${backendPort}`, url: `${backendUrl}/health`, reuseExistingServer: false, timeout: 30000 },
    { command: `NEXT_PUBLIC_API_URL=${backendUrl} npm run dev -- --port ${frontendPort}`, url: frontendUrl, reuseExistingServer: false, timeout: 120000 }
  ]
});
