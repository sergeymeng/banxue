import { expect, it, vi } from 'vitest';
import { ClassroomBoardBridge, type BoardLesson, type TeachingBoardAction } from '../lib/classroom-board';
import { BoardEngine } from '../lib/whiteboard/engine';
import type { BoardController } from '../lib/whiteboard/types';
const action = (id: string): TeachingBoardAction => ({ action_id: id, kind: 'write_math', text: 'y = (2x + 3)³', exercise_key: '0:GUIDED_PRACTICE', status: 'proposed' });
const lesson = (actions = [action('a'), action('b')]): BoardLesson => ({id: 'class', paused: false, state: 'GUIDED_PRACTICE', board_actions: actions});
function setup() {
  const report = vi.fn(async () => {}), error = vi.fn();
  const bridge = new ClassroomBoardBridge(report, error);
  const board = new BoardEngine('class', undefined, e => bridge.boardEvent(e));
  const controller: BoardController = {
    enqueue: b => board.enqueue(b), pause: () => board.pause(), resume: () => board.resume(), cancel: () => board.cancel(),
    getQueue: () => board.getQueue(), getSnapshot: () => board.getSnapshot(), undo: () => board.undo(), redo: () => board.redo(),
    flush: vi.fn(async () => {}), exportRegion: vi.fn(),
  };
  bridge.update(lesson()); bridge.attach(controller, 'class');
  return {bridge, board, controller, report, error};
}
it('executes real board actions once and saves before delivery', async () => {
  const {bridge, board, controller, report, error} = setup();
  expect(error).not.toHaveBeenCalled();
  board.step(); board.step(); await bridge.settled();
  expect(board.getSnapshot().elements).toHaveLength(2);
  expect(controller.flush).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.invocationCallOrder[0]).toBeGreaterThan((controller.flush as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
  bridge.update(lesson()); board.step(); await bridge.settled();
  expect(report).toHaveBeenCalledTimes(2);
  expect(board.getSnapshot().elements).toHaveLength(2);
});
it('pauses for a candidate, resumes a short response, cancels old pending steps for a question', async () => {
  const {bridge, board, report} = setup();
  board.step();
  bridge.voice({type: 'candidate_paused', lesson_id: 'class'}); board.step();
  expect(board.getSnapshot().elements).toHaveLength(1);
  bridge.voice({type: 'resumed', lesson_id: 'class'});
  expect(board.getQueue().state).toBe('running');
  bridge.voice({type: 'candidate_paused', lesson_id: 'class'});
  bridge.voice({type: 'interruption_confirmed', lesson_id: 'class'}); board.step();
  expect(board.getQueue().steps.map(s => s.status)).toEqual(['executed', 'cancelled']);
  await bridge.settled();
  expect(report).toHaveBeenLastCalledWith('class', [expect.objectContaining({action_id: 'b', status: 'cancelled'})]);
  bridge.voice({type: 'turn_started', lesson_id: 'class'});
  bridge.update(lesson([action('a'), action('b'), action('c')])); board.step();
  expect(board.getSnapshot().elements).toHaveLength(2);
  expect(board.getQueue().steps.filter(s => s.action.id === 'b')).toHaveLength(1);
});
it('ignores other lessons, preserves manual pause and student work', () => {
  const {bridge, board} = setup();
  board.addStudent({id: 'ink', author: 'student', kind: 'stroke', x: 900, y: 100, width: 100, height: 100,
    points: [{x: 900, y: 100}, {x: 1000, y: 200}]});
  bridge.voice({type: 'interruption_confirmed', lesson_id: 'other'});
  expect(board.getQueue().state).toBe('running');
  board.pause(); bridge.voice({type: 'candidate_paused', lesson_id: 'class'});
  bridge.voice({type: 'resumed', lesson_id: 'class'});
  expect(board.getQueue().state).toBe('paused');
  expect(board.getSnapshot().elements[0].id).toBe('ink');
});
it('ignores stale sessions and cancelled turn events after a new voice reply starts', () => {
  const {bridge, board} = setup();
  bridge.voice({type: 'state_changed', state: 'connecting', lesson_id: 'class', session_id: 'new', sequence: 1});
  bridge.voice({type: 'turn_started', lesson_id: 'class', session_id: 'new', turn_id: 'current', sequence: 2});
  bridge.voice({type: 'turn_cancelled', lesson_id: 'class', session_id: 'old', turn_id: 'old', sequence: 99});
  bridge.voice({type: 'turn_cancelled', lesson_id: 'class', session_id: 'new', turn_id: 'previous', sequence: 3});
  bridge.voice({type: 'candidate_paused', lesson_id: 'class', session_id: 'new', turn_id: 'current', sequence: 2});
  expect(board.getQueue().steps.every(s => s.status === 'pending')).toBe(true);
  expect(board.getQueue().state).toBe('running');
});
