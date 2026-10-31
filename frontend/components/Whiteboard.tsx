'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Tldraw, Editor, getSnapshot, loadSnapshot, toRichText, createShapeId } from 'tldraw';
import { getAssetUrls } from '@tldraw/assets/selfHosted';
import { api, Lesson, Turn } from '@/lib/api';
import { ObservationGate } from '@/lib/observation-gate';

const assetUrls = getAssetUrls({ baseUrl: '/tldraw/' });

export default function Whiteboard({ lesson, onResult, onError, annotation, disabled, live }: {
  lesson: Lesson; onResult: (result: Turn) => void; onError: (message: string) => void;
  annotation: string; disabled: boolean; live: boolean;
}) {
  const editor = useRef<Editor | null>(null);
  const [auto, setAuto] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [status, setStatus] = useState('自动保存');
  const gate = useRef(new ObservationGate());
  const busy = useRef(false);
  const saver = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<Promise<unknown>>(Promise.resolve());
  const observer = useRef<(trigger: 'idle' | 'explicit') => Promise<void>>(async () => {});
  const save = useCallback((ed: Editor) => {
    const snapshot = getSnapshot(ed.store);
    pendingSave.current = pendingSave.current.catch(() => {}).then(() => api(`/api/lessons/${lesson.id}/board`, { method: 'PUT', body: JSON.stringify({ snapshot }) })).then(() => setStatus('已保存到本机')).catch(() => setStatus('保存失败，请保持此页面并重试'));
  }, [lesson.id]);

  const observe = useCallback(async (trigger: 'idle' | 'explicit') => {
    const ed = editor.current;
    if (!ed || busy.current || disabled) return;
    const ids = ed.getCurrentPageShapes().filter(shape => shape.meta.author !== 'teacher').map(shape => shape.id);
    if (!ids.length) { setStatus('先在白板写下一步推导。'); return; }
    busy.current = true; setAnalyzing(true); gate.current.sent(Date.now());
    try {
      const bounds = ed.getCurrentPageBounds();
      const scale = bounds ? Math.min(1, 1200 / Math.max(bounds.width, bounds.height)) : 1;
      const { blob } = await ed.toImage([...ids], { format: 'png', scale, background: true, padding: 20 });
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
      await pendingSave.current;
      const result = await api<Turn>(`/api/lessons/${lesson.id}/observe`, { method: 'POST', body: JSON.stringify({ image: data, trigger, step_complete: trigger === 'explicit' }) });
      if (result.skipped) setStatus(result.skipped);
      else {
        onResult(result);
        setStatus(result.observation ? '识别结果待核对，请打开“区域识别与核对”。' : '观察完成');
      }
    } catch (error) { onError((error as Error).message); }
    finally { busy.current = false; setAnalyzing(false); }
  }, [disabled, lesson.id, onError, onResult]);
  useEffect(() => { observer.current = observe; }, [observe]);
  useEffect(() => {
    if (!auto || disabled) return;
    // Local event scheduling only: this does NOT take screenshots periodically.
    const check = setInterval(() => { if (gate.current.ready(Date.now(), auto, busy.current)) void observer.current('idle'); }, 1000);
    return () => clearInterval(check);
  }, [auto, disabled]);
  useEffect(() => () => { if (saver.current) clearTimeout(saver.current); if (editor.current) save(editor.current); }, [save]);

  function mount(ed: Editor) {
    editor.current = ed;
    ed.user.updateUserPreferences({ locale: 'zh-cn' });
    if (lesson.board) {
      try { loadSnapshot(ed.store, lesson.board as Parameters<typeof loadSnapshot>[1]); }
      catch { setStatus('历史白板格式不兼容，未恢复；请导出数据保留原快照。'); }
    }
    const unsubscribe = ed.store.listen(() => {
      if (saver.current) clearTimeout(saver.current);
      setStatus('保存中…');
      saver.current = setTimeout(() => save(ed), 600);
    }, { scope: 'document' });
    const userChanges = ed.store.listen(() => gate.current.edit(Date.now()), { source: 'user', scope: 'document' });
    return () => { unsubscribe(); userChanges(); };
  }
  function addNote() {
    const ed = editor.current;
    if (!ed || !annotation) return;
    const bounds = ed.getCurrentPageBounds();
    ed.store.mergeRemoteChanges(() => ed.createShape({ id: createShapeId(), meta: { author: 'teacher' }, type: 'note', x: bounds ? bounds.maxX + 30 : 80, y: bounds ? bounds.y : 80,
      props: { color: 'light-blue', richText: toRichText(annotation.slice(0, 400)) } }));
    save(ed);
    ed.zoomToFit({ animation: { duration: 200 } });
  }
  return <section className="board-panel">
    <div className="board-toolbar"><h2>白板</h2><div className="board-actions">
      <label className="checkbox-row" title={live ? '停笔三秒后按需观察，最短间隔二十秒' : '连接真实视觉模型后可用'}><input type="checkbox" checked={auto} disabled={!live} onChange={e => setAuto(e.target.checked)} />自动观察</label>
      <button disabled={!annotation} onClick={addNote}>添加老师便签</button>
      <button disabled={analyzing || disabled} onClick={() => void observe('explicit')}>{analyzing ? '正在观察…' : '请看这一步'}</button>
    </div></div>
    {lesson.current_exercise && <div className="exercise-strip"><span>题目</span>{lesson.current_exercise}</div>}
    <div className="canvas"><Tldraw onMount={mount} assetUrls={assetUrls} licenseKey={process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY} /></div>
    <div className="board-status"><span role="status">{status}</span></div>
  </section>;
}
