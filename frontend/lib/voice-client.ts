import { api, API, type Turn } from './api';
import { SpeechGate, TeacherAudio, pcm16 } from './voice-audio';
import { VoiceEventHub, type VoiceEventData, type VoiceEventListener, type VoiceState } from './voice-events';
export type { VoiceState } from './voice-events';
import type { MicVAD } from '@ricky0123/vad-web';

type Callbacks = { status: (s: VoiceState) => void; text: (s: string) => void; transcript: (s: string, final: boolean) => void;
  confirmation: (s: string) => void; result: (r: Turn) => void; error: (s: string) => void; metric: (ms: number) => void };
export class VoiceClient {
  private events = new VoiceEventHub();
  private sessionId = crypto.randomUUID();
  private sequence = 0;
  private lastState?: VoiceState;
  private ws?: WebSocket;
  private vad?: MicVAD;
  private mic?: MediaStream;
  private capture?: AudioContext;
  private player?: TeacherAudio;
  private gate?: SpeechGate;
  private closed = false;
  private closing?: Promise<void>;
  private muted = false;
  private ready = false;
  private reply = '';
  private turn = '';
  private utterance = '';
  private generating = false;
  private accepting = true;
  private limitTimer?: ReturnType<typeof setTimeout>;
  private receiveChain = Promise.resolve();
  constructor(private lesson: string, private cb: Callbacks) {}
  subscribe(listener: VoiceEventListener) { return this.closed ? () => {} : this.events.subscribe(listener); }
  private emit(data: VoiceEventData) {
    this.events.publish({ ...data, lesson_id: this.lesson, session_id: this.sessionId, sequence: ++this.sequence, at_ms: performance.now() });
  }
  private status(state: VoiceState) {
    if (this.lastState !== state) { this.lastState = state; this.emit({ type: 'state_changed', state, turn_id: this.turn || null }); }
    this.cb.status(state);
  }
  private cancelTurn(reason: Extract<VoiceEventData, { type: 'turn_cancelled' }>['reason']) {
    const turn = this.turn;
    this.player?.clear(); this.turn = ''; this.generating = false;
    if (turn) this.emit({ type: 'turn_cancelled', turn_id: turn, reason });
  }
  private resumePlayback(reason: 'recognition' | 'manual') {
    const paused = this.player?.paused;
    this.player?.resume();
    if (paused && this.turn) this.emit({ type: 'resumed', turn_id: this.turn, utterance_id: this.utterance || null, reason });
  }
  private send(body: object) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(body)); }
  private state() {
    if (this.closed) return;
    this.status(this.player?.paused && (this.player.pending || this.generating) ? 'paused' : this.player?.playing ? 'speaking' : this.generating ? 'thinking' : 'listening');
  }
  async start() {
    this.status('connecting');
    try {
      const config = await api<{ missing: string[] }>('/api/voice/config');
      if (config.missing.length) throw new Error('请先在设置中配置：' + config.missing.join('、'));
      if (this.closed) return;
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (this.closed) { this.mic.getTracks().forEach(t => t.stop()); return; }
      this.mic.getAudioTracks().forEach(track => { track.enabled = !this.muted; track.addEventListener('ended', () => this.fail('麦克风已断开，请重新连接设备后开始语音。')); });
      this.capture = new AudioContext();
      this.player = new TeacherAudio(new AudioContext(), receipt => {
        if (receipt.turn_id !== this.turn) return;
        this.emit({ ...receipt, type: 'playback_receipt', alignment: 'approximate_segment_boundary' });
        this.send(receipt);
      }, () => this.state());
      await this.player.context.resume();
      const { MicVAD } = await import('@ricky0123/vad-web');
      if (this.closed) return;
      this.gate = new SpeechGate(pre => {
        const start = performance.now();
        this.player?.pause(); // Local cut happens BEFORE any network operation.
        this.cb.metric(performance.now() - start);
        this.utterance = crypto.randomUUID();
        this.emit({ type: 'candidate_paused', turn_id: this.turn || null, utterance_id: this.utterance });
        this.send({ type: 'begin', utterance_id: this.utterance });
        pre.forEach(frame => this.audio(frame));
        this.cb.transcript('', false); this.cb.confirmation(''); this.status('listening');
      }, frame => this.audio(frame), () => {
        this.send({ type: 'audio_end' }); this.status('thinking');
      }, () => { this.mute(true); this.cb.error('单次发言已到 60 秒，麦克风已静音。等待回复后可取消静音继续。'); });
      this.vad = await MicVAD.new({ model: 'v5', startOnLoad: false, audioContext: this.capture,
        baseAssetPath: '/voice/', onnxWASMBasePath: '/voice/', processorType: 'AudioWorklet',
        ortConfig: ort => { ort.env.wasm.numThreads = 1; },
        getStream: async () => this.mic!, pauseStream: async () => {}, resumeStream: async () => this.mic!,
        onFrameProcessed: (probabilities, frame) => { if (this.ready && !this.muted && !this.closed) this.gate?.frame(probabilities.isSpeech, frame); },
      });
      if (this.closed) { await this.vad.destroy(); return; }
      const { ticket } = await api<{ ticket: string }>(`/api/lessons/${this.lesson}/voice-ticket`, { method: 'POST' });
      if (this.closed) return;
      const url = new URL(`${API}/api/lessons/${this.lesson}/voice`, location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = this.ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('语音连接超时。')), 10000);
        ws.onopen = () => this.send({ ticket });
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('语音连接失败，请检查本机服务。')); };
        ws.onclose = () => {
          clearTimeout(timeout);
          if (!this.ready) reject(new Error('语音授权失败或课堂已被其他窗口使用。'));
          if (!this.closed) this.fail('语音连接已断开；麦克风已释放，可继续打字。');
        };
        ws.onmessage = message => {
          const event = JSON.parse(message.data);
          if (event.type === 'ready') { clearTimeout(timeout); this.ready = true; resolve(); }
          else this.receiveChain = this.receiveChain.then(() => this.receive(event)).catch(() => this.fail('语音数据处理失败，请重新开始。'));
        };
      });
      if (this.closed) return;
      await this.vad.start(); this.status('listening');
      this.limitTimer = setTimeout(() => this.fail('语音课堂已达 30 分钟，请重新开始以继续。'), 1800000);
    } catch (error) {
      const name = (error as Error).name;
      this.fail(name === 'NotAllowedError' ? '麦克风权限被拒绝。请在系统隐私设置中允许伴学使用麦克风。' : name === 'NotFoundError' ? '没有找到麦克风。' : (error as Error).message || '语音初始化失败。');
    }
  }
  private audio(frame: Float32Array) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > 256000) { this.fail('网络发送积压，语音已停止，未自动重试。'); return; }
    this.ws.send(pcm16(frame));
  }
  private async receive(event: Record<string, unknown>) {
    if (this.closed) return;
    const type = event.type;
    if (type === 'transcript' && event.utterance_id === this.utterance) this.cb.transcript(String(event.text), !!event.final);
    if (type === 'recognized' && event.utterance_id === this.utterance) {
      this.cb.transcript(String(event.text), true);
      if (event.disposition === 'question') {
        this.emit({ type: 'interruption_confirmed', turn_id: this.turn || null, utterance_id: this.utterance });
        this.cancelTurn('interruption'); this.accepting = true;
      }
    }
    if (type === 'confirmation' && event.utterance_id === this.utterance) { this.cb.confirmation(String(event.message)); this.status('paused'); }
    if (type === 'resume' && (!event.utterance_id || event.utterance_id === this.utterance) && event.turn_id === this.turn && !this.gate?.active) this.resumePlayback('recognition');
    if (type === 'turn') {
      if (!this.accepting) return;
      this.cancelTurn('replacement');
      this.turn = String(event.turn_id); this.reply = ''; this.generating = true;
      this.emit({ type: 'turn_started', turn_id: this.turn });
      this.player?.begin(this.turn);
      if (!this.gate?.active) this.player?.resume();
      this.cb.text(''); this.state(); return;
    }
    if (type === 'error') { this.player?.pause(); this.generating = false; this.cb.error(String(event.message)); this.status('paused'); return; }
    if (event.turn_id !== this.turn || !this.accepting) return;
    if (type === 'text') { this.reply += String(event.delta); this.cb.text(this.reply); }
    if (type === 'segment') this.player?.segment(this.turn, String(event.segment_id), String(event.text));
    if (type === 'audio') this.player?.append(this.turn, String(event.segment_id), String(event.pcm));
    if (type === 'segment_end') this.player?.endSegment(this.turn, String(event.segment_id));
    if (type === 'result') { this.cb.result(event.result as Turn); this.cb.text(''); }
    if (type === 'tts_error') { this.cb.error(String(event.message)); }
    if (type === 'cancelled') { this.cancelTurn('server'); this.state(); }
    if (type === 'turn_end') { this.generating = false; this.state(); }
  }
  confirm() { this.cb.confirmation(''); this.accepting = true; this.send({ type: 'confirm', utterance_id: this.utterance }); }
  text(text: string, event = 'message') {
    if (!this.ready || this.closed) { this.cb.error('语音尚未连接，请稍候或结束语音后打字。'); return false; }
    this.cb.confirmation('');
    this.cancelTurn('typed_input'); this.accepting = true;
    this.utterance = ''; this.gate?.reset(); this.send({ type: 'text', text, event });
    this.status('thinking'); return true;
  }
  stopTeacher() {
    this.accepting = false; this.cancelTurn('manual_stop');
    this.send({ type: 'stop' }); this.cb.text(''); this.status('paused');
  }
  resumeTeacher() {
    if (!this.player?.pending && !this.generating) { this.text('请从实际听到的位置继续讲解。', 'topic'); return; }
    this.accepting = true; this.send({ type: 'resume' }); this.resumePlayback('manual');
  }
  mute(muted: boolean) {
    this.muted = muted;
    this.mic?.getTracks().forEach(t => { t.enabled = !muted; });
    if (muted && this.gate?.active) this.send({ type: 'audio_end' });
    this.gate?.reset();
  }
  private fail(message: string) { if (this.closed) return; this.cb.error(message); void this.close(); }
  close() { return this.closing ??= this.dispose(); }
  private async dispose() {
    if (this.closed) return;
    this.closed = true; this.ready = false; clearTimeout(this.limitTimer);
    this.cancelTurn('session_end'); this.send({ type: 'end' }); this.ws?.close();
    this.mic?.getTracks().forEach(t => t.stop()); this.gate?.reset();
    await Promise.allSettled([this.vad?.destroy(), this.capture?.close(), this.player?.close()]);
    this.emit({ type: 'session_ended' }); this.status('off'); this.events.clear();
  }
}
