'use client';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { API, api, type Material } from '@/lib/api';
import { InkSession, inkPath, type InkPoint, type InkPage, type InkStroke } from '@/lib/material-ink';
import Icon from './Icon';

export type MaterialController = { flush: () => Promise<void> };
export default function MaterialReader({ teacherId, lessonId, material, initialPage = 1, onPage, onReady, close }: {
  teacherId: string; lessonId: string; material: Material; initialPage?: number;
  onPage: (page: number) => Promise<void>; onReady: (controller: MaterialController | null) => void; close: () => void;
}) {
  const [page, setPage] = useState(initialPage), [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [strokes, setStrokes] = useState<InkStroke[]>([]), [draft, setDraft] = useState<InkStroke>();
  const [tool, setTool] = useState<'pen' | 'eraser' | 'pan'>('pen');
  const [color, setColor] = useState<InkStroke['color']>('#202632'), [zoom, setZoom] = useState(1);
  const [ratio, setRatio] = useState(1.414), [switching, setSwitching] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null), scroll = useRef<HTMLDivElement>(null);
  const ink = useRef<InkSession | null>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gesture = useRef<{ id: number; stroke?: InkStroke; x: number; y: number; left: number; top: number } | null>(null);
  const callbacks = useRef({onReady, onPage}); callbacks.current = {onReady, onPage};
  const flush = useRef(async () => {});
  flush.current = async () => { clearTimeout(timer.current); if (!ink.current) return; try { await ink.current.flush(); setStatus('已保存'); setError(''); } catch (e) { setStatus('保存失败'); throw e; } };
  useEffect(() => {
    let active = true;
    let task: ReturnType<typeof import('pdfjs-dist')['getDocument']> | undefined;
    void (async () => {
      const lib = await import('pdfjs-dist');
      if (!active) return;
      lib.GlobalWorkerOptions.workerSrc = '/pdf/pdf.worker.min.mjs';
      task = lib.getDocument({ url: `${API}/api/teachers/${teacherId}/documents/${material.id}/file`,
        cMapUrl: '/pdf/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdf/standard_fonts/', wasmUrl: '/pdf/wasm/' });
      const document = await task.promise; if (active) setPdf(document);
    })().catch(e => { if (active) setError(`教材打开失败：${e.message}`); });
    return () => { active = false; void task?.destroy(); };
  }, [teacherId, material.id]);
  useEffect(() => {
    let active = true; let render: RenderTask | undefined;
    setReady(false); setError(''); setDraft(undefined); setStrokes([]); ink.current = null;
    if (!pdf) return;
    const path = `/api/lessons/${lessonId}/documents/${material.id}/pages/${page}/ink`;
    void (async () => {
      const [sheet, data] = await Promise.all([pdf.getPage(page), api<InkPage>(path)]);
      if (!active || !canvas.current) return;
      const viewport = sheet.getViewport({scale: 1}); const scaled = sheet.getViewport({scale: Math.min(2, 1800 / viewport.width)});
      setRatio(viewport.height / viewport.width);
      canvas.current.width = scaled.width; canvas.current.height = scaled.height;
      render = sheet.render({canvas: canvas.current, viewport: scaled}); await render.promise;
      if (!active) return;
      ink.current = new InkSession(data, value => api<InkPage>(path, {method: 'PUT', body: JSON.stringify(value)}));
      setStrokes(data.strokes); setReady(true); setStatus('已保存');
      scroll.current?.scrollTo(0, 0);
    })().catch(e => { if (active) setError(e.message); });
    return () => { active = false; render?.cancel(); };
  }, [pdf, page, lessonId, material.id]);
  useEffect(() => {
    callbacks.current.onReady({flush: () => flush.current()});
    const leave = () => { void flush.current().catch(() => {}); };
    window.addEventListener('pagehide', leave);
    return () => { clearTimeout(timer.current); void flush.current().catch(() => {}); callbacks.current.onReady(null); window.removeEventListener('pagehide', leave); };
  }, []);
  function changed() {
    if (!ink.current) return;
    setStrokes([...ink.current.strokes]); setStatus('保存中…'); clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush.current().catch(() => {}); }, 500);
  }
  async function turnPage(next: number) {
    if (switching || !ready || next === page) return;
    setSwitching(true);
    try { await flush.current(); await callbacks.current.onPage(next); setPage(next); }
    catch (e) { setError((e as Error).message); }
    finally { setSwitching(false); }
  }
  function point(event: PointerEvent<SVGSVGElement>): InkPoint {
    const box = event.currentTarget.getBoundingClientRect();
    return {x: Math.max(0, Math.min(1, (event.clientX - box.x) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.y) / box.height))};
  }
  function erase(event: PointerEvent<SVGSVGElement>) {
    const id = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-ink-id]')?.getAttribute('data-ink-id');
    if (id && ink.current) { ink.current.change(ink.current.strokes.filter(s => s.id !== id)); changed(); }
  }
  function start(event: PointerEvent<SVGSVGElement>) {
    if (!ready || switching || gesture.current || event.button !== 0) return;
    event.preventDefault(); event.currentTarget.focus({preventScroll: true}); event.currentTarget.setPointerCapture(event.pointerId);
    const stroke = tool === 'pen' ? {id: crypto.randomUUID(), color, width: .0025, points: [point(event)]} : undefined;
    gesture.current = {id: event.pointerId, stroke, x: event.clientX, y: event.clientY, left: scroll.current?.scrollLeft || 0, top: scroll.current?.scrollTop || 0};
    if (stroke) setDraft(stroke); if (tool === 'eraser') erase(event);
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const g = gesture.current; if (!g || g.id !== event.pointerId) return;
    if (g.stroke) { if (g.stroke.points.length < 4095) g.stroke.points.push(point(event)); setDraft({...g.stroke}); }
    else if (tool === 'pan') scroll.current?.scrollTo(g.left + g.x - event.clientX, g.top + g.y - event.clientY);
    else erase(event);
  }
  function finish(event: PointerEvent<SVGSVGElement>, cancel = false) {
    const g = gesture.current; if (!g || g.id !== event.pointerId) return;
    gesture.current = null; setDraft(undefined);
    if (g.stroke && !cancel && ink.current) { g.stroke.points.push(point(event)); ink.current.change([...ink.current.strokes, g.stroke]); changed(); }
  }
  function downloadInk() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({document: material.id, page, strokes: ink.current?.strokes || []})], {type: 'application/json'}));
    const a = document.createElement('a'); a.href = url; a.download = `${material.name}-第${page}页笔迹.json`; a.click(); URL.revokeObjectURL(url);
  }
  return <section className="material-reader" aria-label="教材工作区">
    <div className="paper-toolbar">
      <div className="paper-tools" role="toolbar" aria-label="教材批注工具">{([['pen', '书写', 'pen'], ['eraser', '擦除', 'eraser'], ['pan', '移动', 'hand']] as const).map(([value, name, icon]) => <button key={value} disabled={!ready || switching} aria-pressed={tool === value} onClick={() => setTool(value)}><Icon name={icon}/>{name}</button>)}
        <div className="ink-colors">{(['#202632', '#2563eb', '#d44242'] as const).map((c, i) => <button key={c} aria-label={['黑色笔', '蓝色笔', '红色笔'][i]} aria-pressed={color === c} onClick={() => { setColor(c); setTool('pen'); }} style={{'--ink': c} as React.CSSProperties}/>)}</div>
        <button aria-label="撤销批注" disabled={!ink.current?.canUndo} onClick={() => { ink.current?.undo(); changed(); }}><Icon name="undo"/></button><button aria-label="重做批注" disabled={!ink.current?.canRedo} onClick={() => { ink.current?.redo(); changed(); }}><Icon name="redo"/></button>
      </div><div className="paper-pages"><button aria-label="上一页" disabled={page <= 1 || !ready || switching} onClick={() => void turnPage(page - 1)}>‹</button><span>第 {page} / {pdf?.numPages || material.pages} 页</span><button aria-label="下一页" disabled={page >= (pdf?.numPages || material.pages) || !ready || switching} onClick={() => void turnPage(page + 1)}>›</button><select aria-label="教材缩放" value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value={1}>适应宽度</option><option value={1.5}>150%</option><option value={2}>200%</option></select><button aria-label="返回课堂" onClick={close}><Icon name="board"/>白板</button></div>
    </div>
    {error && <div className="paper-error" role="alert">{error}<button onClick={downloadInk}>导出本页笔迹</button></div>}
    <div className={`paper-scroll tool-${tool}`} ref={scroll}><div className="paper-sheet" style={{width: `${zoom * 100}%`, aspectRatio: `1 / ${ratio}`}}>
      <canvas ref={canvas} aria-label={`教材第 ${page} 页`}/>
      <svg data-testid="material-ink" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="教材批注画布" tabIndex={0} onPointerDown={start} onPointerMove={move} onPointerUp={e => finish(e)} onPointerCancel={e => finish(e, true)} onLostPointerCapture={e => finish(e, true)} onKeyDown={e => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) ink.current?.redo(); else ink.current?.undo(); changed(); }
      }}>
        {[...strokes, ...(draft ? [draft] : [])].map(s => <path key={s.id} data-ink-id={s.id} d={inkPath(s.points)} fill="none" stroke={s.color} strokeWidth={s.width * 1000} strokeLinecap="round" strokeLinejoin="round"/>)}
      </svg>{!ready && !error && <div className="paper-loading">正在打开教材…</div>}
    </div></div><div className="paper-save" role="status">{status}{status === '保存失败' && <><button onClick={() => void flush.current().catch(e => setError(e.message))}>重试保存</button><button onClick={downloadInk}>导出笔迹</button></>}</div>
  </section>;
}
