'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Lesson } from './api';
import { ClassroomBoardBridge, type ClassroomVoiceEvent } from './classroom-board';
import type { BoardController, BoardEvent } from './whiteboard/types';

export function useClassroomBoard(lesson: Lesson | null, onError: (message: string) => void,
  subscribe: (listener: (event: ClassroomVoiceEvent) => void) => () => void) {
  const error = useRef(onError); error.current = onError;
  const [bridge] = useState(() => new ClassroomBoardBridge(async (id, receipts) => {
    await api(`/api/lessons/${id}/board/receipts`, {method: 'POST', body: JSON.stringify({receipts})});
  }, message => error.current(message)));
  useEffect(() => { bridge.update(lesson); }, [bridge, lesson]);
  useEffect(() => subscribe(event => bridge.voice(event)), [bridge, subscribe]);
  const onReady = useCallback((controller: BoardController | null) => bridge.attach(controller, lesson?.id ?? null), [bridge, lesson?.id]);
  const onBoardEvent = useCallback((event: BoardEvent) => bridge.boardEvent(event), [bridge]);
  return { onReady, onBoardEvent, pauseForInput: () => bridge.pauseForInput(), inputSettled: () => bridge.inputSettled() };
}
