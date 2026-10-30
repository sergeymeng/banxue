'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { VoiceSettings as Value } from '@/lib/desktop';

type Catalog = { presets: Record<string, Partial<Value>>; price_date: string };
export default function VoiceSettings({ value, onChange }: { value: Value; onChange: (v: Value) => void }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState('');
  useEffect(() => { api<Catalog>('/api/voice/config').then(setCatalog).catch(() => setError('推荐配置暂时无法读取')); }, []);
  const change = (key: keyof Value, v: string | number | boolean | null) => onChange({ ...value, [key]: v });
  return <div className="settings-section"><h3>语音课堂</h3>
    <label className="field">语音服务<select value={value.enabled ? 'qwen' : 'off'} onChange={e => change('enabled', e.target.value === 'qwen')}><option value="off">未启用</option><option value="qwen">千问云端（推荐）</option></select></label>
    {value.enabled && <>
      <label className="field">部署地域<select value={value.region} onChange={e => change('region', e.target.value)}><option value="beijing">中国 · 北京</option><option value="singapore">新加坡</option></select></label>
      <button type="button" disabled={!catalog} onClick={() => onChange({ ...value, ...catalog?.presets[value.region], cny_to_gbp: .12 })}>应用此地域推荐模型和单价</button>
      {error && <p role="alert">{error}</p>}
      <label className="field">千问 API Key<input type="password" autoComplete="off" value={value.api_key || ''} placeholder={value.has_key ? '已保存；留空保留' : '本地域 Key，用于对话、识别和合成'} onChange={e => change('api_key', e.target.value)}/></label>
      {value.has_key && <label className="checkbox-row"><input type="checkbox" checked={value.api_key === null} onChange={e => change('api_key', e.target.checked ? null : '')}/>删除语音密钥</label>}
      <p className="field-help">开启课堂后，语音和相关课堂内容将发送到所选地域的千问服务。默认不保存原始录音。</p>
      <details className="advanced"><summary>语音高级设置</summary>
        {(['llm_model', 'asr_model', 'tts_model', 'voice', 'workspace'] as const).map(key => <label className="field" key={key}>{{ llm_model: '对话模型', asr_model: 'ASR 模型（3.0 streaming 协议）', tts_model: 'TTS 模型（3 flash realtime 协议）', voice: '声音', workspace: '业务空间 ID（可选，推荐专属域名）' }[key]}<input value={value[key]} onChange={e => change(key, e.target.value)}/></label>)}
        {(['input_cny', 'output_cny', 'asr_cny_second', 'tts_cny_10k', 'cny_to_gbp'] as const).map(key => <label className="field" key={key}>{{ input_cny: '对话输入 ¥ / 百万 Token', output_cny: '对话输出 ¥ / 百万 Token', asr_cny_second: '识别 ¥ / 秒', tts_cny_10k: '合成 ¥ / 万字符', cny_to_gbp: '预算换算 £ / ¥' }[key]}<input type="number" min="0" step="any" value={value[key] ?? ''} onChange={e => change(key, e.target.value === '' ? null : Number(e.target.value))}/></label>)}
        <p className="field-help">原币价格核对于 {catalog?.price_date || '2026-10-30'}，不计免费额度。预设换算 0.12 是可修改的预算系数，并非实时汇率。更改模型或地域后请应用预设或核对单价。</p>
      </details>
    </>}
  </div>;
}
