# Classroom whiteboard contract v1

Status: phase-one interface; owned by `codex/teaching-board`. No live model or handwriting recognition is implemented by this interface.

## Ownership and coordinates

`frontend/lib/whiteboard/types.ts` is the integration entry point. `Whiteboard` preserves its existing props and additionally accepts `onReady(controller | null)` and `onBoardEvent(event)`. Callers enqueue JSON values through `controller.enqueue(batch: unknown)`; runtime validation is mandatory. No JavaScript, HTML, SVG markup, URLs or expression evaluation is accepted.

One local classroom shares a 1600 × 1200 board, origin top-left, x rightwards/y downwards. This is not a multi-user network protocol. Students use pointer input (mouse, touch, pen); teachers use actions. Each element has a stable ID, author (`student`/`teacher`) and, for teacher elements, source action ID. Teacher actions cannot erase student work. An explicit local student eraser may erase either author's element. Student edits alone dirty the observation gate.

Text and formulas are plain Unicode strings. Formula v1 renders mathematical Unicode (e.g. `f′(x) = 3x² + 2x`); it does not parse LaTeX or execute expressions. Coordinates and text lengths are bounded. Future formula formats require a versioned extension.

## Batches, actions and execution

Batch: `{version: 1, id, lessonId, actions}`. IDs are opaque bounded identifiers. Actions have unique `id` and one of:

- `add`: `{id, type:'add', element}`; element is teacher-authored text, formula, rectangle, ellipse, arrow or stroke. Element ID is globally unique within this board's history.
- `erase`: `{id, type:'erase', elementIds:[...]}`; teacher elements only, existing at execution time.

Circle selection is an `ellipse`; an arrow is two points. Erase removes whole objects, not pixels. The entire batch is validated before acceptance. Repeated batch/action IDs are rejected (never silently replayed). Unknown keys, malformed geometry, excessive lengths/counts, cross-lesson batches, and unknown operations are rejected. Invalid runtime actions fail individually and pause the queue; no subsequent step runs until explicit resume/cancel.

Controller: `enqueue`, `pause`, `resume`, `cancel`, `getQueue`, `getSnapshot`, `undo`, `redo`, `exportRegion`, `flush`. Queue executes one atomic action per tick, allowing student writing between ticks. Enqueue does not implicitly resume a paused queue. Cancel terminally marks pending steps cancelled, leaves already executed work intact, and rejects reuse of their IDs. Undo/redo operates on board edits and pauses execution. Executed receipt is historical: undo does not change a receipt to pending. A receipt is not mastery/recognition evidence or proof that speech was played.

Queue state: `running | paused | idle`; step status: `pending | executed | cancelled | failed`, with `executedRevision` or `error` where applicable. Queue updates and board edits are delivered through `onBoardEvent`. `edit` includes author, revision, and affected element IDs. Host lesson pause/disabled state pauses and locks queue execution. Hosts may also call pause/cancel on interruption. Reload restores pending work **paused**, never automatically replays it. Lesson remount disposes timers and invalidates the old controller.

## Persistence, recognition and export

Snapshot: `format:'banxue-board', version:1, width:1600, height:1200, revision, elements, queue, usedElementIds`. Existing `PUT /api/lessons/:id/board` with `{snapshot}` stores it unchanged. Saves serialize; `flush` forces the latest edit and propagates errors. Undo history is session-local; board and action receipts survive restore.

`exportRegion({region?, author?:'student'|'teacher'|'all', maxSize?:number})` returns PNG data URL plus exact board-space region, revision, element IDs and author. Default region is full board; max output dimension is 1200 by default, at most 2048. Crop before recognition, exclude teacher content with `author:'student'`. Empty exports fail explicitly. Recognition results must reference exported element IDs/revision and carry their own uncertainty/evidence IDs. This branch does not generate recognition or mastery claims.

Unknown/legacy snapshots are read-only until the user explicitly starts a new board. Original JSON remains downloadable and is retained under `legacySnapshot` on the replacement board, including after saves/restores. No lossy automatic migration or silent overwrite. Full fidelity legacy rendering is outside v1.

## Integration example

```ts
controller.enqueue({version: 1, id: 'turn-42', lessonId, actions: [
  {id: 'turn-42-step-1', type: 'add', element: {
    id: 'formula-42', kind: 'formula', author: 'teacher',
    x: 120, y: 120, width: 650, height: 80, text: 'f′(x) = 3x² + 2x'
  }},
  {id: 'turn-42-step-2', type: 'add', element: {
    id: 'circle-42', kind: 'ellipse', author: 'teacher',
    x: 330, y: 110, width: 140, height: 80
  }}
]});
// Student interrupts:
controller.pause();
// Superseded teaching turn:
controller.cancel();
```

The visible “开发演示” uses local fixed actions only. It is not an LLM/ASR/handwriting-recognition correctness test. TeachingPolicy remains outside Whiteboard.
