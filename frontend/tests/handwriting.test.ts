import { describe, expect, it } from 'vitest';
import { fromBoardExport, prepareStudentRegion, staleBoardReason, type Observation, type StudentBoardExport } from '../lib/handwriting';
const exported: StudentBoardExport = { image: 'data:image/png;base64,test', author: 'student', revision: 7, elementIds: ['s1'], region: { x: 20, y: 30, width: 200, height: 100 } };
describe('student region bridge', () => {
  it('preserves exact crop/revision/IDs and detaches mutable arrays', () => {
    const result = fromBoardExport(exported);
    expect(result.source).toMatchObject({ page_id: 'main', snapshot_id: 'banxue-board:v1:7', revision: 7, element_ids: ['s1'], author: 'student', region: exported.region });
    expect(result.image).toBe(exported.image);
    expect(result.source.element_ids).not.toBe(exported.elementIds);
  });
  it('rejects teacher/all exports and incomplete identities', () => {
    for (const patch of [{ author: 'all' }, { author: 'teacher' }, { elementIds: [] }, { elementIds: ['s1', 's1'] }, { revision: NaN }]) {
      expect(() => fromBoardExport({ ...exported, ...patch } as StudentBoardExport)).toThrow();
    }
  });
  it('flushes after async export and rejects a newer edit', async () => {
    const calls: string[] = [];
    let revision = 7;
    const controller = {
      exportRegion: async (options: {author: 'student'}) => { expect(options.author).toBe('student'); calls.push('export'); return exported; },
      flush: async () => { calls.push('flush'); },
      getSnapshot: () => ({ revision }),
    };
    expect((await prepareStudentRegion(controller)).source.revision).toBe(7);
    expect(calls).toEqual(['export', 'flush']);
    revision = 8;
    await expect(prepareStudentRegion(controller)).rejects.toThrow('白板已变化');
  });
  it('fails closed when local revision is absent and leaves uploads independent', () => {
    const observation = { source: fromBoardExport(exported).source } as Observation;
    expect(staleBoardReason(observation)).toBeTruthy();
    expect(staleBoardReason(observation, 8)).toBeTruthy();
    expect(staleBoardReason(observation, 7)).toBeNull();
    expect(staleBoardReason({ source: {kind: 'upload'} } as Observation)).toBeNull();
  });
});
