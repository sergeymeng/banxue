'use client';
import type { useVoice } from '@/lib/use-voice';
const names = { off: '语音未开启', connecting: '正在连接', listening: '正在听', thinking: '正在思考', speaking: '正在讲解', paused: '已暂停' };
export default function VoiceControls({ voice, disabled, canAdvance, edit }: { voice: ReturnType<typeof useVoice>; disabled: boolean; canAdvance: boolean; edit: (text: string) => void }) {
  return <div className="voice-controls">
    <div className="voice-buttons">{voice.active ? <>
      <span role="status">{names[voice.state]}</span>
      <button type="button" aria-pressed={voice.muted} onClick={voice.toggleMute}>{voice.muted ? '取消静音' : '麦克风静音'}</button>
      {canAdvance && <button type="button" onClick={() => voice.send('', 'auto')}>继续讲解</button>}
      <button type="button" onClick={voice.stopTeacher}>立即停止老师</button>
      {voice.state === 'paused' && <button type="button" onClick={voice.resume}>接着讲</button>}
      <button type="button" onClick={() => void voice.stop()}>结束语音</button>
    </> : <button type="button" disabled={disabled} onClick={() => void voice.start()}>开始语音课堂</button>}</div>
    {!voice.active && <p className="field-help">开启后语音和相关课堂内容发送到所选云服务；不保存原始录音。</p>}
    {voice.confirmation && <p className="voice-transcript">{voice.confirmation}<button onClick={voice.confirm}>确认原话并继续</button></p>}
    {voice.transcript && <div className="voice-transcript"><span>{voice.final ? '识别结果' : '识别中'}：{voice.transcript}</span>{voice.final && <button className="text-button" type="button" onClick={() => edit('刚才识别有误，我说的是：' + voice.transcript)}>修改转写</button>}</div>}
    {voice.latency !== undefined && <details className="voice-metric"><summary>插话测量</summary><p>最近 VAD 确认回调 → 本地静音指令：{voice.latency.toFixed(1)} ms。另含约 96 ms 连续语音帧确认；不含设备采集、模型推理与扬声器延迟，不代表开口到停声已达到 300 ms。</p></details>}
  </div>;
}
