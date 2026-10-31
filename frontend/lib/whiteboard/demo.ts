import type { ActionBatch, BoardElement } from './types';
// Local fixed geometry only. No model call, recognition or mastery judgment.
export function demoBatch(lessonId: string): ActionBatch {
  const prefix = `demo-${crypto.randomUUID()}`;
  const add = (suffix: string, e: Omit<BoardElement, 'id' | 'author'>) => ({ id: `${prefix}-${suffix}`, type: 'add' as const, element: { ...e, id: `${prefix}-e-${suffix}`, author: 'teacher' as const } });
  return { version: 1, id: prefix, lessonId, actions: [
    add('question', { kind: 'text', x: 80, y: 60, width: 960, height: 48, text: '示例：求 f(x) = x³ + x² 的导数' }),
    add('rule', { kind: 'formula', x: 80, y: 140, width: 960, height: 48, text: '(xⁿ)′ = nxⁿ⁻¹' }),
    add('box', { kind: 'rectangle', x: 60, y: 125, width: 480, height: 75 }),
    add('arrow', { kind: 'arrow', x: 180, y: 210, width: 1, height: 65, points: [{ x: 180, y: 210 }, { x: 180, y: 275 }] }),
    add('step', { kind: 'formula', x: 80, y: 290, width: 960, height: 48, text: 'f′(x) = 3x² + ____' }),
    add('circle', { kind: 'ellipse', x: 150, y: 280, width: 85, height: 66 }),
    { id: `${prefix}-erase`, type: 'erase', elementIds: [`${prefix}-e-box`] },
    add('prompt', { kind: 'text', x: 80, y: 400, width: 960, height: 80, text: '轮到你了：补上 (x²)′，在下方写出完整答案。' }),
  ] };
}
