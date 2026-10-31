import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/voice-sim', timeout: 45000, fullyParallel: false, workers: 1,
  outputDir: 'test-results/voice-sim',
  reporter: [['list'], ['./tests/voice-sim/reporter.ts']],
  use: { baseURL: 'http://127.0.0.1:3100', permissions: ['microphone'],
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: [
    { command: 'cd ../backend && PYTHONPATH=.:tests MODEL_MODE=demo DATA_DIR=data/e2e/voice-sim uv run uvicorn voice_sim_server:app --host 127.0.0.1 --port 8100',
      url: 'http://127.0.0.1:8100/health', reuseExistingServer: false, timeout: 30000 },
    { command: 'NEXT_PUBLIC_API_URL=http://127.0.0.1:8100 npm run dev -- --port 3100',
      url: 'http://127.0.0.1:3100', reuseExistingServer: false, timeout: 120000 },
  ],
});
