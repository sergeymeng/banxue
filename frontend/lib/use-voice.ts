'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lesson, Turn } from './api';
import { VoiceEventHub } from './voice-events';
import { VoiceClient, type VoiceState } from './voice-client';

export function useVoice(lesson: Lesson | null, available: boolean, receive: (r: Turn) => void, error: (s: string) => void) {
  const [events] = useState(() => new VoiceEventHub());
  const client = useRef<VoiceClient | null>(null);
  const [state, setState] = useState<VoiceState>('off');
  const [transcript, setTranscript] = useState('');
  const [final, setFinal] = useState(false);
  const [text, setText] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [latency, setLatency] = useState<number>();
  const stop = useCallback(async () => { const current = client.current; setState('off'); setText(''); setTranscript(''); setFinal(false); setConfirmation(''); setMuted(false); await current?.close(); if (client.current === current) client.current = null; }, []);
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
    next.subscribe(event => { if (client.current === next) events.publish(event); });
    client.current = next; next.setVolume(volume); await next.start();
  };
  return { volume, setVolume: (value: number) => {setVolume(value); client.current?.setVolume(value);}, subscribe: events.subscribe, state, transcript, final, text, muted, latency, confirmation, confirm: () => client.current?.confirm(), active: state !== 'off', start, stop,
    send: (message: string, event: string) => client.current?.text(message, event),
    toggleMute: () => { client.current?.mute(!muted); setMuted(!muted); },
    stopTeacher: () => client.current?.stopTeacher(), resume: () => client.current?.resumeTeacher() };
}
