'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import Settings from '@/components/Settings';
import MaterialReader, { type MaterialController } from '@/components/MaterialReader';
import './classroom.css';
import ObservationReview from '@/components/ObservationReview';
import { useClassroomBoard } from '@/lib/use-classroom-board';
import type { BoardController, BoardEvent } from '@/lib/whiteboard/types';
import VoiceControls from '@/components/VoiceControls';
import { useVoice } from '@/lib/use-voice';
import Icon from '@/components/Icon';
import '@/lib/desktop';
import { api, Config, Teacher, Lesson, Turn, Source, Material, Knowledge, Usage, STATE_NAMES } from '@/lib/api';
const Whiteboard = dynamic(() => import('@/components/Whiteboard'), { ssr: false, loading: () => <div className="loading">正在准备白板…</div> });
const topicNames: Record<string, string> = { chain_rule: '链式法则', product_rule: '乘积法则', power_rule: '幂函数求导' };

export default function Home() {
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [teacher, setTeacher] = useState<Teacher | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [memory, setMemory] = useState<Knowledge[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<'teacher' | 'settings' | 'delete' | null>(null);
  const [view, setView] = useState<'classroom' | 'materials' | 'memory' | 'cost'>('classroom');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [reading, setReading] = useState<Material | null>(null);
  const [materialVisible, setMaterialVisible] = useState(false);
  const [readingPage, setReadingPage] = useState(1);
  const [captions, setCaptions] = useState(true);
  const materialBoard = useRef<MaterialController | null>(null);
  const materialReady = useCallback((controller: MaterialController | null) => {materialBoard.current = controller;}, []);
  const board = useRef<BoardController | null>(null);
  const [boardRevision, setBoardRevision] = useState<number>();
  const [loading, setLoading] = useState(true);
  const [desktop, setDesktop] = useState(false);
  const [mode, setMode] = useState<'policy' | 'baseline'>('policy');
  const [form, setForm] = useState({ name: 'Alex', subject: 'A-level 数学', language: '中文', style: '耐心、善于启发', preferences: '先提示，再解释', default_role: 'fast' });
  const messagesEnd = useRef<HTMLDivElement>(null);
  const resumeVoice = useRef(false);
  const activeLesson = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const report = useCallback((message: string) => setError(message), []);
  useEffect(() => {
    setDesktop(!!window.desktop);
    if (window.matchMedia('(max-width: 800px)').matches) setConversationOpen(false);
    Promise.all([api<Teacher[]>('/api/teachers'), api<Config>('/api/config')]).then(async ([t, c]) => {
      setTeachers(t); setConfig(c);
      const last = localStorage.getItem('banxue.lastTeacher');
      const chosen = t.find(x => x.id === last) || t[0];
      if (chosen) await openTeacher(chosen);
    }).catch(e => report('课堂服务无法连接。' + e.message)).finally(() => setLoading(false));
    // Initialize once; subsequent teacher changes are explicit user actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const refresh = useCallback(async (current: Lesson) => {
    const [u, m, d] = await Promise.all([api<Usage>(`/api/lessons/${current.id}/usage`), api<Knowledge[]>(`/api/teachers/${current.teacher_id}/memory`), api<Material[]>(`/api/teachers/${current.teacher_id}/documents`)]);
    if (activeLesson.current === current.id) { setUsage(u); setMemory(m); setMaterials(d); }
  }, []);
  const receive = useCallback((result: Turn) => {
    if (activeLesson.current !== result.lesson.id) return;
    setLesson(result.lesson); setSources(result.sources || []);
    void refresh(result.lesson).catch(e => report(e.message));
  }, [refresh, report]);
  const voice = useVoice(lesson, true, receive, report);
  const classroomBoard = useClassroomBoard(lesson, report, voice.subscribe);
  const attachBoard = classroomBoard.onReady;
  const handleBoardEvent = classroomBoard.onBoardEvent;
  const boardReady = useCallback((controller: BoardController | null) => {
    board.current = controller; setBoardRevision(controller?.getSnapshot().revision); attachBoard(controller);
  }, [attachBoard]);
  const boardChanged = useCallback((event: BoardEvent) => {
    if (event.type === 'edit') setBoardRevision(event.revision);
    handleBoardEvent(event);
  }, [handleBoardEvent]);
  const beforeConfirm = useCallback(async () => {
    const controller = board.current;
    if (!controller) throw new Error('白板尚未就绪。');
    controller.pause(); await controller.flush(); return controller.getSnapshot().revision;
  }, []);
  const send = useCallback(async (event = 'message', text = '') => {
    if (!lesson) return;
    if (event !== 'auto') classroomBoard.pauseForInput();
    if (voice.active) {
      if (event === 'end' || event === 'pause') {resumeVoice.current = event === 'pause'; setBusy(true); await voice.stop();}
      else { if (voice.send(text, event)) setDraft(''); else classroomBoard.inputSettled(); return; }
    }
    setBusy(true); setError('');
    try { if (event === 'end') await flushClassroom(); const result = await api<Turn>(`/api/lessons/${lesson.id}/turn`, { method: 'POST', body: JSON.stringify({ event, text }) }); receive(result); if (event === 'message' || event === 'topic') setDraft(''); }
    catch (e) { report((e as Error).message); void refresh(lesson); }
    finally { setBusy(false); classroomBoard.inputSettled(); }
  }, [lesson, receive, report, refresh, voice, classroomBoard]);
  useEffect(() => {
    if (materialVisible || modal || !lesson?.last_decision?.auto || lesson.paused || lesson.pending_observation_id || busy || draft || voice.active) return;
    const timer = setTimeout(() => void send('auto'), 1600);
    return () => clearTimeout(timer);
  }, [lesson, busy, draft, send, voice.active, materialVisible, modal]);
  useEffect(() => {
    if (resumeVoice.current && lesson && !lesson.paused && !busy && lesson.state !== 'SESSION_SUMMARY') { resumeVoice.current = false; void voice.start(); }
  }, [lesson, busy, voice]);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [lesson?.messages, busy]);

  async function openTeacher(t: Teacher, selectedMode = mode) {
    setBusy(true); setError('');
    try {
      await flushClassroom();
      resumeVoice.current = false; await voice.stop();
      const current = await api<Lesson>(`/api/teachers/${t.id}/lessons`, { method: 'POST', body: JSON.stringify({ mode: selectedMode }) });
      activeLesson.current = current.id; setTeacher(t); setLesson(current); setSources([]); setDraft(''); setView('classroom'); setReading(null); setMaterialVisible(false); setReadingPage(current.classroom?.page || 1); setNavigationOpen(false); localStorage.setItem('banxue.lastTeacher', t.id); await refresh(current);
      const docs = await api<Material[]>(`/api/teachers/${t.id}/documents`);
      if (activeLesson.current === current.id && current.classroom?.document_id) { const document = docs.find(d => d.id === current.classroom?.document_id); setReading(document || null); setMaterialVisible(!!document); }
    } catch (e) { report((e as Error).message); }
    finally { setBusy(false); }
  }
  async function createTeacher(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { const t = await api<Teacher>('/api/teachers', { method: 'POST', body: JSON.stringify(form) }); setTeachers(old => [...old, t]); setModal(null); await openTeacher(t); }
    catch (e) { report((e as Error).message); }
    finally { setBusy(false); }
  }
  async function upload(file?: File) {
    if (!file || !teacher || !lesson) return;
    setBusy(true); setError('');
    try {
      const body = new FormData(); body.append('file', file); body.append('scope', lesson.profile.exam_board || '用户上传，考纲范围未核验');
      await api(`/api/teachers/${teacher.id}/documents`, { method: 'POST', body }); await refresh(lesson); setView('materials');
    } catch (e) { report((e as Error).message); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }
  async function removeTeacher() {
    if (!teacher) return;
    try { await voice.stop(); await api(`/api/teachers/${teacher.id}`, { method: 'DELETE' }); setTeachers(ts => ts.filter(t => t.id !== teacher.id)); setTeacher(null); setLesson(null); activeLesson.current = null; localStorage.removeItem('banxue.lastTeacher'); setModal(null); }
    catch (e) { report((e as Error).message); }
  }
  const annotation = lesson?.messages.filter(m => m.role === 'assistant').at(-1)?.content || '';

  useEffect(() => window.desktop?.onCommand(command => {
    if (command === 'settings' || command === 'teacher') setModal(command);
    if (command === 'upload') fileInput.current?.click();
  }), []);
  async function exportData() {
    if (!teacher) return;
    try {
      await flushClassroom();
      if (window.desktop) await window.desktop.exportTeacher(teacher.id);
      else {
        const data = await api(`/api/teachers/${teacher.id}/export`);
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = `${teacher.name}-学习记录.json`; a.click(); URL.revokeObjectURL(url);
      }
    } catch (e) { report((e as Error).message); }
  }
  const views = { classroom: '课堂', materials: '教材', memory: '学习记录', cost: '用量' } as const;

  function navigate(next: typeof view) { setView(next); setNavigationOpen(false); }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key !== 'Escape') return; if (modal) { setModal(null); return; } setView('classroom'); setConversationOpen(false); setNavigationOpen(false); };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [modal]);

  async function flushClassroom() { await materialBoard.current?.flush(); await board.current?.flush(); }
  async function openMaterial(document: Material) {
    if (!lesson || busy) return;
    try {
      await flushClassroom();
      const page = reading?.id === document.id ? readingPage : 1;
      await api(`/api/lessons/${lesson.id}/classroom`, {method: 'PUT', body: JSON.stringify({document_id: document.id, page})});
      setReadingPage(page); setReading(document); setMaterialVisible(true); setView('classroom'); setConversationOpen(false);
    } catch (e) { report((e as Error).message); }
  }
  async function showBoard() {
    if (!lesson) return;
    try { await flushClassroom(); await api(`/api/lessons/${lesson.id}/classroom`, {method: 'PUT', body: JSON.stringify({document_id: null, page: 1})}); setMaterialVisible(false); }
    catch (e) { report((e as Error).message); }
  }
  async function saveReadingPage(page: number) {
    if (!lesson || !reading) return;
    await api(`/api/lessons/${lesson.id}/classroom`, {method: 'PUT', body: JSON.stringify({document_id: reading.id, page})}); setReadingPage(page);
  }
  const voiceNames = {off: '语音未连接', connecting: '正在连接', listening: '正在听', thinking: '正在思考', speaking: '正在讲解', paused: '已暂停'};
  return <main className={`app classroom-app meeting-room ${desktop ? 'desktop-app' : ''} ${navigationOpen ? 'navigation-open' : ''}`}>
    <header className="windowbar room-header"><div className="room-brand">伴学<span className="header-divider"/></div><div className="room-heading"><h1>{teacher?.subject || '我的老师'}</h1><span>{teacher ? `${teacher.name} · 一对一课堂` : '课堂'}</span></div><div className="room-header-actions">{lesson && <span className="state-pill">{lesson.paused ? '已暂停' : STATE_NAMES[lesson.state]}</span>}{config?.mode === 'demo' && <span className="demo-indicator">文字演示</span>}<button className="navigation-toggle" aria-label="课堂菜单" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(v => !v)}><Icon name="menu"/>课堂菜单</button></div></header>
    {navigationOpen && <button className="navigation-scrim" aria-label="关闭课堂菜单" onClick={() => setNavigationOpen(false)}/>}
    <aside className="sidebar" hidden={!navigationOpen}>
      <div className="sidebar-group-title"><span>老师</span><button className="icon-button" aria-label="添加老师" onClick={() => setModal('teacher')}><Icon name="plus"/></button></div>
      <nav className="teachers" aria-label="老师">{teachers.map(t => <button className={`teacher-item ${teacher?.id === t.id ? 'selected' : ''}`} key={t.id} disabled={busy} onClick={() => void openTeacher(t)}><span className="avatar" aria-hidden="true">{t.name.slice(0, 1)}</span><span className="teacher-label"><strong>{t.name}</strong><small>{t.subject}</small></span></button>)}</nav>
      {!teachers.length && <button className="add-teacher" onClick={() => setModal('teacher')}><Icon name="plus"/>添加老师</button>}
      <nav className="section-nav" aria-label="工作区">{(['classroom', 'materials', 'memory'] as const).map(v => <button key={v} disabled={!teacher} onClick={() => navigate(v)}><Icon name={v === 'classroom' ? 'board' : v === 'materials' ? 'book' : 'history'}/>{views[v]}</button>)}</nav>
      <div className="sidebar-bottom"><button disabled={!teacher} onClick={() => navigate('cost')}><Icon name="cost"/>用量</button><button onClick={() => { setNavigationOpen(false); setModal('settings'); }}><Icon name="settings"/>设置</button></div>
    </aside>
    <div className="main-area">
      {error && <div className="error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误"><Icon name="close"/></button></div>}
      <input ref={fileInput} type="file" accept="application/pdf" hidden onChange={e => void upload(e.target.files?.[0])}/>
      {!lesson ? <div className="room-empty">{loading ? <p>正在打开课堂…</p> : <><div className="empty-board-icon"><Icon name="board" size={38}/></div><h2>{teachers.length ? '选择老师，进入课堂' : '开始第一节课'}</h2><button onClick={() => teachers.length ? setNavigationOpen(true) : setModal('teacher')} className="primary">{teachers.length ? '选择老师' : '添加老师'}</button></>}</div> : <>
        <div className={`classroom room-body ${conversationOpen ? 'chat-open' : ''}`} inert={navigationOpen || modal !== null}>
          <div className="lesson-stage">
            <div className="stage-tabs"><div className="surface-tabs" role="tablist" aria-label="课堂内容"><button role="tab" aria-selected={!materialVisible} onClick={() => void showBoard()}><Icon name="board"/>课堂白板</button>{reading && <button role="tab" aria-selected={materialVisible} onClick={() => void openMaterial(reading)}><Icon name="book"/><span>{reading.name}</span></button>}</div><button className="stage-library" aria-label="教材" aria-pressed={view === 'materials'} onClick={() => navigate(view === 'materials' ? 'classroom' : 'materials')}><Icon name="folder"/>教材{materials.length ? ` ${materials.length}` : ''}</button></div>
            <div className="stage-surface">
              <div className="workspace" hidden={materialVisible}><Whiteboard key={lesson.id} lesson={lesson} onResult={receive} onError={report} annotation={annotation} disabled={busy || lesson.paused || lesson.state === 'SESSION_SUMMARY'} live={config?.mode === 'live' && !voice.active} onReady={boardReady} onBoardEvent={boardChanged} reviewControl={<ObservationReview key={`review-${lesson.id}`} lesson={lesson} disabled={busy || lesson.paused || lesson.state === 'SESSION_SUMMARY'} live={config?.mode === 'live'} voiceActive={voice.active} boardRevision={boardRevision} beforeConfirm={beforeConfirm} onResult={receive} onError={report}/>}/></div>
              {reading && teacher && <div className="material-surface" hidden={!materialVisible}><MaterialReader key={`${lesson.id}-${reading.id}`} lessonId={lesson.id} teacherId={teacher.id} material={reading} initialPage={readingPage} onPage={saveReadingPage} onReady={materialReady} close={() => void showBoard()}/></div>}
            </div>
            {captions && (voice.text || annotation) && <div className="classroom-caption"><span>{teacher?.name}</span><p>{voice.text || annotation}</p><button aria-label="展开完整讲解" onClick={() => {setConversationOpen(true); setView('classroom');}}><Icon name="chat"/></button></div>}
          </div>
          <aside className="participant-rail" aria-label="课堂成员"><div className={`participant teacher-participant ${voice.state === 'speaking' ? 'speaking' : ''}`}><div className="participant-avatar">{teacher?.name.slice(0, 1)}</div><div className="participant-label"><span>{teacher?.name}</span><Icon name="mic"/></div><span className="participant-state">{busy ? '正在处理' : voiceNames[voice.state]}</span></div><div className="participant student-participant"><div className="participant-avatar student-avatar">我</div><div className="participant-label"><span>你</span><Icon name="mic"/></div><span className="participant-state">{voice.active ? voice.muted ? '麦克风已静音' : '麦克风已开启' : '麦克风未开启'}</span></div></aside>
          {conversationOpen && view === 'classroom' && <section className="conversation"><div className="chat-header"><strong>课堂消息</strong><button className="icon-button" aria-label="收起讲解面板" onClick={() => setConversationOpen(false)}><Icon name="close"/></button></div><div className="chat-scroll">{lesson.messages.map((m, i) => <div key={i} className={`message ${m.role}`}><span className="message-author">{m.role === 'user' ? '你' : teacher?.name}</span><div>{m.content}</div></div>)}{voice.text && <div className="message assistant"><span className="message-author">{teacher?.name}</span><div>{voice.text}</div></div>}{busy && <div className="thinking">正在处理…</div>}<div ref={messagesEnd}/></div>
            {sources.length > 0 && <details className="chat-sources"><summary>本轮引用 {sources.length} 处教材</summary>{sources.map((s, i) => <p key={i}>{materials.find(d => d.id === s.document_id)?.name || '教材'} · 第 {s.page} 页</p>)}</details>}
            <div className="quick-actions"><button disabled={busy} onClick={() => void send('hint')}>给一点提示</button><button disabled={busy} onClick={() => void send('reexplain')}>重新解释</button></div>
            <form className="composer" onSubmit={e => { e.preventDefault(); if (draft.trim() && !busy) void send('message', draft); }}><textarea aria-label="给老师的消息" placeholder="发消息，或直接开麦说话" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (draft.trim() && !busy) void send('message', draft); } }}/><div><button type="button" className="text-button" disabled={!draft.trim() || busy} onClick={() => void send('topic', draft)}>另一个问题</button><button type="submit" className="send" aria-label="发送消息" disabled={!draft.trim() || busy}><Icon name="send"/></button></div></form>
          </section>}
          {view !== 'classroom' && <aside className="resource-overlay" role="region" aria-label={views[view]}><div className="resource-toolbar"><strong>{views[view]}</strong><button className="icon-button" onClick={() => navigate('classroom')} aria-label="关闭面板"><Icon name="close"/></button></div>
            {view === 'materials' && <section className="document-view"><button className="import-material" disabled={busy} onClick={() => fileInput.current?.click()}><Icon name="plus"/>导入 PDF</button>{!materials.length && <p className="empty-line">暂无教材</p>}<div className="classroom-file-list">{materials.map(d => <button className={`classroom-file ${materialVisible && reading?.id === d.id ? 'selected' : ''}`} key={d.id} onClick={() => void openMaterial(d)}><span className="pdf-icon">PDF</span><span><strong>{d.name}</strong><small>{d.pages} 页</small></span><Icon name="chevron"/></button>)}</div></section>}
            {view === 'memory' && <section className="document-view">{memory.length ? <table className="records-table"><thead><tr><th>知识点</th><th>记录</th></tr></thead><tbody>{memory.map(k => <tr key={k.topic}><td>{topicNames[k.topic] || k.topic}</td><td>{k.correct} / {k.attempts} 次</td></tr>)}</tbody></table> : <p className="empty-line">暂无记录</p>}<div className="data-actions"><button onClick={() => void exportData()}><Icon name="export"/>导出全部数据</button><button className="danger-text" onClick={() => setModal('delete')}>删除老师及记录</button></div></section>}
            {view === 'cost' && <section className="document-view"><span>本节估算费用</span><p className="cost-total">£{(usage?.estimated_cost_gbp || 0).toFixed(5)}</p><p>本节预算 £{config?.budgets.session}</p>{usage?.requests.map(r => <div className="cost-row" key={r.id}><span>{r.model}<small>{r.status} · {r.usage_source}</small></span><span>£{r.estimated_cost_gbp.toFixed(5)}</span></div>)}</section>}
          </aside>}
        </div>
        <footer className="lesson-dock room-dock"><VoiceControls voice={voice} canAdvance={['PLANNING', 'EXPLAINING'].includes(lesson.state)} disabled={busy || lesson.paused || lesson.state === 'SESSION_SUMMARY'} edit={text => {voice.stopTeacher(); setDraft(text); setConversationOpen(true); setView('classroom');}}/><div className="room-tools"><button aria-pressed={conversationOpen && view === 'classroom'} onClick={() => {setConversationOpen(v => !v || view !== 'classroom'); setView('classroom');}}><Icon name="chat" size={21}/>聊天</button><button aria-pressed={view === 'materials'} onClick={() => navigate(view === 'materials' ? 'classroom' : 'materials')}><Icon name="book" size={21}/>教材</button><button aria-pressed={captions} onClick={() => setCaptions(v => !v)}><Icon name="captions" size={21}/>字幕</button><button aria-label="课堂设置" onClick={() => setModal('settings')}><Icon name="settings" size={21}/>设置</button></div><div className="lesson-controls"><button onClick={() => void send(lesson.paused ? 'resume' : 'pause')} disabled={busy || lesson.state === 'SESSION_SUMMARY'}><Icon name={lesson.paused ? 'play' : 'pause'} size={21}/>{lesson.paused ? '继续上课' : '暂停'}</button>{lesson.state === 'SESSION_SUMMARY' ? <button className="primary" disabled={busy} onClick={() => teacher && void openTeacher(teacher)}>开始下一节</button> : <button className="end-lesson" disabled={busy} onClick={() => void send('end')}>下课</button>}</div></footer>
      </>}
    </div>
    {modal && <div className="modal-backdrop"><section className={`dialog ${modal === 'settings' ? 'settings-dialog' : ''}`} role="dialog" aria-modal="true" aria-label={modal === 'teacher' ? '添加老师' : modal === 'settings' ? '设置' : '删除数据'}>
      {modal === 'settings' ? <Settings config={config} mode={mode} onMode={setMode} onClose={() => setModal(null)} beforeApply={async () => {await flushClassroom(); await voice.stop();}}/> : <>
        <div className="dialog-title"><h2>{modal === 'teacher' ? '添加老师' : '删除老师'}</h2><button className="icon-button" onClick={() => setModal(null)} aria-label="关闭"><Icon name="close"/></button></div>
        {modal === 'teacher' && <form onSubmit={createTeacher}><div className="dialog-body"><label className="field">老师姓名<input required maxLength={60} value={form.name} onChange={e => setForm({...form, name: e.target.value})} autoFocus/></label><label className="field">教授科目<input required maxLength={100} value={form.subject} onChange={e => setForm({...form, subject: e.target.value})}/></label><label className="field">教学语言<input required maxLength={40} value={form.language} onChange={e => setForm({...form, language: e.target.value})}/></label></div><div className="dialog-footer"><button type="button" onClick={() => setModal(null)}>取消</button><button disabled={busy} className="primary" type="submit">创建并上课</button></div></form>}
        {modal === 'delete' && <><div className="dialog-body"><p>删除 {teacher?.name} 的课堂、教材、白板和学习记录？此操作无法撤销。</p><button onClick={() => void exportData()}>先导出数据</button></div><div className="dialog-footer"><button onClick={() => setModal(null)}>取消</button><button className="danger" onClick={() => void removeTeacher()}>删除全部关联数据</button></div></>}
      </>}
    </section></div>}
  </main>;
}
