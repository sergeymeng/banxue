import { expect, it, vi } from 'vitest';
import { InkSession, type InkPage, type InkStroke } from '../lib/material-ink';
const stroke: InkStroke = {id: 'a', color: '#202632', width: .003, points: [{x: .1, y: .2}, {x: .3, y: .4}]};
it('serializes saves and preserves edits made during an in-flight save', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => {release = r;});
  const write = vi.fn(async (page: InkPage) => { await gate; return {...page, revision: page.revision + 1}; });
  const ink = new InkSession({revision: 0, strokes: []}, write);
  ink.change([stroke]); const first = ink.flush(); await Promise.resolve(); await Promise.resolve();
  ink.change([stroke, {...stroke, id: 'b'}]); const second = ink.flush(); release(); await first; await second;
  expect(write.mock.calls.map(([p]) => [p.revision, p.strokes.length])).toEqual([[0, 1], [1, 2]]);
  expect(ink.dirty).toBe(false);
  ink.undo(); expect(ink.strokes).toEqual([stroke]); ink.redo(); expect(ink.strokes).toHaveLength(2);
});
it('retains unsaved ink on failure and retries without inventing a server revision', async () => {
  const write = vi.fn<(page: InkPage) => Promise<InkPage>>().mockRejectedValueOnce(new Error('offline')).mockImplementation(async p => ({...p, revision: p.revision + 1}));
  const ink = new InkSession({revision: 4, strokes: []}, write); ink.change([stroke]);
  await expect(ink.flush()).rejects.toThrow('offline'); expect(ink.dirty).toBe(true); expect(ink.strokes).toEqual([stroke]);
  await ink.flush(); expect(write.mock.calls[1][0].revision).toBe(4); expect(ink.dirty).toBe(false);
});
