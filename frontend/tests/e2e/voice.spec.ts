import { test, expect } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

test.use({ permissions: ['microphone'], launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });
test('voice config missing is explicit and leaves text available', async ({ page, request }) => {
  const teacher = await (await request.post('http://127.0.0.1:8100/api/teachers', { data: { name: 'Voice E2E' } })).json();
  await page.goto('/'); await page.getByRole('button', { name: 'Voice E2E A-level 数学' }).click();
  await page.getByRole('button', { name: '开始语音课堂' }).click();
  await expect(page.locator('.error[role=alert]')).toContainText('请先在设置中配置');
  await expect(page.getByRole('textbox', { name: '给老师的消息' })).toBeEnabled();
  await request.delete(`http://127.0.0.1:8100/api/teachers/${teacher.id}`);
});

test('bundled VAD detects synthetic speech and pauses native playback; stale frames and cleanup (mock cloud)', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const streamGetter = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const observed = { tracks: [] as MediaStreamTrack[], contexts: [] as AudioContext[], starts: 0, stops: 0 };
    const Native = window.AudioContext;
    let fixtureContext: AudioContext, destination: MediaStreamAudioDestinationNode;
    Object.assign(window, { voiceTest: observed, injectVoice: async () => {
      const data = await (await fetch('/voice-test.wav')).arrayBuffer();
      const buffer = await fixtureContext.decodeAudioData(data);
      const node = fixtureContext.createBufferSource(); node.buffer = buffer; node.connect(destination);
      await fixtureContext.resume(); node.start(); return performance.now();
    } });
    navigator.mediaDevices.getUserMedia = async constraints => {
      const original = await streamGetter(constraints); original.getTracks().forEach(t => t.stop());
      fixtureContext = new Native(); destination = fixtureContext.createMediaStreamDestination();
      const stream = destination.stream;
      stream.getTracks().forEach(track => { const stop = track.stop.bind(track); track.stop = () => { stop(); void fixtureContext.close(); }; });
      observed.tracks.push(...stream.getTracks()); return stream;
    };
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) { super(options); observed.contexts.push(this); }
      createBufferSource() { const node = super.createBufferSource(); const start = node.start.bind(node), stop = node.stop.bind(node);
        node.start = (...args: Parameters<typeof node.start>) => { observed.starts++; start(...args); };
        node.stop = (...args: Parameters<typeof node.stop>) => { observed.stops++; stop(...args); };
        return node;
      }
    };
  });
  await page.route('**/voice-test.wav', async route => route.fulfill({ contentType: 'audio/wav', body: await readFile('tests/fixtures/interruption-synthetic.wav') }));
  await page.route('**/api/voice/config', route => route.fulfill({ json: { missing: [] } }));
  await page.route('**/voice-ticket', route => route.fulfill({ json: { ticket: 'test-only' } }));
  let socket: import('@playwright/test').WebSocketRoute;
  const received: string[] = []; let beginAt = 0;
  await page.routeWebSocket('**/api/lessons/*/voice', ws => { socket = ws; ws.onMessage(data => {
    if (typeof data !== 'string') return;
    received.push(data);
    if (JSON.parse(data).type === 'begin') beginAt = Date.now();
    if (JSON.parse(data).ticket) ws.send(JSON.stringify({ type: 'ready' }));
  }); });
  const teacher = await (await request.post('http://127.0.0.1:8100/api/teachers', { data: { name: 'Voice Runtime E2E' } })).json();
  await page.goto('/'); await page.getByRole('button', { name: 'Voice Runtime E2E A-level 数学' }).click();
  await page.getByRole('button', { name: '开始语音课堂' }).click();
  await expect(page.getByRole('status').filter({ hasText: '正在听' })).toBeVisible({ timeout: 30000 });
  const send = (event: object) => socket.send(JSON.stringify(event));
  send({ type: 'turn', turn_id: 'one' }); send({ type: 'text', turn_id: 'one', delta: '先看 chain rule。' });
  send({ type: 'segment', turn_id: 'one', segment_id: '1', text: '先看 chain rule。' });
  // Quiet synthetic PCM validates browser playback machinery, not TTS quality.
  send({ type: 'audio', turn_id: 'one', segment_id: '1', pcm: Buffer.alloc(24000 * 2 * 15).toString('base64') });
  await expect(page.getByRole('status').filter({ hasText: '正在讲解' })).toBeVisible();
  const injectedAt = Date.now();
  await page.evaluate(() => (window as unknown as { injectVoice: () => Promise<number> }).injectVoice());
  await expect.poll(() => received.some(e => JSON.parse(e).type === 'begin'), { timeout: 10000 }).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { voiceTest: { contexts: AudioContext[] } }).voiceTest.contexts.map(c => c.state))).toEqual(['running', 'suspended']);
  await page.getByText('插话测量', { exact: true }).click();
  const metricText = await page.locator('.voice-metric p').innerText();
  await mkdir('../docs/voice-evaluation', { recursive: true });
  await writeFile('../docs/voice-evaluation/browser-synthetic.json', JSON.stringify({ stimulus: 'macOS Tingting synthetic Chinese speech injected into MediaStream; mock cloud; no physical microphone/speaker', injection_to_observed_begin_ms: beginAt - injectedAt, local_metric: metricText, physical_onset_to_speaker_stop_ms: null }, null, 2));
  await page.screenshot({ path: '../docs/voice-evaluation/voice-classroom.png' });
  await page.getByRole('button', { name: '立即停止老师' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { voiceTest: { stops: number } }).voiceTest.stops)).toBeGreaterThan(0);
  const count = await page.evaluate(() => (window as unknown as { voiceTest: { starts: number } }).voiceTest.starts);
  send({ type: 'audio', turn_id: 'one', segment_id: '1', pcm: Buffer.alloc(4800).toString('base64') });
  send({ type: 'text', turn_id: 'one', delta: '迟到内容不应出现' });
  await expect(page.getByText('迟到内容不应出现')).toHaveCount(0);
  await page.getByRole('button', { name: '麦克风静音', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消静音' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '结束语音', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始语音课堂' })).toBeVisible();
  expect(await page.evaluate(() => { const o = (window as unknown as { voiceTest: { tracks: MediaStreamTrack[]; contexts: AudioContext[]; starts: number } }).voiceTest; return { released: o.tracks.every(t => t.readyState === 'ended') && o.contexts.every(c => c.state === 'closed'), starts: o.starts }; })).toEqual({ released: true, starts: count });
  expect(errors).toEqual([]); expect(received.some(e => JSON.parse(e).type === 'stop')).toBe(true);
  await request.delete(`http://127.0.0.1:8100/api/teachers/${teacher.id}`);
});
