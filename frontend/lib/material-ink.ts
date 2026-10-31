export type InkPoint = { x: number; y: number };
export type InkStroke = { id: string; color: '#202632' | '#2563eb' | '#d44242'; width: number; points: InkPoint[] };
export type InkPage = { revision: number; strokes: InkStroke[] };

/** One page, one serialized save queue. Failed saves retain the local document. */
export class InkSession {
  strokes: InkStroke[];
  revision: number;
  private history: InkStroke[][] = [];
  private future: InkStroke[][] = [];
  private version = 0;
  private saved = 0;
  private saving: Promise<void> = Promise.resolve();
  constructor(page: InkPage, private write: (page: InkPage) => Promise<InkPage>) {
    this.strokes = page.strokes; this.revision = page.revision;
  }
  get dirty() { return this.version !== this.saved; }
  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.future.length > 0; }
  change(strokes: InkStroke[]) { this.history.push(this.strokes); if (this.history.length > 100) this.history.shift(); this.future = []; this.strokes = strokes; this.version++; }
  undo() { const value = this.history.pop(); if (value) { this.future.push(this.strokes); this.strokes = value; this.version++; } }
  redo() { const value = this.future.pop(); if (value) { this.history.push(this.strokes); this.strokes = value; this.version++; } }
  flush() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      if (!this.dirty) return;
      const version = this.version, strokes = this.strokes;
      const result = await this.write({ revision: this.revision, strokes });
      this.revision = result.revision; this.saved = version;
    });
    return this.saving;
  }
}
export function inkPath(points: InkPoint[]) { return points.map((p, i) => `${i ? 'L' : 'M'}${p.x * 1000} ${p.y * 1000}`).join(' '); }
