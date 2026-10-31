import { describe, expect, it } from 'vitest';
import { SpeechGate, TeacherAudio, pcm16 } from '../lib/voice-audio';
class Source {
  onended: (() => void) | null = null; buffer = null; stopped = false; startTime = 0;
  connect() {} disconnect() {} start(time: number) { this.startTime = time; } stop() { this.stopped = true; }
}
class Context {
  currentTime = 0; destination = {}; state = 'running'; sources: Source[] = []; gains: number[] = [];
  createGain() { return { gain: { setValueAtTime: (n: number) => this.gains.push(n) }, connect() {}, disconnect() {} }; }
  createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
  createBufferSource() { const node = new Source(); this.sources.push(node); return node; }
  async suspend() { this.state = 'suspended'; } async resume() { this.state = 'running'; } async close() { this.state = 'closed'; }
}
const audio = btoa('\0'.repeat(4800));
function player() {
  const context = new Context(), receipts: unknown[] = [];
  const teacher = new TeacherAudio(context as unknown as AudioContext, e => receipts.push(e), () => {});
  teacher.begin('one'); teacher.resume(); teacher.segment('one', '1', '第一句'); teacher.append('one', '1', audio);
  return { context, receipts, teacher };
}
describe('natural interruption control (synthetic probabilities, not human audio)', () => {
  it('pauses locally on 96ms credible speech with pre-roll before network; short silence stays one utterance', () => {
    const { teacher, context } = player(); const events: string[] = []; let preLength = 0;
    const gate = new SpeechGate(pre => { teacher.pause(); events.push(context.state); preLength = pre.length; }, () => {}, () => events.push('end'), () => {});
    for (let i = 0; i < 10; i++) gate.frame(.01, new Float32Array(512));
    gate.frame(.9, new Float32Array(512)); gate.frame(.9, new Float32Array(512)); expect(teacher.playing).toBe(true);
    gate.frame(.9, new Float32Array(512));
    expect(context.gains.at(-1)).toBe(0); expect(events).toEqual(['suspended']); expect(preLength).toBe(13);
    for (let i = 0; i < 20; i++) gate.frame(.01, new Float32Array(512));
    expect(gate.active).toBe(true);
    gate.frame(.9, new Float32Array(512));
    for (let i = 0; i < 44; i++) gate.frame(.01, new Float32Array(512));
    expect(events).toEqual(['suspended', 'end']);
  });
  it('rejects isolated probability spikes, bounds pre-roll and resets on mute', () => {
    let begins = 0, size = 0;
    const gate = new SpeechGate(pre => { begins++; size = pre.length; }, () => {}, () => {}, () => {});
    for (let i = 0; i < 100; i++) { gate.frame(.99, new Float32Array(512)); gate.frame(.01, new Float32Array(512)); }
    expect(begins).toBe(0);
    for (let i = 0; i < 3; i++) gate.frame(.9, new Float32Array(512));
    expect(size).toBeLessThanOrEqual(15); gate.reset(); expect(gate.active).toBe(false);
  });
  it('retains queue for provisional pause and resumes without resynthesizing', () => {
    const { teacher, context } = player(); teacher.pause();
    expect(context.sources[0].stopped).toBe(false); expect(teacher.pending).toBe(true);
    teacher.resume(); expect(teacher.playing).toBe(true); expect(context.sources).toHaveLength(1);
  });
  it('rejects stale audio after stop; repeated turns never overlap', () => {
    const { teacher, context } = player(); teacher.clear(); teacher.append('one', '1', audio); expect(context.sources).toHaveLength(1);
    for (const id of ['two', 'three', 'four']) {
      teacher.begin(id); teacher.resume(); teacher.segment(id, '1', id); teacher.append(id, '1', audio); teacher.append('one', '1', audio);
      expect(context.sources.filter(s => !s.stopped)).toHaveLength(1);
    }
  });
  it('records only played segments and releases sources/context', async () => {
    const { teacher, context, receipts } = player(); teacher.segment('one', '2', '排队句'); teacher.append('one', '2', audio);
    teacher.endSegment('one', '1'); expect(receipts).toHaveLength(0);
    context.currentTime = .05; teacher.pause(); expect(receipts).toMatchObject([{ status: 'interrupted', segment_id: '1' }]);
    teacher.resume(); context.sources[0].onended?.();
    expect(receipts).toMatchObject([{ status: 'interrupted' }, { status: 'completed', segment_id: '1' }]);
    await teacher.close(); expect(context.state).toBe('closed'); expect(context.sources[1].stopped).toBe(true);
    teacher.append('one', '2', audio); expect(context.sources).toHaveLength(2);
  });
  it('encodes little endian PCM with clamping', () => {
    expect([...new Int16Array(pcm16(new Float32Array([-2, 0, 2])))]).toEqual([-32768, 0, 32767]);
  });
});

it('volume changes preserve interruption silence and survive resume', () => {
  const {teacher, context} = player();
  teacher.setVolume(.35); expect(context.gains.at(-1)).toBe(.35);
  teacher.pause(); teacher.setVolume(.6); expect(context.gains.at(-1)).toBe(0);
  teacher.resume(); expect(context.gains.at(-1)).toBe(.6);
});
