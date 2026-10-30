import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 60000, fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3100', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: 'cd ../backend && MODEL_MODE=demo DATA_DIR=data/e2e ALLOWED_ORIGINS=http://127.0.0.1:3100 uv run uvicorn app.main:app --host 127.0.0.1 --port 8100', url: 'http://127.0.0.1:8100/health', reuseExistingServer: false, timeout: 30000 },
    { command: 'NEXT_PUBLIC_API_URL=http://127.0.0.1:8100 npm run dev -- --port 3100', url: 'http://127.0.0.1:3100', reuseExistingServer: false, timeout: 120000 }
  ]
});
