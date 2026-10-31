'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import Settings from '@/components/Settings';
import MaterialReader from '@/components/MaterialReader';
import type { BoardController } from '@/lib/whiteboard/types';
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
  const [conversationOpen, setConversationOpen] = useState(true);
  const [reading, setReading] = useState<Material | null>(null);
  const board = useRef<BoardController | null>(null);
  const boardReady = useCallback((controller: BoardController | null) => { board.current = controller; }, []);
  const [loading, setLoading] = useState(true);
  const [desktop, setDesktop] = useState(false);
  const [mode, setMode] = useState<'policy' | 'baseline'>('policy');
  const [form, setForm] = useState({ name: 'Alex', subject: 'A-level 数学', language: '中文', style: '耐心、善于启发', preferences: '先提示，再解释', default_role: 'fast' });
  const messagesEnd = useRef<HTMLDivElement>(null);
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
  const voice = useVoice(lesson, modal === null, receive, report);
  const send = useCallback(async (event = 'message', text = '') => {
    if (!lesson) return;
    if (voice.active) {
      if (event === 'end' || event === 'pause') await voice.stop();
      else { if (voice.send(text, event)) setDraft(''); return; }
    }
    setBusy(true); setError('');
    try { if (event === 'end') await board.current?.flush(); const result = await api<Turn>(`/api/lessons/${lesson.id}/turn`, { method: 'POST', body: JSON.stringify({ event, text }) }); receive(result); if (event === 'message' || event === 'topic') setDraft(''); }
    catch (e) { report((e as Error).message); void refresh(lesson); }
    finally { setBusy(false); }
  }, [lesson, receive, report, refresh, voice]);
  useEffect(() => {
    if (!lesson?.last_decision?.auto || lesson.paused || busy || draft || voice.active) return;
    const timer = setTimeout(() => void send('auto'), 1600);
    return () => clearTimeout(timer);
  }, [lesson, busy, draft, send, voice.active]);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [lesson?.messages, busy]);

  async function openTeacher(t: Teacher, selectedMode = mode) {
    setBusy(true); setError('');
    try {
      await board.current?.flush();
      const current = await api<Lesson>(`/api/teachers/${t.id}/lessons`, { method: 'POST', body: JSON.stringify({ mode: selectedMode }) });
      activeLesson.current = current.id; setTeacher(t); setLesson(current); setSources([]); setDraft(''); setView('classroom'); setReading(null); setNavigationOpen(false); localStorage.setItem('banxue.lastTeacher', t.id); await refresh(current);
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
    try { await api(`/api/teachers/${teacher.id}`, { method: 'DELETE' }); setTeachers(ts => ts.filter(t => t.id !== teacher.id)); setTeacher(null); setLesson(null); activeLesson.current = null; localStorage.removeItem('banxue.lastTeacher'); setModal(null); }
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
      await board.current?.flush();
      if (window.desktop) await window.desktop.exportTeacher(teacher.id);
      else {
        const data = await api(`/api/teachers/${teacher.id}/export`);
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = `${teacher.name}-学习记录.json`; a.click(); URL.revokeObjectURL(url);
      }
    } catch (e) { report((e as Error).message); }
  }
  const views = { classroom: '课堂', materials: '教材', memory: '学习记录', cost: '用量' } as const;

  function navigate(next: typeof view) { setView(next); setNavigationOpen(false); setReading(null); }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !modal) { setView('classroom'); setReading(null); setNavigationOpen(false); } };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [modal]);

  return <main className={`app classroom-app ${desktop ? 'desktop-app' : ''} ${navigationOpen ? 'navigation-open' : ''}`}>
    <header className="windowbar"><span className="app-name">伴学</span><span className="window-title">{teacher?.subject || '课堂'}</span><button className="navigation-toggle" aria-label="课堂菜单" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(value => !value)}><Icon name="menu"/>课堂菜单</button></header>
    {navigationOpen && <button className="navigation-scrim" aria-label="关闭课堂菜单" onClick={() => setNavigationOpen(false)}/> }
    <aside className="sidebar" hidden={!navigationOpen}>
      <div className="sidebar-group-title"><span>老师</span><button className="icon-button" aria-label="添加老师" onClick={() => setModal('teacher')}><Icon name="plus" size={14}/></button></div>
      <nav className="teachers" aria-label="老师">{teachers.map(t => <button className={`teacher-item ${teacher?.id === t.id ? 'selected' : ''}`} key={t.id} disabled={busy} onClick={() => void openTeacher(t)}><span className="avatar" aria-hidden="true">{t.name.slice(0, 1)}</span><span className="teacher-label"><strong>{t.name}</strong><small>{t.subject}</small></span></button>)}</nav>
      {!teachers.length && <button className="add-teacher" onClick={() => setModal('teacher')}><Icon name="plus" size={14}/>添加老师</button>}
      <nav className="section-nav" aria-label="工作区">{(['classroom', 'materials', 'memory'] as const).map(v => <button key={v} disabled={!teacher} className={view === v && teacher ? 'active' : ''} onClick={() => navigate(v)}><Icon name={v === 'classroom' ? 'board' : v === 'materials' ? 'book' : 'history'}/>{views[v]}{v === 'materials' && materials.length > 0 && <span className="nav-count">{materials.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><button disabled={!teacher} className={view === 'cost' ? 'active' : ''} onClick={() => navigate('cost')}><Icon name="cost"/>用量{usage && <span className="nav-count">£{usage.estimated_cost_gbp.toFixed(2)}</span>}</button><button onClick={() => setModal('settings')}><Icon name="settings"/>设置<span className="shortcut">⌘,</span></button></div>
    </aside>
    <div className="main-area">
      <header className="toolbar"><div className="toolbar-title">
        {lesson ? <><div className="class-title"><h1>课堂</h1></div><span className="state-pill">{lesson.paused ? '已暂停' : STATE_NAMES[lesson.state]}</span></> : <h1>我的老师</h1>}
      </div><div className="toolbar-actions">
        {config?.mode === 'demo' && <span className="demo-indicator">文字演示模式</span>}
        {lesson && <><button aria-label="教材" onClick={() => navigate(view === 'materials' ? 'classroom' : 'materials')} aria-pressed={view === 'materials'}><Icon name="book"/>教材{materials.length ? <span className="material-count">{materials.length}</span> : null}</button><button aria-expanded={conversationOpen} onClick={() => setConversationOpen(value => !value)}><Icon name="chat"/>{conversationOpen ? '收起讲解' : '展开讲解'}</button></>}
      </div></header>
      {error && <div className="error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="关闭错误"><Icon name="close" size={14}/></button></div>}
      <input ref={fileInput} type="file" accept="application/pdf" hidden onChange={e => void upload(e.target.files?.[0])}/>
      {!lesson ? <div className="empty-workspace">{loading ? <p>正在打开课堂…</p> : <><Icon name="teacher" size={38}/><h2>{teachers.length ? '选择一位老师' : '还没有老师'}</h2><button onClick={() => setModal('teacher')} className="primary"><Icon name="plus" size={14}/>添加老师</button></>}</div> : <>
        <div className={`classroom ${conversationOpen ? '' : 'conversation-collapsed'}`} inert={view !== 'classroom' || navigationOpen}><div className="workspace"><Whiteboard key={lesson.id} lesson={lesson} onResult={receive} onError={report} annotation={annotation} disabled={busy || lesson.paused || lesson.state === 'SESSION_SUMMARY'} live={config?.mode === 'live' && !voice.active} onReady={boardReady}/></div>
          <section className="conversation" hidden={!conversationOpen}><div className="chat-header"><div><strong>{teacher?.name}</strong></div><button className="icon-button" aria-label="收起讲解面板" onClick={() => setConversationOpen(false)}><Icon name="close"/></button></div><div className="chat-scroll">{lesson.messages.map((m, i) => <div key={i} className={`message ${m.role}`}><span className="message-author">{m.role === 'user' ? '你' : teacher?.name}</span><div>{m.content}</div></div>)}{voice.text && <div className="message assistant"><span className="message-author">{teacher?.name}</span><div>{voice.text}</div></div>}{busy && <div className="thinking">正在处理…</div>}<div ref={messagesEnd}/></div>
            {sources.length > 0 && <details className="chat-sources"><summary>本轮参考了 {sources.length} 处教材</summary>{sources.map((s, i) => <p key={i}>{materials.find(d => d.id === s.document_id)?.name || '教材'} · 第 {s.page} 页</p>)}</details>}
            <div className="quick-actions"><button disabled={busy} onClick={() => void send('hint')}>给一点提示</button><button disabled={busy} onClick={() => void send('reexplain')}>重新解释</button></div>
            <form className="composer" onSubmit={e => { e.preventDefault(); if (draft.trim()) void send('message', draft); }}><textarea aria-label="给老师的消息" placeholder="消息" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (draft.trim() && !busy) void send('message', draft); } }}/><div><button type="button" className="text-button" disabled={!draft.trim() || busy} onClick={() => void send('topic', draft)}>另一个问题</button><button type="submit" className="send" aria-label="发送消息" disabled={!draft.trim() || busy}><Icon name="send" size={17}/></button></div></form>
          </section></div>
        <footer className="lesson-dock">
          <VoiceControls voice={voice} canAdvance={['PLANNING', 'EXPLAINING'].includes(lesson.state)} disabled={busy || lesson.paused || lesson.state === 'SESSION_SUMMARY'} edit={text => { voice.stopTeacher(); setDraft(text); setConversationOpen(true); }}/>
          <div className="lesson-controls"><button onClick={() => void send(lesson.paused ? 'resume' : 'pause')} disabled={busy || lesson.state === 'SESSION_SUMMARY'}><Icon name={lesson.paused ? 'play' : 'pause'}/>{lesson.paused ? '继续上课' : '暂停'}</button>{lesson.state === 'SESSION_SUMMARY' ? <button className="primary" disabled={busy} onClick={() => teacher && void openTeacher(teacher)}>开始下一节</button> : <button className="end-lesson" disabled={busy} onClick={() => void send('end')}>结束本节</button>}</div>
        </footer>
        {view !== 'classroom' && <div className="resource-overlay" role="region" aria-label={views[view]}><div className="resource-toolbar"><div><strong>{views[view]}</strong></div><div>{view === 'materials' && <button onClick={() => fileInput.current?.click()} disabled={busy}><Icon name="plus"/>导入 PDF</button>}<button onClick={() => navigate('classroom')} aria-label="返回课堂"><Icon name="close"/>返回课堂</button></div></div>
        {view === 'materials' && reading && teacher ? <MaterialReader teacherId={teacher.id} material={reading} close={() => setReading(null)}/> : view === 'materials' && <section className="document-view"><div className="view-heading"><h2>教材与试卷</h2></div>{!materials.length ? <button className="import-empty" disabled={busy} onClick={() => fileInput.current?.click()}><Icon name="upload" size={24}/><strong>导入 PDF</strong><span>教材、试卷或评分标准 · 最大 20 MB</span></button> : <div className="file-list"><div className="file-list-header"><span>名称</span><span>页数</span><span>解析状态</span></div>{materials.map(d => <div className="document-row" key={d.id}><div><Icon name="book" size={18}/><span><button className="document-open" onClick={() => setReading(d)}>{d.name}</button><small>{d.scope}</small></span></div><span>{d.pages}</span><span className={d.status === 'OCR_REQUIRED' ? 'warning-text' : ''}>{d.status === 'OCR_REQUIRED' ? `有 ${d.unreadable_pages.length} 页需 OCR` : '已提取文本'}</span></div>)}</div>}{sources.length > 0 && <div className="retrieved"><h3>最近引用</h3>{sources.map((s, i) => <details key={i}><summary>{materials.find(d => d.id === s.document_id)?.name || '教材'} · 第 {s.page} 页</summary><p>{s.content}</p></details>)}</div>}</section>}
        {view === 'memory' && <section className="document-view"><div className="view-heading"><h2>学习记录</h2></div>{memory.length ? <table className="records-table"><thead><tr><th>知识点</th><th>已记录的回答</th><th>下次复习</th></tr></thead><tbody>{memory.map(k => <tr key={k.topic}><td>{topicNames[k.topic] || k.topic}</td><td><strong>{k.correct}</strong> / {k.attempts} 次正确<small>证据 {k.evidence.length} 条</small></td><td>{new Date(k.next_review).toLocaleDateString('zh-CN')}</td></tr>)}</tbody></table> : <p className="empty-line">暂无记录。</p>}<div className="data-actions"><button onClick={() => void exportData()}><Icon name="export" size={14}/>导出全部数据</button><button className="danger-text" onClick={() => setModal('delete')}>删除这位老师及记录…</button></div></section>}
        {view === 'cost' && <section className="document-view"><div className="view-heading"><h2>本节用量</h2><p>{config?.mode === 'demo' && !usage?.requests.length ? '演示文字模式未调用模型；千问语音独立启用和计费。' : '费用按你设置的单价估算，供应商账单可能不同。'}</p></div><div className="usage-summary"><div><span>估算费用</span><strong>£{(usage?.estimated_cost_gbp || 0).toFixed(5)}</strong></div><div><span>输入 Token</span><strong>{usage?.input_tokens || 0}</strong></div><div><span>输出 Token</span><strong>{usage?.output_tokens || 0}</strong></div><div><span>本节预算</span><strong>£{config?.budgets.session}</strong></div></div>{usage?.requests.length ? <table className="records-table"><thead><tr><th>模型</th><th>状态</th><th>延迟</th><th>估算费用</th></tr></thead><tbody>{usage.requests.map(r => <tr key={r.id}><td>{r.model}<small>{r.role} · 缓存 {r.cached_tokens ?? '未知'}</small></td><td>{r.status}<small>{r.usage_source}</small></td><td>{r.latency_ms ?? '—'} ms</td><td>£{r.estimated_cost_gbp.toFixed(5)}</td></tr>)}</tbody></table> : <p className="empty-line">暂无模型请求。</p>}</section>}
        </div>}
      </>}
    </div>
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)}><section className={`dialog ${modal === 'settings' ? 'settings-dialog' : ''}`} role="dialog" aria-modal="true" aria-label={modal === 'teacher' ? '添加老师' : modal === 'settings' ? '设置' : '删除数据'} onClick={e => e.stopPropagation()}>
      {modal === 'settings' ? <Settings config={config} mode={mode} onMode={setMode} onClose={() => setModal(null)}/> : <>
        <div className="dialog-title"><h2>{modal === 'teacher' ? '添加老师' : '删除老师'}</h2><button className="icon-button" onClick={() => setModal(null)} aria-label="关闭"><Icon name="close"/></button></div>
        {modal === 'teacher' && <form onSubmit={createTeacher}><div className="dialog-body"><label className="field">老师姓名<input required maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} autoFocus/></label><label className="field">教授科目<input required maxLength={100} value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })}/></label><label className="field">教学语言<input required maxLength={40} value={form.language} onChange={e => setForm({ ...form, language: e.target.value })}/></label><details className="advanced"><summary>教学偏好</summary><label className="field">风格<input maxLength={300} value={form.style} onChange={e => setForm({ ...form, style: e.target.value })}/></label><label className="field">偏好<input maxLength={500} value={form.preferences} onChange={e => setForm({ ...form, preferences: e.target.value })}/></label><label className="field">默认模型<select value={form.default_role} onChange={e => setForm({ ...form, default_role: e.target.value })}><option value="fast">日常交流模型</option><option value="reasoning">推理模型</option></select></label></details><p className="field-help">当前诊断课程覆盖 A-level 多项式求导。</p></div><div className="dialog-footer"><button type="button" onClick={() => setModal(null)}>取消</button><button disabled={busy} className="primary" type="submit">创建并上课</button></div></form>}
        {modal === 'delete' && <><div className="dialog-body"><p>删除 {teacher?.name} 的课堂、教材、白板和学习记录？此操作无法撤销。</p><button onClick={() => void exportData()}>先导出数据</button></div><div className="dialog-footer"><button onClick={() => setModal(null)}>取消</button><button className="danger" onClick={() => void removeTeacher()}>删除全部关联数据</button></div></>}
      </>}
    </section></div>}
  </main>;
}
