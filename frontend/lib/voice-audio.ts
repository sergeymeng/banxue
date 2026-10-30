/** Local speech gate operates on Silero probabilities, never a raw volume threshold. */
export class SpeechGate {
  private pre: Float32Array[] = [];
  private positive = 0;
  private silence = 0;
  private duration = 0;
  active = false;
  constructor(private begin: (pre: Float32Array[]) => void, private chunk: (frame: Float32Array) => void,
    private end: () => void, private limit: () => void, private maxMs = 60000) {}
  frame(probability: number, frame: Float32Array) {
    const ms = frame.length / 16;
    if (!this.active) {
      this.pre.push(frame.slice());
      while (this.pre.reduce((n, f) => n + f.length, 0) > 7680) this.pre.shift();
      this.positive = probability >= .8 ? this.positive + ms : 0;
      if (this.positive >= 96) {
        this.active = true; this.silence = 0; this.duration = 0;
        this.begin(this.pre); this.pre = [];
      }
      return;
    }
    this.chunk(frame);
    this.duration += ms;
    this.silence = probability < .45 ? this.silence + ms : 0;
    if (this.duration >= this.maxMs - 600) { this.reset(); this.end(); this.limit(); }
    else if (this.silence >= 1400) { this.reset(); this.end(); }
  }
  reset() { this.pre = []; this.positive = this.silence = this.duration = 0; this.active = false; }
}

export function pcm16(frame: Float32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(frame.length * 2), view = new DataView(bytes);
  frame.forEach((v, i) => view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 32768 : 32767)), true));
  return bytes;
}

type Segment = { id: string; text: string; pending: number; ended: boolean; start?: number; end?: number; complete: boolean };
export type Receipt = { type: 'played'; turn_id: string; segment_id: string; status: 'completed' | 'interrupted'; elapsed_ms: number };
/** One teacher-only AudioContext. Suspend preserves playback position; gain=0 cuts sound synchronously. */
export class TeacherAudio {
  private gain: GainNode;
  private nodes = new Set<AudioBufferSourceNode>();
  private segments = new Map<string, Segment>();
  private cursor = 0;
  turn = '';
  paused = false;
  disposed = false;
  constructor(readonly context: AudioContext, private receipt: (v: Receipt) => void, private changed: () => void) {
    this.gain = context.createGain(); this.gain.connect(context.destination);
  }
  begin(turn: string) { this.clear(); this.turn = turn; }
  segment(turn: string, id: string, text: string) {
    if (turn !== this.turn || this.disposed) return;
    this.segments.set(id, { id, text, pending: 0, ended: false, complete: false });
  }
  append(turn: string, id: string, encoded: string) {
    if (turn !== this.turn || this.disposed) return;
    const segment = this.segments.get(id);
    if (!segment) return;
    const binary = atob(encoded);
    if (binary.length % 2) throw new Error('音频格式错误');
    if (this.cursor - this.context.currentTime > 90) throw new Error('播放队列已满，请停止老师后重试');
    const buffer = this.context.createBuffer(1, binary.length / 2, 24000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const x = binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
      data[i] = (x >= 32768 ? x - 65536 : x) / 32768;
    }
    const node = this.context.createBufferSource(); node.buffer = buffer; node.connect(this.gain);
    const start = Math.max(this.context.currentTime + .015, this.cursor);
    segment.start ??= start; segment.end = this.cursor = start + buffer.duration;
    segment.pending++; this.nodes.add(node);
    node.onended = () => {
      this.nodes.delete(node); node.disconnect();
      if (turn !== this.turn || this.disposed) return;
      segment.pending--; this.complete(segment); this.changed();
    };
    node.start(start); this.changed();
  }
  endSegment(turn: string, id: string) {
    if (turn !== this.turn) return;
    const segment = this.segments.get(id);
    if (segment) { segment.ended = true; this.complete(segment); }
  }
  private complete(segment: Segment) {
    if (segment.complete || !segment.ended || segment.pending || segment.start === undefined) return;
    segment.complete = true;
    this.receipt({ type: 'played', turn_id: this.turn, segment_id: segment.id, status: 'completed', elapsed_ms: Math.round(((segment.end || 0) - segment.start) * 1000) });
  }
  pause() {
    if (this.disposed || this.paused) return;
    this.paused = true;
    this.gain.gain.setValueAtTime(0, this.context.currentTime);
    void this.context.suspend();
    const current = [...this.segments.values()].find(s => !s.complete && s.start !== undefined && s.start <= this.context.currentTime && (s.end || 0) >= this.context.currentTime);
    if (current) this.receipt({ type: 'played', turn_id: this.turn, segment_id: current.id, status: 'interrupted', elapsed_ms: Math.max(0, Math.round((this.context.currentTime - current.start!) * 1000)) });
    this.changed();
  }
  resume() {
    if (this.disposed) return;
    this.paused = false;
    this.gain.gain.setValueAtTime(1, this.context.currentTime);
    void this.context.resume(); this.changed();
  }
  clear() {
    this.pause(); this.turn = '';
    for (const node of this.nodes) { node.onended = null; node.stop(); node.disconnect(); }
    this.nodes.clear(); this.segments.clear(); this.cursor = this.context.currentTime;
    this.changed();
  }
  get playing() { return !this.paused && this.nodes.size > 0; }
  get pending() { return this.nodes.size > 0; }
  async close() { if (this.disposed) return; this.clear(); this.disposed = true; this.gain.disconnect(); await this.context.close(); }
}
