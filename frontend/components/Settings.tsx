'use client';
import { useEffect, useState } from 'react';
import { Config } from '@/lib/api';
import type { DesktopSettings } from '@/lib/desktop';
import Icon from './Icon';
import VoiceSettings from './VoiceSettings';

export default function Settings({ config, mode, onMode, onClose }: { config: Config | null; mode: string; onMode: (v: 'policy' | 'baseline') => void; onClose: () => void }) {
  const [value, setValue] = useState<DesktopSettings | null>(null);
  const [desktop, setDesktop] = useState(false);
  const [role, setRole] = useState<'fast' | 'reasoning' | 'vision'>('fast');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (window.desktop) { setDesktop(true); window.desktop.getSettings().then(setValue).catch(e => setError(e.message)); } }, []);
  const names = { fast: '日常交流', reasoning: '推理与检查', vision: '白板识别' };
  const current = value?.roles[role];
  function change(key: string, v: string | number | null) { if (value) setValue({ ...value, roles: { ...value.roles, [role]: { ...value.roles[role], [key]: v } } }); }
  async function save() {
    if (!value || !window.desktop) return;
    setSaving(true); setError('');
    try { await window.desktop.saveSettings(value); window.location.reload(); }
    catch (e) { setError((e as Error).message); setSaving(false); }
  }
  return <><div className="dialog-title"><h2>设置</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></div><div className="dialog-body settings-body">
    {error && <div role="alert" className="inline-error">{error}</div>}
    {desktop ? value && <>
      <div className="setting-row"><label htmlFor="model-mode">文字与白板连接</label><select id="model-mode" value={value.mode} onChange={e => setValue({ ...value, mode: e.target.value as 'demo' | 'live' })}><option value="demo">文字演示（语音单独设置）</option><option value="live">使用自己的模型</option></select></div>
      <VoiceSettings value={value.voice} onChange={voice => setValue({ ...value, voice })}/><div className="settings-section"><h3>文字与白板模型</h3><p>三个角色可以使用同一模型，也可以分别配置。</p><div className="segmented">{(Object.keys(names) as (keyof typeof names)[]).map(r => <button key={r} className={r === role ? 'selected' : ''} onClick={() => setRole(r)}>{names[r]}</button>)}</div>
      {current && <div key={role}>
        <label className="field">API 地址<input value={current.base_url} onChange={e => change('base_url', e.target.value)} spellCheck={false}/></label>
        <label className="field">模型名称<input value={current.model} onChange={e => change('model', e.target.value)} spellCheck={false}/></label>
        <label className="field">API Key<input type="password" autoComplete="off" value={current.api_key || ''} placeholder={current.has_key ? '已保存；留空保持不变' : '填入密钥，本地模型可留空'} onChange={e => change('api_key', e.target.value)} /></label>
        {current.has_key && <label className="checkbox-row"><input type="checkbox" checked={current.api_key === null} onChange={e => change('api_key', e.target.checked ? null : '')}/>删除已保存密钥</label>}
        <div className="field-pair">{(['input_gbp', 'output_gbp'] as const).map(key => <label className="field" key={key}>{key === 'input_gbp' ? '输入单价' : '输出单价'}<input type="number" min="0" step="any" value={current[key] ?? ''} placeholder="£ / 百万 Token" onChange={e => change(key, e.target.value === '' ? null : Number(e.target.value))} /></label>)}</div>
      </div>}
      <p className="field-help">单价使用英镑，每百万 Token。密钥使用系统密钥存储加密，仅供本机服务调用。</p></div>
      <div className="settings-section"><h3>费用预算</h3><div className="budget-fields">{(['request', 'session', 'day'] as const).map(key => <label className="field" key={key}>{{ request: '单次请求', session: '每节课', day: '每天（UTC）' }[key]}<div className="currency-input"><span>£</span><input type="number" min="0" step="0.01" value={value.budgets[key]} onChange={e => setValue({ ...value, budgets: { ...value.budgets, [key]: Number(e.target.value) } })}/></div></label>)}</div></div>
      <details className="advanced"><summary>高级设置</summary><label className="field">输出 Token 参数<select value={value.token_field} onChange={e => setValue({ ...value, token_field: e.target.value as DesktopSettings['token_field'] })}><option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens（部分本地模型）</option></select></label></details>
    </> : <div className="browser-settings"><h3>模型配置</h3><p>浏览器开发版从 backend/.env 读取配置。桌面应用中可以直接填写。</p>{config && Object.entries(config.roles).map(([r, v]) => <div className="setting-row" key={r}><span>{names[r as keyof typeof names]}</span><code>{v.model}</code></div>)}</div>}
    <details className="advanced"><summary>研究设置</summary><label className="field">新课堂模式<select value={mode} onChange={e => onMode(e.target.value as 'policy' | 'baseline')}><option value="policy">教学策略</option><option value="baseline">普通 LLM 基线</option></select></label><p className="field-help">重新选择老师后生效；同模型比较需要将交流与推理模型设为相同。</p></details>
    {desktop && <button className="text-button data-folder" onClick={() => void window.desktop?.openDataFolder()}><Icon name="folder"/>打开学习数据文件夹</button>}
    <p className="settings-license">白板使用项目自研 SVG 实现。各依赖保留原许可，详见依赖说明。</p>
  </div><div className="dialog-footer"><button onClick={onClose} disabled={saving}>取消</button>{desktop && <button className="primary" onClick={() => void save()} disabled={saving || !value}>{saving ? '正在应用…' : '保存并应用'}</button>}</div></>;
}
