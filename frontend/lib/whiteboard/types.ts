export type Author = 'student' | 'teacher';
export type Point = { x: number; y: number };
export type Region = Point & { width: number; height: number };
export type BoardElement = Region & {
  id: string; author: Author; kind: 'stroke' | 'text' | 'formula' | 'rectangle' | 'ellipse' | 'arrow';
  text?: string; points?: Point[]; sourceActionId?: string;
};
export type BoardAction = { id: string; type: 'add'; element: BoardElement } |
  { id: string; type: 'erase'; elementIds: string[] };
export type ActionBatch = { version: 1; id: string; lessonId: string; actions: BoardAction[] };
export type Receipt = { batchId: string; action: BoardAction; status: 'pending' | 'executed' | 'cancelled' | 'failed'; executedRevision?: number; error?: string };
export type QueueState = { state: 'running' | 'paused' | 'idle'; steps: Receipt[] };
export type BoardSnapshot = {
  format: 'banxue-board'; version: 1; width: 1600; height: 1200; revision: number;
  elements: BoardElement[]; queue: QueueState; usedElementIds: string[]; legacySnapshot?: unknown;
};
export type BoardEvent = { type: 'edit'; author: Author; revision: number; elementIds: string[] } |
  { type: 'queue'; queue: QueueState };
export type ExportOptions = { region?: Region; author?: Author | 'all'; maxSize?: number };
export type BoardExport = { image: string; region: Region; revision: number; elementIds: string[]; author: Author | 'all' };
export interface BoardController {
  enqueue(batch: unknown): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  getQueue(): QueueState;
  getSnapshot(): BoardSnapshot;
  undo(): void;
  redo(): void;
  exportRegion(options?: ExportOptions): Promise<BoardExport>;
  flush(): Promise<void>;
}
