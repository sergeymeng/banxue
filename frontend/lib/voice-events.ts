/** UI coordination only: no credentials, raw audio, transcript, or provider protocol. */
export type VoiceState = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'paused';
export type VoiceEventData =
  | { type: 'state_changed'; state: VoiceState; turn_id: string | null }
  | { type: 'turn_started'; turn_id: string }
  | { type: 'candidate_paused'; turn_id: string | null; utterance_id: string }
  | { type: 'resumed'; turn_id: string; utterance_id: string | null; reason: 'recognition' | 'manual' }
  | { type: 'interruption_confirmed'; turn_id: string | null; utterance_id: string }
  | { type: 'turn_cancelled'; turn_id: string; reason: 'interruption' | 'typed_input' | 'manual_stop' | 'server' | 'replacement' | 'session_end' }
  | { type: 'playback_receipt'; turn_id: string; segment_id: string; status: 'completed' | 'interrupted'; elapsed_ms: number; alignment: 'approximate_segment_boundary' }
  | { type: 'session_ended' };
export type VoiceEvent = Readonly<VoiceEventData & { lesson_id: string; session_id: string; sequence: number; at_ms: number }>;
export type VoiceEventListener = (event: VoiceEvent) => void | Promise<void>;

/** Synchronous ordered fan-out; observer failure must never break audio/cancellation. No replay. */
export class VoiceEventHub {
  private listeners = new Set<VoiceEventListener>();
  subscribe = (listener: VoiceEventListener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  publish(event: VoiceEvent) {
    const value = Object.freeze(event);
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try { void Promise.resolve(listener(value)).catch(() => {}); } catch { /* Observer isolation. */ }
    }
  }
  clear() { this.listeners.clear(); }
}
