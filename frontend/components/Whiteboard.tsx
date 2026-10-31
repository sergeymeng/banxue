'use client';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { api, Lesson, Turn } from '@/lib/api';
import { ObservationGate } from '@/lib/observation-gate';
import { BoardEngine, HEIGHT, WIDTH } from '@/lib/whiteboard/engine';
import { exportBoard, path, textLines } from '@/lib/whiteboard/render';
import { demoBatch } from '@/lib/whiteboard/demo';
import type { BoardController, BoardEvent, BoardSnapshot, Point, Region } from '@/lib/whiteboard/types';
import Icon from './Icon';
import BoardGlyph from './BoardGlyph';

type Props = {
  lesson: Lesson; onResult: (result: Turn) => void; onError: (message: string) => void;
  annotation: string; disabled: boolean; live: boolean;
  onReady?: (controller: BoardController | null) => void; onBoardEvent?: (event: BoardEvent) => void;
};
type Tool = 'pen' | 'eraser' | 'region' | 'pan';
function download(url: string, filename: string) { const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); }
function bounds(points: Point[]): Region {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
  return { x: Math.min(x, WIDTH - 1), y: Math.min(y, HEIGHT - 1), width: Math.max(1, Math.max(...points.map(p => p.x)) - Math.min(x, WIDTH - 1)), height: Math.max(1, Math.max(...points.map(p => p.y)) - Math.min(y, HEIGHT - 1)) };
}

export default function Whiteboard(props: Props) {
  const { lesson, annotation, disabled, live } = props;
  const latest = useRef(props); latest.current = props;
  const initial = useRef(lesson.board);
  const engine = useRef<BoardEngine | null>(null);
  const controller = useRef<BoardController | null>(null);
  const [snapshot, setSnapshot] = useState<BoardSnapshot | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [restart, setRestart] = useState(0);
  const [auto, setAuto] = useState(false), [analyzing, setAnalyzing] = useState(false);
  const [status, setStatus] = useState('自动保存');
  const [tool, setTool] = useState<Tool>('pen');
  const [draft, setDraft] = useState<Point[]>([]), [selection, setSelection] = useState<Region>();
  const [zoom, setZoom] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches ? 2 : 1);
  const [extras, setExtras] = useState(false);
  const scroll = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<{ id: number; points: Point[]; tool: Tool; client: Point; scroll: Point } | null>(null);
  const svg = useRef<SVGSVGElement | null>(null);
  const gate = useRef(new ObservationGate()), observing = useRef(false);
  const observeRef = useRef<() => void>(() => {});

  useEffect(() => {
    let mounted = true, timer: ReturnType<typeof setTimeout> | undefined;
    let saving: Promise<unknown> = Promise.resolve(), changed = 0, saved = 0;
    let board: BoardEngine;
    async function flush() {
      clearTimeout(timer);
      if (saved === changed) { await saving; return; }
      const version = changed, data = board.getSnapshot();
      const task = saving.catch(() => {}).then(() => api(`/api/lessons/${lesson.id}/board`, { method: 'PUT', body: JSON.stringify({ snapshot: data }) }));
      saving = task;
      try { await task; saved = version; if (mounted && changed === version) setStatus('已保存到本机'); }
      catch (error) { if (mounted) setStatus('保存失败，请点击重试保存'); throw error; }
    }
    function event(value: BoardEvent) {
      changed++;
      if (mounted) { setSnapshot(board.getSnapshot()); setStatus('保存中…'); }
      if (value.type === 'edit' && value.author === 'student') gate.current.edit(Date.now());
      clearTimeout(timer); timer = setTimeout(() => { void flush().catch(() => {}); }, 600);
      // Subscribers cannot interrupt an atomic engine mutation.
      try { latest.current.onBoardEvent?.(value); } catch (error) { latest.current.onError((error as Error).message); }
    }
    try {
      board = new BoardEngine(lesson.id, restart ? undefined : initial.current, event);
      if (restart) { board.archive(initial.current); changed++; }
    } catch {
      setLegacy(true); setStatus('历史白板格式不兼容，原始快照已保留');
      return;
    }
    engine.current = board; setLegacy(false); setSnapshot(board.getSnapshot());
    board.setLocked(latest.current.disabled);
    const handle: BoardController = {
      enqueue: value => board.enqueue(value), pause: () => board.pause(), resume: () => board.resume(), cancel: () => board.cancel(),
      getQueue: () => board.getQueue(), getSnapshot: () => board.getSnapshot(), undo: () => board.undo(), redo: () => board.redo(),
      exportRegion: options => { if (!mounted) return Promise.reject(new Error('白板控制器已失效')); return exportBoard(board.getSnapshot(), options); },
      flush: () => { if (!mounted) return Promise.reject(new Error('白板控制器已失效')); return flush(); },
    };
    controller.current = handle; latest.current.onReady?.(handle);
    const tick = setInterval(() => board.step(), 700);
    if (restart) void flush().catch(() => {});
    const leaving = () => { void flush().catch(() => {}); };
    window.addEventListener('pagehide', leaving);
    return () => {
      mounted = false; clearInterval(tick); clearTimeout(timer); window.removeEventListener('pagehide', leaving);
      void flush().catch(() => {}); board.dispose(); engine.current = null; controller.current = null;
      latest.current.onReady?.(null);
    };
  }, [lesson.id, restart]);
  useEffect(() => { engine.current?.setLocked(disabled); }, [disabled]);
  useEffect(() => {
    if (!auto || !live || disabled) return;
    const interval = setInterval(() => { if (gate.current.ready(Date.now(), true, observing.current)) observeRef.current(); }, 1000);
    return () => clearInterval(interval);
  }, [auto, live, disabled]);

  function safely(action: () => void) { try { action(); } catch (e) { props.onError((e as Error).message); } }
  async function observe(trigger: 'idle' | 'explicit') {
    const board = controller.current;
    if (!board || observing.current || disabled) return;
    observing.current = true; setAnalyzing(true);
    try {
      const exported = await board.exportRegion({ region: selection, author: 'student' });
      gate.current.sent(Date.now()); await board.flush();
      const result = await api<Turn>(`/api/lessons/${lesson.id}/observe`, { method: 'POST', body: JSON.stringify({ image: exported.image, trigger, step_complete: trigger === 'explicit' }) });
      if (controller.current !== board) return;
      if (result.skipped) setStatus(result.skipped);
      else { props.onResult(result); setStatus(result.observation ? `可见内容：${result.observation.visible_text || '不清晰'} · 置信度 ${Math.round(result.observation.confidence * 100)}%` : '观察完成'); }
    } catch (error) { if (controller.current === board) props.onError((error as Error).message); }
    finally { observing.current = false; setAnalyzing(false); }
  }
  observeRef.current = () => { void observe('idle'); };
  function addNote() {
    const uid = `note-${crypto.randomUUID()}`;
    const note = { id: `${uid}-element`, kind: 'text' as const, author: 'teacher' as const, x: 80, y: 40, width: 1400, height: 200, text: annotation.slice(0, 400).split('\n').slice(0, 8).join('\n') };
    note.height = textLines(note).length * 32 + 12;
    note.y = Math.min(HEIGHT - note.height - 20, Math.max(40, ...(snapshot?.elements.map(e => e.y + e.height + 20) ?? [])));
    safely(() => controller.current?.enqueue({ version: 1, id: uid, lessonId: lesson.id, actions: [{ id: `${uid}-add`, type: 'add', element: note }] }));
  }
  function position(event: PointerEvent<SVGSVGElement>): Point {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return { x: Math.max(0, Math.min(WIDTH, p.x)), y: Math.max(0, Math.min(HEIGHT, p.y)) };
  }
  function eraseAt(event: PointerEvent<SVGSVGElement>) {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-element-id]')?.getAttribute('data-element-id');
    if (target) safely(() => engine.current?.eraseStudent(target));
  }
  function start(event: PointerEvent<SVGSVGElement>) {
    if (!engine.current || pointer.current || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
    const p = position(event); pointer.current = { id: event.pointerId, points: [p], tool, client: { x: event.clientX, y: event.clientY }, scroll: { x: scroll.current?.scrollLeft ?? 0, y: scroll.current?.scrollTop ?? 0 } };
    if (tool === 'eraser') eraseAt(event);
    else if (tool === 'region') setSelection(undefined);
    else if (tool === 'pen') setDraft([p]);
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const current = pointer.current; if (!current || current.id !== event.pointerId) return;
    if (current.tool === 'pan') {
      scroll.current?.scrollTo(current.scroll.x - event.clientX + current.client.x, current.scroll.y - event.clientY + current.client.y); return;
    }
    if (current.tool === 'eraser') { eraseAt(event); return; }
    const p = position(event);
    if (current.tool === 'region') { current.points = [current.points[0], p]; setSelection(bounds(current.points)); }
    else if (current.points.length < 2047) { current.points.push(p); setDraft([...current.points]); }
  }
  function finish(event: PointerEvent<SVGSVGElement>, cancelled = false) {
    const current = pointer.current; if (!current || current.id !== event.pointerId) return;
    pointer.current = null; setDraft([]);
    if (cancelled) { if (current.tool === 'region') setSelection(undefined); return; }
    if (current.tool === 'pen') {
      current.points.push(position(event));
      safely(() => engine.current?.addStudent({ ...bounds(current.points), id: `student-${crypto.randomUUID()}`, author: 'student', kind: 'stroke', points: current.points }));
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  async function exportImage() {
    try { const data = await controller.current?.exportRegion({ region: selection }); if (data) download(data.image, `board-${lesson.id}-r${data.revision}.png`); }
    catch (error) { props.onError((error as Error).message); }
  }
  function exportLegacy() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(initial.current, null, 2)], { type: 'application/json' }));
    download(url, `legacy-board-${lesson.id}.json`); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const queue = snapshot?.queue;
  const pending = queue?.steps.filter(s => s.status === 'pending').length ?? 0;
  const executed = queue?.steps.filter(s => s.status === 'executed').length ?? 0;
  return <section className="board-panel" onKeyDown={event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); safely(() => event.shiftKey ? controller.current?.redo() : controller.current?.undo()); }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) { const keys: Record<string, Tool> = { p: 'pen', e: 'eraser', v: 'region', h: 'pan' }; if (keys[event.key.toLowerCase()]) setTool(keys[event.key.toLowerCase()]); }
  }}>
    <div className="board-toolbar"><div className="board-heading"><h2>解题白板</h2><span>黑色是你的步骤 · 蓝色是老师板书</span></div><div className="board-actions">
      <button className="observe-step" disabled={analyzing || disabled || legacy} onClick={() => void observe('explicit')}>{analyzing ? '正在观察…' : '请看这一步'}</button>
      <button aria-expanded={extras} aria-label="白板更多功能" onClick={() => setExtras(value => !value)}>更多</button>
    </div></div>
    {lesson.current_exercise && <div className="exercise-strip"><span>题目</span>{lesson.current_exercise}</div>}
    {legacy ? <div className="board-legacy"><p>这是旧版或无法读取的白板快照。原始数据保持不变；新版暂不支持完整呈现。</p><button onClick={exportLegacy}>下载原始快照</button><button onClick={() => setRestart(n => n + 1)}>保留原始快照并新建白板</button></div> : <>
      <div className="board-tools" role="toolbar" aria-label="白板工具">
        {([['pen', '书写', 'pen'], ['eraser', '整笔擦除', 'eraser'], ['region', '框选区域', 'selection'], ['pan', '移动画布', 'hand']] as const).map(([value, label, icon]) => <button key={value} aria-pressed={tool === value} onClick={() => setTool(value)} title={label}><Icon name={icon}/>{label}</button>)}
        <button disabled={!engine.current?.canUndo} onClick={() => safely(() => controller.current?.undo())}><Icon name="undo"/>撤销</button>
        <button disabled={!engine.current?.canRedo} onClick={() => safely(() => controller.current?.redo())}><Icon name="redo"/>重做</button>
        {selection && <button onClick={() => void exportImage()}>导出选区</button>}
        {selection && <button onClick={() => setSelection(undefined)}>清除选区</button>}
        <label>缩放 <select aria-label="白板缩放" value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value={1}>适应宽度</option><option value={1.5}>150%</option><option value={2}>200%</option></select></label>

      </div>
      {extras && <div className="board-extras">
        <div className="board-extra-actions"><button disabled={!annotation || disabled} onClick={addNote}>添加老师便签</button><button onClick={() => void exportImage()}>{selection ? '导出当前选区' : '导出整板'}</button><label className="checkbox-row" title={live ? '停笔三秒后按需观察，最短间隔二十秒' : '连接真实视觉模型后可用'}><input type="checkbox" checked={auto && live} disabled={!live} onChange={e => setAuto(e.target.checked)}/>自动观察</label></div>
        <details className="board-development"><summary>开发演示与动作记录</summary><div className="board-queue">
        <button disabled={disabled || pending > 0} onClick={() => safely(() => controller.current?.enqueue(demoBatch(lesson.id)))}>开发演示：逐步板书</button>
        <span>本地固定动作，无模型/手写识别</span>
        <button disabled={queue?.state !== 'running'} onClick={() => safely(() => controller.current?.pause())}>暂停板书</button>
        <button disabled={disabled || !pending || queue?.state === 'running'} onClick={() => safely(() => controller.current?.resume())}>继续板书</button>
        <button disabled={!pending} onClick={() => safely(() => controller.current?.cancel())}>取消待执行</button>
        <span data-testid="queue-status">{queue?.state === 'running' ? '执行中' : queue?.state === 'paused' ? '已暂停' : '空闲'} · 已执行 {executed} · 待执行 {pending}</span>
        {!!queue?.steps.length && <details><summary>动作记录</summary><ol>{queue.steps.map(s => <li key={s.action.id}>{s.action.type} · {s.status} {s.executedRevision !== undefined ? `· 修订 ${s.executedRevision}` : ''}{s.error ? ` · ${s.error}` : ''}</li>)}</ol></details>}
      </div></details></div>}
      <div ref={scroll} className={`canvas board-scroll board-tool-${tool}`}><svg ref={svg} className="teaching-board" data-testid="teaching-board" aria-label="课堂白板，黑色为学生书写，蓝色为老师板书" role="img" tabIndex={0} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={{ width: `${zoom * 100}%` }} onPointerDown={start} onPointerMove={move} onPointerUp={e => finish(e)} onPointerCancel={e => finish(e, true)} onLostPointerCapture={e => finish(e, true)}>
        <defs><pattern id={`board-dots-${lesson.id}`} width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#e9edf2"/></pattern></defs>
        <rect width={WIDTH} height={HEIGHT} fill="white" />
        <rect width={WIDTH} height={HEIGHT} fill={`url(#board-dots-${lesson.id})`} pointerEvents="none"/>
        {!snapshot?.elements.length && !draft.length && <g pointerEvents="none" fill="#8e9aab" fontFamily="sans-serif"><text x="80" y="110" fontSize="30">在这里写下你的第一步</text><text x="80" y="155" fontSize="22">直接用笔、触摸或鼠标书写。写好后，点「请看这一步」。</text></g>}
        {snapshot?.elements.map(e => <BoardGlyph key={e.id} element={e} />)}
        {!!draft.length && <path d={path(draft)} fill="none" stroke="#242424" strokeWidth={3} strokeLinecap="round" pointerEvents="none" />}
        {selection && <rect {...selection} fill="#3268cf10" stroke="#3268cf" strokeWidth={2} strokeDasharray="8 6" pointerEvents="none" />}
      </svg></div>
    </>}
    <div className="board-status"><span role="status">{status}</span>{!legacy && <button onClick={() => void controller.current?.flush().catch(e => props.onError(e.message))}>重试保存</button>}</div>
  </section>;
}
