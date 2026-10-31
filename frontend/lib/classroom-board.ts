import type { BoardController, BoardEvent, BoardSnapshot, Receipt } from './whiteboard/types';

export type TeachingBoardAction = {
  action_id: string; kind: string; text: string; exercise_key: string;
  status: 'proposed' | 'executed' | 'cancelled' | 'failed';
};
export type BoardLesson = { id: string; paused: boolean; state: string; board_actions?: TeachingBoardAction[] };
export type Delivery = { event_id: string; action_id: string; status: 'executed' | 'cancelled' | 'failed'; revision: number };
export type ClassroomVoiceEvent = { type: string; lesson_id: string; state?: string };

/** Connects three independently owned modules. It never interprets student answers. */
export class ClassroomBoardBridge {
  private controller: BoardController | null = null;
  private lesson: BoardLesson | null = null;
  private controllerLesson: string | null = null;
  private held = false;
  private resumeCandidate = false;
  private acknowledgements = new Set<string>();
  private delivery = Promise.resolve();
  constructor(private report: (lessonId: string, receipts: Delivery[]) => Promise<void>, private error: (message: string) => void) {}

  attach(controller: BoardController | null, lessonId: string | null) { this.controller = controller; this.controllerLesson = lessonId; this.sync(); }
  update(lesson: BoardLesson | null) {
    if (this.lesson?.id !== lesson?.id) { this.acknowledgements.clear(); this.held = false; this.resumeCandidate = false; }
    this.lesson = lesson; this.sync();
  }
  pauseForInput() { this.held = true; this.controller?.pause(); }
  inputSettled() { this.held = false; this.sync(); }
  voice(event: ClassroomVoiceEvent) {
    if (event.lesson_id !== this.lesson?.id || !this.controller) return;
    if (event.type === 'candidate_paused') {
      this.resumeCandidate = this.controller.getQueue().state === 'running';
      this.held = true; this.controller.pause();
    } else if (event.type === 'resumed') {
      this.held = false;
      if (this.resumeCandidate && !this.lesson.paused) this.controller.resume();
      this.resumeCandidate = false;
    } else if (event.type === 'interruption_confirmed' || event.type === 'turn_cancelled') {
      this.held = true; this.resumeCandidate = false; this.controller.cancel();
    } else if (event.type === 'turn_started') {
      this.held = false;
    } else if (event.type === 'session_ended') {
      this.held = true; this.controller.pause();
    }
  }
  boardEvent(event: BoardEvent) { if (event.type === 'queue') this.deliver(event.queue.steps); }
  settled() { return this.delivery; }

  private sync() {
    const board = this.controller, lesson = this.lesson;
    if (!board || !lesson || this.controllerLesson !== lesson.id) return;
    const actions = lesson.board_actions ?? [];
    if (lesson.paused || lesson.state === 'SESSION_SUMMARY') { board.pause(); return; }
    const queue = board.getQueue();
    const proposed = new Set(actions.filter(a => a.status === 'proposed').map(a => a.action_id));
    if (queue.steps.some(r => r.status === 'pending' && r.batchId.startsWith('lesson-') && !proposed.has(r.action.id))) board.cancel();
    const existing = new Set(board.getQueue().steps.map(r => r.action.id));
    let added = false;
    for (const action of actions) {
      if (action.status !== 'proposed' || existing.has(action.action_id) || !['write_math', 'write_text'].includes(action.kind)) continue;
      try {
        const element = placeTeachingText(board.getSnapshot(), action);
        board.enqueue({version: 1, id: `lesson-${lesson.id}-${action.action_id}`, lessonId: lesson.id,
          actions: [{id: action.action_id, type: 'add', element}]});
        added = true;
      } catch (e) { this.error((e as Error).message); break; }
    }
    if (this.held) board.pause();
    // Restored pending actions stay paused. Only newly proposed actions auto-start.
    else if (added) board.resume();
    this.deliver(board.getQueue().steps);
  }
  private deliver(steps: Receipt[]) {
    const board = this.controller, lesson = this.lesson;
    if (!board || !lesson || this.controllerLesson !== lesson.id) return;
    const ids = new Set((lesson.board_actions ?? []).map(a => a.action_id));
    const receipts: Delivery[] = [];
    for (const step of steps) {
      if (step.status === 'pending' || !ids.has(step.action.id)) continue;
      const key = `${step.action.id}:${step.status}`;
      if (this.acknowledgements.has(key)) continue;
      this.acknowledgements.add(key);
      receipts.push({event_id: `board:${key}`, action_id: step.action.id, status: step.status,
        revision: step.executedRevision ?? board.getSnapshot().revision});
    }
    if (!receipts.length) return;
    this.delivery = this.delivery.then(async () => {
      await board.flush();
      await this.report(lesson.id, receipts);
    }).catch((e: Error) => {
      for (const receipt of receipts) this.acknowledgements.delete(`${receipt.action_id}:${receipt.status}`);
      this.error(`板书状态尚未同步：${e.message}`);
    });
  }
}

export function placeTeachingText(snapshot: BoardSnapshot, action: TeachingBoardAction) {
  const text = action.text.slice(0, 400).split('\n').slice(0, 8).join('\n');
  // Reserve the left side for the teacher, leaving the right side available to write.
  const height = Math.max(70, text.split('\n').reduce((lines, line) => lines + Math.max(1, Math.ceil(Array.from(line).length / 30)), 0) * 32 + 20);
  const obstacles = [...snapshot.elements, ...snapshot.queue.steps.filter(s => s.status === 'pending' && s.action.type === 'add')
    .map(s => s.action.type === 'add' ? s.action.element : null).filter(e => e !== null)];
  let y = 44;
  while (y + height < 1160) {
    const overlap = obstacles.find(e => e.x < 780 && e.x + e.width > 44 && e.y < y + height + 16 && e.y + e.height + 16 > y);
    if (!overlap) return {id: `teaching-${action.action_id}`, kind: 'formula' as const, author: 'teacher' as const,
      x: 44, y, width: 720, height, text};
    y = overlap.y + overlap.height + 24;
  }
  throw new Error('老师板书区域已满，请擦除不再需要的内容后继续。');
}
