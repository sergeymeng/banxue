'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lesson, Turn } from './api';
import { VoiceClient, type VoiceState } from './voice-client';

export function useVoice(lesson: Lesson | null, available: boolean, receive: (r: Turn) => void, error: (s: string) => void) {
  const client = useRef<VoiceClient | null>(null);
  const [state, setState] = useState<VoiceState>('off');
  const [transcript, setTranscript] = useState('');
  const [final, setFinal] = useState(false);
  const [text, setText] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [muted, setMuted] = useState(false);
  const [latency, setLatency] = useState<number>();
  const stop = useCallback(async () => { const current = client.current; client.current = null; setState('off'); setText(''); setConfirmation(''); setMuted(false); await current?.close(); }, []);
  useEffect(() => { if (!available || lesson?.state === 'SESSION_SUMMARY' || lesson?.paused) void stop(); }, [available, lesson?.state, lesson?.paused, stop]);
  useEffect(() => () => { void stop(); }, [lesson?.id, stop]);
  const start = async () => {
    if (!lesson || client.current) return;
    setTranscript(''); setText(''); setConfirmation(''); setMuted(false);
    const next = new VoiceClient(lesson.id, {
      status: value => { if (client.current !== next) return; setState(value); if (value === 'off') client.current = null; },
      text: value => { if (client.current === next) setText(value); },
      transcript: (value, done) => { if (client.current === next) { setTranscript(value); setFinal(done); } },
      confirmation: value => { if (client.current === next) setConfirmation(value); },
      result: value => { if (client.current === next) receive(value); },
      error: value => { if (client.current === next) error(value); },
      metric: value => { if (client.current === next) setLatency(value); },
    });
    client.current = next; await next.start();
  };
  return { state, transcript, final, text, muted, latency, confirmation, confirm: () => client.current?.confirm(), active: state !== 'off', start, stop,
    send: (message: string, event: string) => client.current?.text(message, event),
    toggleMute: () => { client.current?.mute(!muted); setMuted(!muted); },
    stopTeacher: () => client.current?.stopTeacher(), resume: () => client.current?.resumeTeacher() };
}
