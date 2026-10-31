import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

export const backend = 'http://127.0.0.1:8100';
export type Trace = { type: string; at: number; turn_id?: string; utterance_id?: string; segment_id?: string; disposition?: string; final?: boolean };
export type Probe = { events: Trace[]; contexts: AudioContext[]; tracks: MediaStreamTrack[]; starts: number; stops: number;
  maxOverlap: number; activeSources: Set<AudioBufferSourceNode>; mic: (kind?: string) => Promise<void>; unplug: () => void };
declare global { interface Window { voiceSim: Probe } }
export type SimWindow = Window;

export async function scenario(request: APIRequestContext, values: Record<string, unknown> = {}) {
  const response = await request.post(backend + '/__simulation/scenario', { data: values });
  expect(response.ok()).toBe(true);
}
export async function boot(page: Page, request: APIRequestContext) {
  await page.addInitScript(() => {
    const events: { type: string; at: number; turn_id?: string; utterance_id?: string; segment_id?: string; disposition?: string; final?: boolean }[] = [];
    const contexts: AudioContext[] = [], tracks: MediaStreamTrack[] = [];
    const NativeAudio = window.AudioContext, NativeWS = window.WebSocket;
    let fixture: AudioContext, destination: MediaStreamAudioDestinationNode;
    const scheduled = new Map<AudioBufferSourceNode, { start: number; end: number }>();
    const probe = { events, contexts, tracks, starts: 0, stops: 0, maxOverlap: 0, activeSources: new Set<AudioBufferSourceNode>(),
      mic: async (kind = 'speech') => {
        let buffer: AudioBuffer;
        if (kind === 'noise') {
          buffer = fixture.createBuffer(1, 16000, 16000);
          // Deterministic sparse keyboard-like clicks; no claim of a real cough/noise benchmark.
          const data = buffer.getChannelData(0);
          for (let i = 0; i < data.length; i += 1600) for (let j = 0; j < 80; j++) data[i + j] = .08 * Math.sin(j * 2.13) * Math.exp(-j / 10);
        } else {
          const full = await fixture.decodeAudioData(await (await fetch('/voice-simulation-fixture.wav')).arrayBuffer());
          const duration = kind === 'pause' ? 1.6 : .85;
          buffer = fixture.createBuffer(1, Math.round(full.sampleRate * duration), full.sampleRate);
          buffer.getChannelData(0).set(full.getChannelData(0).subarray(0, buffer.length));
          if (kind === 'pause') buffer.getChannelData(0).fill(0, Math.round(.5 * full.sampleRate), Math.round(1.05 * full.sampleRate));
        }
        const source = fixture.createBufferSource(), gain = fixture.createGain();
        source.buffer = buffer; gain.gain.value = kind === 'echo' ? .03 : 1;
        source.connect(gain); gain.connect(destination);
        await fixture.resume(); events.push({ type: 'injected_' + kind, at: performance.now() }); source.start();
      },
      unplug: () => tracks.forEach(track => track.dispatchEvent(new Event('ended'))),
    };
    Object.assign(window, { voiceSim: probe });
    const originalGetStream = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const original = await originalGetStream(constraints); original.getTracks().forEach(t => t.stop());
      fixture = new NativeAudio(); destination = fixture.createMediaStreamDestination();
      destination.stream.getTracks().forEach(track => { const stop = track.stop.bind(track); track.stop = () => { stop(); void fixture.close(); }; });
      tracks.push(...destination.stream.getTracks()); return destination.stream;
    };
    window.AudioContext = class extends NativeAudio {
      constructor(options?: AudioContextOptions) { super(options); contexts.push(this); }
      suspend() { events.push({ type: 'local_suspend', at: performance.now() }); return super.suspend(); }
      createBufferSource() {
        const source = super.createBufferSource(), start = source.start.bind(source), stop = source.stop.bind(source);
        source.start = (...args: Parameters<typeof start>) => {
          const at = args[0] || this.currentTime, end = at + (source.buffer?.duration || 0);
          const overlap = [...scheduled.values()].filter(s => s.end > at + .00001 && s.start < end - .00001).length;
          probe.maxOverlap = Math.max(probe.maxOverlap, overlap + 1);
          scheduled.set(source, { start: at, end });
          probe.starts++; probe.activeSources.add(source); start(...args);
        };
        source.stop = (...args: Parameters<typeof stop>) => { probe.stops++; probe.activeSources.delete(source); scheduled.delete(source); stop(...args); };
        source.addEventListener('ended', () => { probe.activeSources.delete(source); scheduled.delete(source); });
        return source;
      }
    };
    window.WebSocket = class extends NativeWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (String(url).endsWith('/voice')) this.addEventListener('message', event => {
          const body = JSON.parse(event.data);
          const { type, turn_id, utterance_id, segment_id, disposition, final } = body;
          events.push({ type, turn_id, utterance_id, segment_id, disposition, final, at: performance.now() });
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string' && String(this.url).endsWith('/voice')) {
          const body = JSON.parse(data);
          if (body.type) events.push({ type: 'send_' + body.type, at: performance.now(), turn_id: body.turn_id, utterance_id: body.utterance_id });
        }
        super.send(data);
      }
    };
    // Visible label belongs only to the test harness; no production "fake live" option.
    addEventListener('DOMContentLoaded', () => {
      const label = document.createElement('div'); label.textContent = '语音仿真 · 本地模拟供应商 · 不调用云端';
      Object.assign(label.style, { position: 'fixed', bottom: '0', left: '0', background: '#fff3ce', zIndex: '99999', padding: '4px 12px', fontSize: '12px' });
      document.body.append(label);
    });
  });
  // Browser never accesses an external origin. All model calls use simulated backend transports.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient');
  });
  await page.route('**/voice-simulation-fixture.wav', async route => route.fulfill({ contentType: 'audio/wav', body: await readFile('tests/fixtures/interruption-synthetic.wav') }));
  await scenario(request);
  const teacher = await (await request.post(backend + '/api/teachers', { data: { name: '语音仿真 SIM' } })).json();
  await page.goto('/');
  await page.evaluate(id => localStorage.setItem('banxue.lastTeacher', id), teacher.id); await page.reload();
  await expect(page.locator('.chat-header strong')).toHaveText('语音仿真 SIM');
  const lessons = await (await request.get(`${backend}/api/teachers/${teacher.id}/lessons`)).json();
  await page.getByRole('button', { name: '开始语音课堂' }).click();
  await expect(page.getByRole('status').filter({ hasText: '正在听' })).toBeVisible({ timeout: 30000 });
  return { teacher: teacher.id as string, lesson: lessons[0].id as string };
}
export async function events(page: Page) { return page.evaluate(() => (window as SimWindow).voiceSim.events); }
export async function count(page: Page, type: string) { return (await events(page)).filter(e => e.type === type).length; }
export async function inject(page: Page, kind = 'speech') { await page.evaluate(k => (window as SimWindow).voiceSim.mic(k), kind); }
export async function typed(page: Page, text = '为什么用 chain rule') {
  const input = page.getByRole('textbox', { name: '给老师的消息' }); await input.fill(text); await input.press('Enter');
}
export async function playing(page: Page) { await expect(page.getByRole('status').filter({ hasText: '正在讲解' })).toBeVisible(); }
export async function stopped(page: Page) {
  await expect(page.getByRole('button', { name: '开始语音课堂' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => { const p = (window as SimWindow).voiceSim; return p.tracks.every(t => t.readyState === 'ended') && p.contexts.every(c => c.state === 'closed'); })).toBe(true);
}
export async function finish(page: Page, request: APIRequestContext, info: TestInfo, ids: { teacher: string; lesson: string }) {
  if (await page.getByRole('button', { name: '结束语音', exact: true }).isVisible()) await page.getByRole('button', { name: '结束语音', exact: true }).click();
  await stopped(page);
  await expect.poll(async () => (await (await request.get(backend + '/__simulation/state')).json()).sessions).toBe(0);
  const state = await (await request.get(backend + '/__simulation/state')).json();
  expect(state.active).toEqual({ asr: 0, llm: 0, tts: 0 }); expect(state.paid_calls).toBe(0);
  const usage = await (await request.get(`${backend}/api/lessons/${ids.lesson}/usage`)).json();
  const playback = await page.evaluate(() => ({ maxScheduledOverlap: window.voiceSim.maxOverlap, starts: window.voiceSim.starts, stops: window.voiceSim.stops }));
  expect(playback.maxScheduledOverlap).toBeLessThanOrEqual(1);
  const tracePath = info.outputPath('simulation-trace.json');
  await writeFile(tracePath, JSON.stringify({ simulation: true, human_audio_verified: false, provider_verified: false, client: await events(page), playback, server: state, usage }, null, 2));
  await info.attach('simulation-trace', { contentType: 'application/json', path: tracePath });
  await request.delete(`${backend}/api/teachers/${ids.teacher}`);
  return usage;
}
