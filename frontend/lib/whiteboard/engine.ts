import type { ActionBatch, Author, BoardAction, BoardElement, BoardEvent, BoardSnapshot, Point, QueueState, Region } from './types';

export const WIDTH = 1600, HEIGHT = 1200;
const MAX_STEPS = 1000, MAX_IDS = 5000, MAX_ELEMENTS = 1000;
const clone = <T>(value: T): T => structuredClone(value);
function fail(message: string): never { throw new Error(message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('需要 JSON 对象');
  return value as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) fail('不支持的字段');
}
function id(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(v)) fail('无效 ID');
  return v;
}
function num(v: unknown, max: number, min = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail('坐标或尺寸超出白板范围');
  return v;
}
export function region(value: unknown): Region {
  const v = object(value); keys(v, ['x', 'y', 'width', 'height']);
  const r = { x: num(v.x, WIDTH), y: num(v.y, HEIGHT), width: num(v.width, WIDTH, 1), height: num(v.height, HEIGHT, 1) };
  if (r.x + r.width > WIDTH || r.y + r.height > HEIGHT) fail('区域超出白板范围');
  return r;
}
function point(value: unknown): Point {
  const p = object(value); keys(p, ['x', 'y']); return { x: num(p.x, WIDTH), y: num(p.y, HEIGHT) };
}
export function element(value: unknown, teacherOnly = false): BoardElement {
  const e = object(value); keys(e, ['id', 'kind', 'author', 'x', 'y', 'width', 'height', 'text', 'points', 'sourceActionId']);
  if (e.author !== 'teacher' && (teacherOnly || e.author !== 'student')) fail('无效内容作者');
  const r = region({ x: e.x, y: e.y, width: e.width, height: e.height });
  const base = { ...r, id: id(e.id), author: e.author as Author };
  if (e.sourceActionId !== undefined) id(e.sourceActionId);
  const source = e.sourceActionId ? { sourceActionId: e.sourceActionId as string } : {};
  if (e.kind === 'text' || e.kind === 'formula') {
    if (typeof e.text !== 'string' || !e.text.trim() || e.text.length > 400 || e.text.split('\n').length > 8 || e.points !== undefined) fail('文字限 400 字、8 行');
    return { ...base, ...source, kind: e.kind, text: e.text };
  }
  if (e.text !== undefined) fail('图形不接受文字字段');
  if (e.kind === 'stroke' || e.kind === 'arrow') {
    if (!Array.isArray(e.points) || e.points.length < 2 || e.points.length > 2048 || (e.kind === 'arrow' && e.points.length !== 2)) fail('无效笔画点集');
    const points = e.points.map(point);
    if (points.some(p => p.x < r.x || p.x > r.x + r.width || p.y < r.y || p.y > r.y + r.height)) fail('笔画超出元素区域');
    return { ...base, ...source, kind: e.kind, points };
  }
  if ((e.kind === 'rectangle' || e.kind === 'ellipse') && e.points === undefined) return { ...base, ...source, kind: e.kind };
  return fail('不支持的元素类型');
}
function action(value: unknown): BoardAction {
  const a = object(value);
  if (a.type === 'add') {
    keys(a, ['id', 'type', 'element']);
    const e = element(a.element, true);
    if (e.sourceActionId !== undefined) fail('sourceActionId 由执行器设置');
    return { id: id(a.id), type: 'add', element: e };
  }
  if (a.type === 'erase') {
    keys(a, ['id', 'type', 'elementIds']);
    if (!Array.isArray(a.elementIds) || !a.elementIds.length || a.elementIds.length > 100) fail('擦除目标数量无效');
    const ids = a.elementIds.map(id);
    if (new Set(ids).size !== ids.length) fail('重复擦除目标');
    return { id: id(a.id), type: 'erase', elementIds: ids };
  }
  return fail('不支持的动作类型');
}
export function parseBatch(value: unknown, lessonId: string): ActionBatch {
  const b = object(value); keys(b, ['version', 'id', 'lessonId', 'actions']);
  if (b.version !== 1 || b.lessonId !== lessonId) fail('白板版本或课堂不匹配');
  if (!Array.isArray(b.actions) || b.actions.length < 1 || b.actions.length > 100) fail('每批限 1–100 个动作');
  const actions = b.actions.map(action);
  if (new Set(actions.map(a => a.id)).size !== actions.length) fail('重复动作 ID');
  return { version: 1, id: id(b.id), lessonId, actions };
}
// Leave room below the backend's 5 MB JSON limit, including Python ASCII escaping/spacing.
function ensureFits(snapshot: BoardSnapshot) {
  if (JSON.stringify(snapshot).replace(/[^\x00-\x7F]/g, 'xxxxxx').length > 2_500_000) fail('白板快照容量已达上限，请导出后开始新课');
}
function empty(): BoardSnapshot {
  return { format: 'banxue-board', version: 1, width: WIDTH, height: HEIGHT, revision: 0, elements: [], queue: { state: 'idle', steps: [] }, usedElementIds: [] };
}
export function restore(value: unknown): BoardSnapshot {
  const v = object(value); keys(v, ['format', 'version', 'width', 'height', 'revision', 'elements', 'queue', 'usedElementIds', 'legacySnapshot']);
  if (v.format !== 'banxue-board' || v.version !== 1 || v.width !== WIDTH || v.height !== HEIGHT) fail('历史白板格式不兼容');
  const revision = num(v.revision, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(revision) || !Array.isArray(v.elements) || v.elements.length > MAX_ELEMENTS || !Array.isArray(v.usedElementIds) || v.usedElementIds.length > MAX_IDS) fail('无效快照');
  const elements = v.elements.map(e => element(e));
  const usedElementIds = v.usedElementIds.map(id);
  if (new Set(elements.map(e => e.id)).size !== elements.length || new Set(usedElementIds).size !== usedElementIds.length || elements.some(e => !usedElementIds.includes(e.id))) fail('快照元素 ID 不一致');
  const q = object(v.queue); keys(q, ['state', 'steps']);
  if (!['idle', 'running', 'paused'].includes(q.state as string) || !Array.isArray(q.steps) || q.steps.length > MAX_STEPS) fail('无效队列');
  const seen = new Set<string>();
  const steps = q.steps.map(value => {
    const s = object(value); keys(s, ['batchId', 'action', 'status', 'executedRevision', 'error']);
    const a = action(s.action);
    if (seen.has(a.id)) fail('重复动作 ID'); seen.add(a.id);
    if (!['pending', 'executed', 'cancelled', 'failed'].includes(s.status as string)) fail('无效动作状态');
    if (s.status === 'executed') num(s.executedRevision, revision, 1);
    if (s.error !== undefined && (typeof s.error !== 'string' || s.error.length > 500)) fail('无效错误信息');
    return { batchId: id(s.batchId), action: a, status: s.status as QueueState['steps'][number]['status'], ...(s.executedRevision !== undefined ? { executedRevision: num(s.executedRevision, revision, 1) } : {}), ...(s.error ? { error: String(s.error) } : {}) };
  });
  return { ...empty(), revision, elements, usedElementIds, queue: { state: steps.some(s => s.status === 'pending') ? 'paused' : 'idle', steps }, ...(v.legacySnapshot !== undefined ? { legacySnapshot: clone(v.legacySnapshot) } : {}) };
}

export class BoardEngine {
  private data: BoardSnapshot;
  private past: BoardElement[][] = [];
  private future: BoardElement[][] = [];
  private locked = false;
  private disposed = false;
  constructor(readonly lessonId: string, snapshot?: unknown, private emit: (event: BoardEvent) => void = () => {}) {
    this.data = snapshot ? restore(snapshot) : empty();
  }
  getSnapshot() { return clone(this.data); }
  getQueue() { return clone(this.data.queue); }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  private active() { if (this.disposed) fail('白板控制器已失效'); }
  dispose() { this.disposed = true; }
  archive(value: unknown) { this.active(); this.data.legacySnapshot = clone(value); }
  setLocked(value: boolean) { this.locked = value; if (value && this.data.queue.steps.some(s => s.status === 'pending')) this.pause(); }
  private notify(event: BoardEvent) {
    try { this.emit(event); } catch { /* Subscriber failures cannot interrupt atomic board mutations. */ }
  }
  private queueChanged() { this.notify({ type: 'queue', queue: this.getQueue() }); }
  private edit(next: BoardElement[], author: Author, ids: string[], history = true) {
    if (next.length > MAX_ELEMENTS) fail('白板元素已达上限，请保存后开始新课');
    ensureFits({ ...this.data, elements: next });
    if (history) { this.past.push(clone(this.data.elements)); if (this.past.length > 100) this.past.shift(); this.future = []; }
    this.data.elements = clone(next); this.data.revision++;
    this.notify({ type: 'edit', author, revision: this.data.revision, elementIds: ids });
  }
  addStudent(value: unknown) {
    this.active(); const e = element(value);
    if (e.author !== 'student' || e.sourceActionId !== undefined) fail('无效学生内容');
    if (this.data.queue.steps.some(s => s.status === 'pending' && s.action.type === 'add' && s.action.element.id === e.id)) fail('元素 ID 已排队');
    this.reserve(e.id); this.edit([...this.data.elements, e], 'student', [e.id]);
  }
  eraseStudent(target: string) {
    this.active(); if (!this.data.elements.some(e => e.id === target)) return;
    this.edit(this.data.elements.filter(e => e.id !== target), 'student', [target]);
  }
  private reserve(target: string) {
    if (this.data.usedElementIds.includes(target)) fail('元素 ID 已使用');
    if (this.data.usedElementIds.length >= MAX_IDS || this.data.elements.length >= MAX_ELEMENTS) fail('白板容量已达上限');
    this.data.usedElementIds.push(target);
  }
  enqueue(value: unknown) {
    this.active(); const b = parseBatch(value, this.lessonId);
    const q = this.data.queue;
    if (q.steps.length + b.actions.length > MAX_STEPS) fail('动作历史已达上限');
    if (q.steps.some(s => s.batchId === b.id || b.actions.some(a => a.id === s.action.id))) fail('批次或动作 ID 已使用');
    const reserved = new Set([...this.data.usedElementIds, ...q.steps.filter(s => s.status === 'pending' && s.action.type === 'add').map(s => s.action.type === 'add' ? s.action.element.id : '')]);
    for (const a of b.actions) if (a.type === 'add') { if (reserved.has(a.element.id)) fail('元素 ID 已使用或已排队'); reserved.add(a.element.id); }
    if (reserved.size > MAX_IDS) fail('白板容量已达上限');
    const added = b.actions.map(a => ({ batchId: b.id, action: a, status: 'pending' as const }));
    ensureFits({ ...this.data, queue: { ...q, steps: [...q.steps, ...added] } });
    q.steps.push(...added);
    if (q.state !== 'paused') q.state = this.locked ? 'paused' : 'running';
    this.queueChanged();
  }
  pause() { this.active(); this.data.queue.state = 'paused'; this.queueChanged(); }
  resume() { this.active(); if (this.locked) fail('课堂暂停期间不能执行板书'); this.data.queue.state = this.data.queue.steps.some(s => s.status === 'pending') ? 'running' : 'idle'; this.queueChanged(); }
  cancel() { this.active(); for (const s of this.data.queue.steps) if (s.status === 'pending') s.status = 'cancelled'; this.data.queue.state = 'idle'; this.queueChanged(); }
  step() {
    this.active(); const q = this.data.queue;
    if (this.locked || q.state !== 'running') return;
    const s = q.steps.find(s => s.status === 'pending'); if (!s) return;
    try {
      const a = s.action;
      if (a.type === 'add') {
        this.reserve(a.element.id);
        this.edit([...this.data.elements, { ...a.element, sourceActionId: a.id }], 'teacher', [a.element.id]);
      } else {
        if (a.elementIds.some(target => !this.data.elements.some(e => e.id === target && e.author === 'teacher'))) fail('老师只能擦除仍存在的老师内容');
        this.edit(this.data.elements.filter(e => !a.elementIds.includes(e.id)), 'teacher', a.elementIds);
      }
      s.status = 'executed'; s.executedRevision = this.data.revision;
      if (!q.steps.some(s => s.status === 'pending')) q.state = 'idle';
    } catch (error) { s.status = 'failed'; s.error = (error as Error).message; q.state = 'paused'; }
    this.queueChanged();
  }
  undo() {
    this.active(); this.pause(); const previous = this.past.pop(); if (!previous) return;
    this.future.push(clone(this.data.elements));
    this.edit(previous, 'student', [...new Set([...previous, ...this.data.elements].map(e => e.id))], false);
  }
  redo() {
    this.active(); this.pause(); const next = this.future.pop(); if (!next) return;
    this.past.push(clone(this.data.elements)); this.edit(next, 'student', [...new Set([...next, ...this.data.elements].map(e => e.id))], false);
  }
}
