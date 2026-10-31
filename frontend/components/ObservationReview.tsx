'use client';
import { useEffect, useState } from 'react';
import { api, Lesson, Turn } from '@/lib/api';
import { ObservationRecord, ObservedStep, RegionImage, readPng, staleBoardReason, submitRegion } from '@/lib/handwriting';

export default function ObservationReview({ lesson, disabled, live, onResult, onError, boardRevision, beforeConfirm, onSubmitting, voiceActive = false }: {
  boardRevision?: number; beforeConfirm?: () => Promise<number>; onSubmitting?: (submitting: boolean) => void; voiceActive?: boolean;
  lesson: Lesson; disabled: boolean; live: boolean; onResult: (result: Turn) => void; onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<RegionImage | null>(null);
  const [record, setRecord] = useState<ObservationRecord | null>(null);
  const [steps, setSteps] = useState<ObservedStep[]>([]);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [verifiedExpressions, setVerifiedExpressions] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState('');
  const [fixture, setFixture] = useState('fraction');
  const latest = lesson.latest_observation_id;

  useEffect(() => {
    if (!latest) return;
    let active = true;
    api<ObservationRecord>(`/api/lessons/${lesson.id}/observations/${latest}`).then(value => {
      if (!active) return;
      setVerifiedExpressions(new Set(value.reviewed?.steps.filter(s => s.expressions.length).map(s => s.id) || [])); setRecord(value); setSteps((value.reviewed || value.observation).steps);
      setImage(null); setResolutions(value.reviewed?.resolutions || {}); setSelected(0);
      if (value.status === 'pending') setOpen(true);
    }).catch(e => { if (active) onError(e.message); });
    return () => { active = false; };
  }, [lesson.id, latest, onError]);

  async function loadFixture() {
    try {
      const response = await fetch(`/handwriting/${fixture}.png`);
      if (!response.ok) throw new Error('测试图片读取失败。');
      setImage({ image: await readPng(await response.blob()), source: { kind: 'fixture', label: fixture } });
      setRecord(null); setStatus('固定合成测试图片；尚未识别。');
    } catch (e) { setStatus((e as Error).message); onError((e as Error).message); }
  }
  async function recognize() {
    if (!image || busy || disabled || voiceActive) return;
    setBusy(true); setStatus('正在读取选中区域…');
    try {
      const result = await submitRegion(lesson.id, image);
      if (result.skipped) setStatus(result.skipped);
      if (result.lesson) {
        onResult(result);
        if (result.observation) {
          const value = await api<ObservationRecord>(`/api/lessons/${lesson.id}/observations/${result.observation.id}`);
          setVerifiedExpressions(new Set(value.reviewed?.steps.filter(s => s.expressions.length).map(s => s.id) || [])); setRecord(value); setSteps((value.reviewed || value.observation).steps); setImage(null);
          setResolutions(value.reviewed?.resolutions || {}); setSelected(0);
          setStatus('请对照原图逐行核对；模型定位也可能有误。');
        }
      }
    } catch (e) { onError((e as Error).message); setStatus('未取得识别结果；未自动重试。'); }
    finally { setBusy(false); }
  }
  function change(index: number, patch: Partial<ObservedStep>) {
    setSteps(current => current.map((step, i) => i === index ? { ...step, ...patch } : step));
  }
  function move(index: number, delta: number) {
    const next = [...steps];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setSteps(next.map((s, i) => ({ ...s, order: i + 1 }))); setSelected(index + delta);
  }
  async function confirm(complete: boolean) {
    if (!record || busy || disabled || voiceActive || staleReason) return;
    setBusy(true); onSubmitting?.(true);
    try {
      let confirmedRevision: number | undefined;
      if (record.observation.source.kind === 'whiteboard_region') {
        if (!beforeConfirm) throw new Error('请先连接白板保存接口，再确认这一步。');
        confirmedRevision = await beforeConfirm();
        const stale = staleBoardReason(record.observation, confirmedRevision);
        if (stale) throw new Error(stale);
      }
      const result = await api<Turn>(`/api/lessons/${lesson.id}/observations/${record.observation.id}/confirm`, {
        method: 'POST', body: JSON.stringify({ image_sha256: record.observation.source.sha256, steps: steps.map(s => ({ ...s, expressions: verifiedExpressions.has(s.id) ? s.expressions : [] })), resolutions, step_complete: complete, board_revision: confirmedRevision }),
      });
      onResult(result);
      setRecord({ ...record, status: 'confirmed', reviewed: result.observation });
      setStatus(result.teaching_error ? `核对已保存。教师回复失败：${result.teaching_error}` : '核对已保存并交给教学模块；未更新掌握程度。');
    } catch (e) { setStatus((e as Error).message); onError((e as Error).message); }
    finally { setBusy(false); onSubmitting?.(false); }
  }
  async function discard() {
    if (!record || busy) return;
    setBusy(true);
    try {
      onResult(await api<Turn>(`/api/lessons/${lesson.id}/observations/${record.observation.id}/discard`, { method: 'POST' }));
      setRecord({ ...record, status: 'discarded' }); setStatus('已保留原稿并暂不采用；课堂可以继续。');
    } catch (e) { setStatus((e as Error).message); onError((e as Error).message); }
    finally { setBusy(false); }
  }
  const staleReason = record?.status === 'pending' ? record.stale_reason || staleBoardReason(record.observation, boardRevision) || (record.observation.source.kind === 'whiteboard_region' && !beforeConfirm ? '白板保存接口尚未连接。' : null) : null;
  const editable = record?.status === 'pending' && lesson.pending_observation_id === record.observation.id && !staleReason;
  const unresolved = record?.observation.ambiguities.some(a => !resolutions[a.id]?.trim());
  const displayedImage = image?.image || record?.image;
  return <div className="observation-entry">
    <button onClick={() => setOpen(true)}>区域识别与核对{lesson.pending_observation_id ? ' · 待确认' : ''}</button>
    {open && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="observation-title" className="dialog observation-dialog" onKeyDown={e => {
        if (e.key === 'Escape' && !busy) setOpen(false);
        if (e.key === 'Tab') {
          const focusable = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')).filter(el => el.getClientRects().length);
          const first = focusable[0], last = focusable.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="dialog-title"><h2 id="observation-title">解题区域 · 原图核对</h2><button autoFocus disabled={busy} onClick={() => setOpen(false)}>关闭核对</button></div>
      <div className="dialog-body">
        <p>看看老师有没有读对，有误的地方直接修改。</p>
        {voiceActive && <p role="note">语音课堂中可以查看和修改草稿。请结束语音后再提交核对，避免老师同时生成两份回复。</p>}
        {staleReason && <p role="alert">{staleReason}</p>}
        {!live && <p role="note">演示模式不运行手写识别。可查看测试图片；连接自己的视觉模型后才能识别。</p>}
        <details><summary>其他图片与测试</summary><p>区域图片保存在本机，并发送给你选择的视觉服务。</p><div className="observation-inputs">
          <label>上传已选区域（PNG）<input type="file" accept="image/png" disabled={busy || disabled} onChange={async e => {
            const file = e.target.files?.[0]; if (!file) return;
            try { setImage({ image: await readPng(file), source: { kind: 'upload', label: file.name.slice(0, 200) } }); setRecord(null); setStatus('图片尚未识别。'); }
            catch (error) { setStatus((error as Error).message); onError((error as Error).message); }
            e.target.value = '';
          }} /></label>
          <label>固定测试图片<select value={fixture} disabled={busy} onChange={e => setFixture(e.target.value)}>
            <option value="fraction">分数</option><option value="exponent">指数</option><option value="negative">负号</option><option value="parentheses">括号与多行</option><option value="mixed">中英混写</option><option value="correction">涂改</option>
          </select></label><button disabled={busy || disabled} onClick={() => void loadFixture()}>载入测试图片</button>
          <button disabled={!image || busy || disabled || !live || voiceActive} onClick={() => void recognize()}>{busy ? '处理中…' : '识别此区域'}</button>
        </div></details>
        <p role="status">{status}</p>
        {displayedImage && <div className="observation-comparison">
          <div><div className="observation-image">
            {/* Exact stored PNG; SVG viewBox keeps overlays aligned when resized. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={displayedImage} alt="选中的解题区域原图" />
            {record && <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="步骤定位（模型估计）">
              {steps.map((s, i) => <rect key={s.id} x={s.region.x} y={s.region.y} width={s.region.width} height={s.region.height}
                className={i === selected ? 'selected' : ''} onClick={() => setSelected(i)} />)}
              {record.observation.ambiguities.map(a => <rect key={`ambiguity-${a.id}`} {...a.region} className="ambiguity" onClick={() => setSelected(Math.max(0, steps.findIndex(s => s.id === a.step_id)))}><title>{a.reason}</title></rect>)}
            </svg>}
          </div>{record && <details><summary>图片来源与模型</summary><p className="field-help">来源：{record.observation.source.label || record.observation.source.kind} · {record.observation.source.width} × {record.observation.source.height}<br/>模型：{record.observation.provenance.model}<br/>图片指纹：{record.observation.source.sha256.slice(0, 16)}…<br/>区域框为模型估计，尚未校准；不提供识别准确率百分比。</p><p>页：{record.observation.source.page_id || "上传图片"} · 版本：{record.observation.source.revision ?? "无"}<br/>元素：{record.observation.source.element_ids?.join(", ") || "无"}</p></details>}</div>
          {record && <div className="observation-steps">
            {record.observation.notes && <details><summary>识别备注</summary><p>{record.observation.notes}</p></details>}
            {!steps.length && <p>没有可读步骤。可以补录步骤，或重新选区。</p>}
            {steps.map((step, index) => <fieldset key={step.id} className={index === selected ? 'selected' : ''} onFocus={() => setSelected(index)} disabled={!editable || busy || disabled}>
              <legend>步骤 {index + 1}{step.mark === 'crossed_out' ? '（已涂掉）' : step.mark === 'unclear' ? '（笔迹待确认）' : ''}</legend>
              <label>步骤内容<textarea value={step.text} maxLength={1000} onChange={e => change(index, { text: e.target.value, expressions: [] })}/></label>
              {step.mark === 'unclear' && <div><button onClick={() => change(index, { mark: 'active' })}>保留这一步</button> <button onClick={() => change(index, { mark: 'crossed_out' })}>这一步已涂掉</button></div>}
              <details><summary>修改公式、涂改或顺序</summary><label>数学表达式（LaTeX，每行一项）<textarea value={step.expressions.join('\n')} onChange={e => { change(index, { expressions: e.target.value.split('\n').filter(Boolean) }); setVerifiedExpressions(current => new Set(current).add(step.id)); }}/></label>
              <label><input type="checkbox" checked={verifiedExpressions.has(step.id)} onChange={e => setVerifiedExpressions(current => { const next = new Set(current); if (e.target.checked) next.add(step.id); else next.delete(step.id); return next; })}/>这些公式也已核对（否则只采用上面的步骤内容）</label>
              <label>笔迹状态<select value={step.mark} onChange={e => change(index, { mark: e.target.value as ObservedStep['mark'] })}><option value="active">保留</option><option value="crossed_out">已涂掉，不交给老师作为有效步骤</option><option value="unclear">仍不确定</option></select></label>
              <details><summary>修正定位（相对图片 0–1）</summary><div className="observation-coordinates">{(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{key}<input type="number" min={0} max={1} step={0.01} value={step.region[key]} onChange={e => change(index, { region: { ...step.region, [key]: Number(e.target.value) } })}/></label>)}</div></details>
              <button disabled={index === 0} onClick={() => move(index, -1)}>上移</button> <button disabled={index === steps.length - 1} onClick={() => move(index, 1)}>下移</button> <button onClick={() => setSteps(steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, order: i + 1 })))}>删除误识别行</button></details>
            </fieldset>)}
            {editable && <button disabled={busy || disabled || steps.length >= 40} onClick={() => setSteps([...steps, { id: `manual_${Date.now()}`, order: steps.length + 1, text: '', expressions: [], region: { x: 0, y: 0, width: 1, height: 1 }, mark: 'active' }])}>补录遗漏步骤</button>}
            {record.observation.ambiguities.map(a => <div className="observation-ambiguity" key={a.id}>
              <p>这里需要看看：{a.reason}</p><p>可能是：{a.alternatives.join(' / ') || '无法辨认'}</p>
              <button disabled={!editable || busy || disabled} onClick={() => setResolutions({ ...resolutions, [a.id]: `已对照原图核对步骤 ${a.step_id}` })}>{resolutions[a.id] ? '已核对' : '这里已读对或已改好'}</button>
              <details><summary>补充说明</summary><input aria-label={`歧义 ${a.id} 的确认`} disabled={!editable || busy || disabled} value={resolutions[a.id] || ''} maxLength={500} onChange={e => setResolutions({ ...resolutions, [a.id]: e.target.value })}/></details>
            </div>)}
          </div>}
        </div>}
      </div>
      <div className="dialog-footer observation-footer">
        {record?.status === 'pending' && <button disabled={busy} onClick={() => void discard()}>暂不采用</button>}
        {editable && <>
          <details><summary>仅保存核对</summary><button disabled={busy || disabled || voiceActive || unresolved || !steps.some(s => s.mark === 'active') || steps.some(s => !s.text.trim() || s.mark === 'unclear')} onClick={() => void confirm(false)}>保存，不请老师回应</button></details>
          <button disabled={busy || disabled || voiceActive || unresolved || !steps.some(s => s.mark === 'active') || steps.some(s => !s.text.trim() || s.mark === 'unclear')} onClick={() => void confirm(true)}>确认这一步，请老师看看</button>
        </>}
        {record?.status === 'discarded' && <span>已暂不采用。原图与识别原稿仍可导出。</span>}
        {record?.status === 'confirmed' && <span>已确认；识别原稿和修改记录均已保存。</span>}
      </div>
    </section></div>}
  </div>;
}
