import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceClient } from '../lib/voice-client';
import { VoiceEventHub, type VoiceEvent } from '../lib/voice-events';

const vad = vi.hoisted(() => ({ frame: undefined as undefined | ((p: { isSpeech: number }, f: Float32Array) => void), destroy: vi.fn() }));
vi.mock('../lib/api', () => ({ API: 'http://127.0.0.1:8100', api: vi.fn(async (path: string) => path.endsWith('/config') ? { missing: [] } : { ticket: 'private-ticket' }) }));
vi.mock('@ricky0123/vad-web', () => ({ MicVAD: { new: vi.fn(async (options: { onFrameProcessed: typeof vad.frame }) => {
  vad.frame = options.onFrameProcessed; return { start: async () => {}, destroy: vad.destroy };
}) } }));
class Source {
  onended?: () => void; buffer?: AudioBuffer; stopped = false;
  connect() {} disconnect() {} start() {} stop() { this.stopped = true; }
}
class Context {
  static all: Context[] = [];
  currentTime = 0; destination = {}; state = 'running'; sources: Source[] = [];
  constructor() { Context.all.push(this); }
  createGain() { return { gain: { setValueAtTime() {} }, connect() {}, disconnect() {} }; }
  createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  async suspend() { this.state = 'suspended'; } async resume() { this.state = 'running'; } async close() { this.state = 'closed'; }
}
class Socket {
  static all: Socket[] = []; static OPEN = 1;
  readyState = 1; bufferedAmount = 0; sent: Record<string, unknown>[] = [];
  onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void;
  constructor() { Socket.all.push(this); queueMicrotask(() => this.onopen?.()); }
  send(data: string | ArrayBuffer) {
    if (typeof data !== 'string') return;
    const body = JSON.parse(data); this.sent.push(body);
    if (body.ticket) queueMicrotask(() => this.emit({ type: 'ready' }));
  }
  emit(body: object) { this.onmessage?.({ data: JSON.stringify(body) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const callbacks = () => ({ status: vi.fn(), text: vi.fn(), transcript: vi.fn(), confirmation: vi.fn(), result: vi.fn(), error: vi.fn(), metric: vi.fn() });
const clients: VoiceClient[] = [];
beforeEach(() => {
  Socket.all = []; Context.all = []; vad.destroy.mockClear();
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { href: 'http://127.0.0.1:3100' });
  const track = { enabled: true, stop: vi.fn(), addEventListener() {} };
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } });
});
afterEach(async () => { await Promise.all(clients.splice(0).map(c => c.close())); vi.unstubAllGlobals(); });
async function setup() {
  const cb = callbacks(), client = new VoiceClient('lesson-a', cb), events: VoiceEvent[] = [];
  clients.push(client); client.subscribe(e => { events.push(e); }); await client.start();
  const socket = Socket.all.at(-1)!;
  const server = async (body: object) => { socket.emit(body); for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const reply = async (id: string) => {
    await server({ type: 'turn', turn_id: id }); await server({ type: 'segment', turn_id: id, segment_id: '1', text: 'private content' });
    await server({ type: 'audio', turn_id: id, segment_id: '1', pcm: btoa('\0'.repeat(4800)) });
  };
  const frame = (p: number, n: number) => { for (let i = 0; i < n; i++) vad.frame?.({ isSpeech: p }, new Float32Array(512)); };
  return { client, cb, events, socket, server, reply, frame };
}

describe('public voice events (simulated browser and provider)', () => {
  it('publishes local candidate pause before network begin; acknowledgement resumes without cancelling', async () => {
    const { client, events, socket, server, reply, frame } = await setup(); await reply('r1');
    let candidateSawPause = false;
    client.subscribe(event => {
      if (event.type === 'candidate_paused') candidateSawPause = Context.all[1].state === 'suspended' && !socket.sent.some(v => v.type === 'begin');
    });
    Context.all[1].currentTime = .05; frame(.99, 3);
    expect(candidateSawPause).toBe(true);
    const candidate = events.find(e => e.type === 'candidate_paused')!;
    expect(candidate).toMatchObject({ turn_id: 'r1', lesson_id: 'lesson-a' });
    frame(0, 44);
    await server({ type: 'recognized', utterance_id: candidate.type === 'candidate_paused' && candidate.utterance_id, text: '嗯', disposition: 'ack' });
    await server({ type: 'resume', turn_id: 'r1', utterance_id: candidate.type === 'candidate_paused' && candidate.utterance_id });
    expect(events.filter(e => e.type === 'resumed')).toHaveLength(1);
    expect(events.some(e => e.type === 'turn_cancelled')).toBe(false);
    expect(events.filter(e => e.type === 'state_changed').map(e => e.state)).toEqual(expect.arrayContaining(['connecting', 'listening', 'thinking', 'speaking']));
    expect(events.find(e => e.type === 'playback_receipt')).toMatchObject({ status: 'interrupted', elapsed_ms: 35, alignment: 'approximate_segment_boundary' });
  });
  it('confirms and cancels exactly once; stale results cannot notify observers or replay', async () => {
    const { events, server, reply, frame, cb } = await setup(); await reply('r1'); frame(.99, 3); frame(0, 44);
    const candidate = events.find(e => e.type === 'candidate_paused');
    if (candidate?.type !== 'candidate_paused') throw Error('missing candidate');
    await server({ type: 'recognized', utterance_id: candidate.utterance_id, text: '为什么', disposition: 'question' });
    const confirm = events.findIndex(e => e.type === 'interruption_confirmed');
    expect(events.slice(confirm + 1).find(e => e.type === 'turn_cancelled')).toMatchObject({ type: 'turn_cancelled', turn_id: 'r1', reason: 'interruption' });
    await server({ type: 'cancelled', turn_id: 'r1' }); await reply('r2');
    const before = events.length, texts = cb.text.mock.calls.length;
    await server({ type: 'audio', turn_id: 'r1', segment_id: '1', pcm: btoa('\0'.repeat(4800)) });
    await server({ type: 'text', turn_id: 'r1', delta: 'late' });
    expect(events).toHaveLength(before); expect(cb.text).toHaveBeenCalledTimes(texts);
    expect(events.filter(e => e.type === 'turn_cancelled')).toHaveLength(1);
    expect(Context.all[1].sources.filter(s => !s.stopped)).toHaveLength(1);
  });
  it('completed receipt follows playback, not text or queue; stop/close deduplicate and end listeners', async () => {
    const { client, events, server, reply } = await setup(); await reply('r1');
    await server({ type: 'segment_end', turn_id: 'r1', segment_id: '1' });
    expect(events.filter(e => e.type === 'playback_receipt')).toHaveLength(0);
    Context.all[1].sources[0].onended?.();
    expect(events.find(e => e.type === 'playback_receipt')).toMatchObject({ status: 'completed', segment_id: '1' });
    client.stopTeacher(); await server({ type: 'cancelled', turn_id: 'r1' });
    expect(events.filter(e => e.type === 'turn_cancelled')).toHaveLength(1);
    const first = client.close(), second = client.close(); expect(first).toBe(second); await first;
    expect(events.filter(e => e.type === 'session_ended')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'state_changed', state: 'off' });
    expect(Context.all.every(c => c.state === 'closed')).toBe(true);
    const after = events.length; await server({ type: 'turn', turn_id: 'late' }); expect(events).toHaveLength(after);
    expect(JSON.stringify(events)).not.toMatch(/private-ticket|private content|pcm/);
    expect(new Set(events.map(e => e.session_id)).size).toBe(1);
    expect(events.map(e => e.sequence)).toEqual(events.map((_, i) => i + 1));
  });
  it('typed correction invalidates in-flight recognition events; manual resume is emitted once', async () => {
    const { client, events, server, reply, frame } = await setup(); await reply('r1'); frame(.99, 3);
    const candidate = events.find(e => e.type === 'candidate_paused');
    if (candidate?.type !== 'candidate_paused') throw Error('missing candidate');
    client.text('typed correction'); await reply('r2');
    const before = events.length;
    await server({ type: 'recognized', utterance_id: candidate.utterance_id, disposition: 'question', text: 'late transcript' });
    await server({ type: 'resume', turn_id: 'r1', utterance_id: candidate.utterance_id });
    expect(events).toHaveLength(before);
    frame(.99, 3); frame(0, 44); client.resumeTeacher();
    await server({ type: 'resume', turn_id: 'r2' });
    expect(events.filter(e => e.type === 'resumed')).toMatchObject([{ turn_id: 'r2', reason: 'manual' }]);
    expect(events.filter(e => e.type === 'turn_cancelled')).toMatchObject([{ turn_id: 'r1', reason: 'typed_input' }]);
  });
  it('listener failures and unsubscribe do not break other observers or playback', async () => {
    const { client, events, reply } = await setup();
    client.subscribe(() => { throw Error('observer'); }); client.subscribe(async () => { throw Error('async observer'); });
    const removed = vi.fn(), remove = client.subscribe(removed); remove(); remove();
    client.subscribe(event => { (event as { lesson_id: string }).lesson_id = 'changed'; });
    await reply('r1');
    expect(removed).not.toHaveBeenCalled(); expect(events.every(e => e.lesson_id === 'lesson-a')).toBe(true);
    expect(Context.all[1].sources).toHaveLength(1);
    const hub = new VoiceEventHub(), heard = vi.fn(); hub.subscribe(heard); hub.clear(); hub.publish(events[0]); expect(heard).not.toHaveBeenCalled();
  });
});
