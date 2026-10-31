'use client';
import { useEffect, useState } from 'react';
import { api, type Material } from '@/lib/api';

/** Read on explicit request using the existing local export endpoint.
 * A dedicated document-file endpoint can replace this without changing the reader UI. */
export default function MaterialReader({ teacherId, material, close }: { teacherId: string; material: Material; close: () => void }) {
  const [url, setUrl] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let active = true, objectUrl = '';
    const abort = new AbortController();
    api<{ documents: { id: string; pdf_base64: string }[] }>(`/api/teachers/${teacherId}/export`, { signal: abort.signal }).then(data => {
      if (!active) return;
      const document = data.documents.find(d => d.id === material.id);
      if (!document) throw new Error('没有找到这份教材，请刷新教材列表。');
      const bytes = Uint8Array.from(atob(document.pdf_base64), c => c.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); setUrl(objectUrl);
    }).catch(e => { if (active) setError((e as Error).message); });
    return () => { active = false; abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [teacherId, material.id]);
  return <div className="material-reader">
    <div className="reader-heading"><button onClick={close}>返回教材列表</button><strong>{material.name}</strong>{url && <a href={url} download={material.name}>下载 PDF</a>}</div>
    {error ? <p role="alert">{error}</p> : !url ? <p>正在读取本机教材…</p> : <iframe title={`教材预览：${material.name}`} src={url} />}
    <p className="reader-note">当前课堂和白板保持打开。浏览器不支持内嵌 PDF 时，可下载查看。</p>
  </div>;
}
