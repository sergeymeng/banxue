// Isolated packaged-runtime test. Dummy encrypted credential + mock cloud, fake media device.
const { _electron: electron, expect } = require('@playwright/test');
const { mkdtemp, readFile } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
(async () => {
  const root = path.resolve(__dirname, '../..');
  const userData = await mkdtemp(path.join(os.tmpdir(), 'banxue-voice-test-'));
  const app = await electron.launch({ executablePath: path.join(root, 'dist/伴学-darwin-arm64/伴学.app/Contents/MacOS/Banxue'),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], env: { ...process.env, BANXUE_DATA_DIR: userData }, timeout: 60000 });
  try {
    const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.evaluate(async () => {
      const config = await window.desktop.getSettings();
      const catalog = await (await fetch('/api/voice/config')).json();
      config.voice = { ...config.voice, ...catalog.presets.beijing, enabled: true, api_key: 'test-only-not-a-real-provider-key', cny_to_gbp: .12 };
      await window.desktop.saveSettings(config);
    });
    const envelope = await readFile(path.join(userData, 'settings.json'), 'utf8');
    if (envelope.includes('test-only-not-a-real-provider-key') || !JSON.parse(envelope).encrypted) throw new Error('Voice credential was not encrypted');
    await page.reload();
    const safe = await page.evaluate(() => window.desktop.getSettings());
    if (safe.voice.api_key !== '' || !safe.voice.has_key) throw new Error('Saved key returned to renderer');
    await page.evaluate(async () => {
      const teacher = await (await fetch('/api/teachers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Voice Desktop Test' }) })).json();
      localStorage.setItem('banxue.lastTeacher', teacher.id);
    });
    await page.reload();
    await expect(page.locator('.chat-header strong')).toHaveText('Voice Desktop Test');
    let socket;
    await page.routeWebSocket('**/api/lessons/*/voice', ws => { socket = ws; ws.onMessage(data => {
      if (typeof data === 'string' && JSON.parse(data).ticket) ws.send(JSON.stringify({ type: 'ready' }));
    }); });
    await page.getByRole('button', { name: '开始语音' }).click();
    await expect(page.getByRole('status').filter({ hasText: '正在听' })).toBeVisible({ timeout: 30000 });
    for (const event of [{ type: 'turn', turn_id: 'smoke' }, { type: 'segment', turn_id: 'smoke', segment_id: '1', text: '桌面播放测试' },
      { type: 'audio', turn_id: 'smoke', segment_id: '1', pcm: Buffer.alloc(24000 * 2 * 5).toString('base64') }]) socket.send(JSON.stringify(event));
    await expect(page.getByRole('status').filter({ hasText: '正在讲解' })).toBeVisible();
    await page.getByRole('button', { name: '打断' }).click();
    await page.getByRole('button', { name: '关闭语音', exact: true }).click();
    await expect(page.getByRole('button', { name: '开始语音' })).toBeVisible();
    await page.getByRole('button', { name: '课堂菜单', exact: true }).click();
    await page.getByRole('button', { name: /设置/ }).click();
    await expect(page.getByLabel('千问 API Key')).toHaveValue('');
    await page.screenshot({ path: path.join(root, 'docs/voice-evaluation/desktop-qwen-settings.png') });
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('PASS packaged voice: encrypted dummy credential, no renderer disclosure, real bundled VAD/WASM under CSP, fake microphone, native playback and stop. Cloud socket mocked; no paid or physical audio validation.');
  } finally { await app.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
