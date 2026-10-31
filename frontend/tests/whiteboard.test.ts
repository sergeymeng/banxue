import { describe, expect, it } from 'vitest';
import { BoardEngine, parseBatch, restore } from '../lib/whiteboard/engine';
import { elementSvg } from '../lib/whiteboard/render';
import type { BoardElement, BoardEvent } from '../lib/whiteboard/types';

const shape = (id = 'shape', author: 'teacher' | 'student' = 'teacher'): BoardElement => ({ id, author, kind: 'formula', x: 10, y: 20, width: 400, height: 100, text: 'y′ = 3x²' });
const batch = (id = 'batch', count = 3) => ({ version: 1, id, lessonId: 'lesson', actions: Array.from({ length: count }, (_, i) => ({ id: `${id}-action-${i}`, type: 'add', element: shape(`${id}-shape-${i}`) })) });

describe('bounded board action protocol', () => {
  it('rejects the whole batch atomically for unknown operations, fields and lessons', () => {
    const board = new BoardEngine('lesson');
    for (const invalid of [
      { ...batch(), lessonId: 'other' }, { ...batch(), version: 2 }, { ...batch(), code: 'fetch()' },
      { ...batch(), actions: [...batch().actions, { id: 'bad', type: 'eval', code: 'alert(1)' }] },
      { ...batch(), actions: [batch().actions[0], batch().actions[0]] },
    ]) { expect(() => board.enqueue(invalid)).toThrow(); expect(board.getQueue().steps).toHaveLength(0); }
  });
  it('rejects hostile geometry, authors, text, metadata and excessive counts', () => {
    for (const fields of [{ x: NaN }, { x: Infinity }, { width: -1 }, { x: 1599 }, { text: 'x'.repeat(401) }, { author: 'student' }, { sourceActionId: 'forged' }, { html: '<script/>' }, { kind: 'image', src: 'https://example.com' }]) {
      expect(() => parseBatch({ ...batch(), actions: [{ id: 'a', type: 'add', element: { ...shape(), ...fields } }] }, 'lesson')).toThrow();
    }
    expect(() => parseBatch(batch('too-many', 101), 'lesson')).toThrow();
    expect(() => parseBatch({ ...batch(), actions: [{ id: 'a', type: 'add', element: { ...shape(), kind: 'stroke', text: undefined, points: [{ x: 0, y: 0 }, { x: 20, y: 20 }] } }] }, 'lesson')).toThrow();
  });
  it('escapes formula/text markup in exported SVG', () => {
    expect(elementSvg({ ...shape(), text: '<script>alert("x")</script>&' })).not.toContain('<script>');
    expect(elementSvg({ ...shape(), text: '<script>' })).toContain('&lt;script&gt;');
  });
});

describe('queue, ownership and restoration', () => {
  it('executes atomic steps with receipts, pauses, resumes and cancels only pending', () => {
    const events: BoardEvent[] = [], board = new BoardEngine('lesson', undefined, e => events.push(e));
    board.enqueue(batch()); board.step(); board.pause(); board.step();
    expect(board.getSnapshot().elements).toHaveLength(1);
    expect(board.getQueue().steps[0]).toMatchObject({ status: 'executed', executedRevision: 1 });
    board.resume(); board.step(); board.cancel(); board.step();
    expect(board.getQueue().steps.map(s => s.status)).toEqual(['executed', 'executed', 'cancelled']);
    expect(events.filter(e => e.type === 'edit').map(e => e.author)).toEqual(['teacher', 'teacher']);
    expect(() => board.enqueue(batch())).toThrow();
  });
  it('does not let enqueue resume a paused or host-locked queue', () => {
    const board = new BoardEngine('lesson'); board.pause(); board.enqueue(batch()); board.step();
    expect(board.getSnapshot().revision).toBe(0);
    board.setLocked(true); expect(() => board.resume()).toThrow(); board.setLocked(false);
    board.step(); expect(board.getSnapshot().revision).toBe(0);
    board.resume(); board.step(); expect(board.getSnapshot().revision).toBe(1);
  });
  it('allows student ink between steps but rejects teacher erasing it, then pauses', () => {
    const board = new BoardEngine('lesson'); board.addStudent(shape('student', 'student'));
    board.enqueue({ ...batch(), actions: [{ id: 'erase', type: 'erase', elementIds: ['student'] }, ...batch().actions] });
    board.step(); expect(board.getQueue().state).toBe('paused');
    expect(board.getQueue().steps[0].status).toBe('failed');
    expect(board.getSnapshot().elements).toEqual([shape('student', 'student')]);
    board.resume(); board.step(); board.addStudent(shape('student-2', 'student')); board.step();
    expect(board.getSnapshot().elements.filter(e => e.author === 'student')).toHaveLength(2);
  });
  it('teacher erase is undoable; receipts never become pending after undo', () => {
    const board = new BoardEngine('lesson'); board.enqueue(batch('batch', 1)); board.step();
    board.enqueue({ ...batch('erase', 1), actions: [{ id: 'erase', type: 'erase', elementIds: ['batch-shape-0'] }] }); board.step();
    expect(board.getSnapshot().elements).toHaveLength(0); board.undo();
    expect(board.getSnapshot().elements).toHaveLength(1); board.redo();
    expect(board.getSnapshot().elements).toHaveLength(0);
    expect(board.getQueue().steps.every(s => s.status === 'executed')).toBe(true);
  });
  it('restores pending actions paused and never replays executed actions', () => {
    const board = new BoardEngine('lesson'); board.enqueue(batch()); board.step();
    const restored = new BoardEngine('lesson', board.getSnapshot()); restored.step();
    expect(restored.getSnapshot().elements).toHaveLength(1); expect(restored.getQueue().state).toBe('paused');
    restored.resume(); restored.step(); expect(restored.getSnapshot().elements).toHaveLength(2);
    expect(restored.getSnapshot().elements[0].sourceActionId).toBe('batch-action-0');
  });
  it('retains legacy JSON exactly and rejects invalid new-format snapshots', () => {
    const legacy = { document: { store: { 'shape:abc': { props: { text: 'retain me' } } } } };
    expect(() => restore(legacy)).toThrow(); const board = new BoardEngine('lesson'); board.archive(legacy);
    expect(new BoardEngine('lesson', board.getSnapshot()).getSnapshot().legacySnapshot).toEqual(legacy);
    expect(() => restore({ ...board.getSnapshot(), elements: [shape('unknown')] })).toThrow();
  });
  it('defensively copies snapshots and batches and invalidates disposed controllers', () => {
    const board = new BoardEngine('lesson'), b = batch(); board.enqueue(b); b.actions[0].element.text = 'mutated';
    board.step(); const snapshot = board.getSnapshot(); snapshot.elements.length = 0;
    expect(board.getSnapshot().elements[0].text).toBe('y′ = 3x²');
    board.dispose(); expect(() => board.enqueue(batch('later'))).toThrow(); expect(() => board.step()).toThrow();
  });
  it('temporary host busy state does not strand an empty queue', () => {
    const board = new BoardEngine('lesson'); board.setLocked(true); board.setLocked(false);
    board.enqueue(batch('later', 1)); board.step(); expect(board.getSnapshot().elements).toHaveLength(1);
  });
  it('subscriber exceptions cannot leave a drawn action marked failed', () => {
    const board = new BoardEngine('lesson', undefined, () => { throw new Error('subscriber'); });
    board.enqueue(batch('sub', 1)); board.step();
    expect(board.getQueue().steps[0].status).toBe('executed');
  });
  it('bounds persisted queue size before accepting a batch', () => {
    const board = new BoardEngine('lesson');
    const b = batch('large', 100);
    const actions = b.actions.map(a => ({ ...a, element: { id: a.element.id, author: 'teacher', kind: 'stroke', x: 0, y: 0, width: 1600, height: 1200, points: Array.from({ length: 2048 }, () => ({ x: 123.123456789, y: 234.123456789 })) } }));
    expect(() => board.enqueue({ ...b, actions })).toThrow('容量');
    expect(board.getQueue().steps).toHaveLength(0);
  });
  it('reserves IDs across undo and pending work', () => {
    const board = new BoardEngine('lesson'); board.enqueue(batch());
    expect(() => board.addStudent(shape('batch-shape-0', 'student'))).toThrow();
    board.step(); board.undo();
    expect(() => board.enqueue({ ...batch('new', 1), actions: [{ id: 'new', type: 'add', element: shape('batch-shape-0') }] })).toThrow();
  });
});
