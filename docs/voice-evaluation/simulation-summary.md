# 语音仿真自动报告

运行时间：2026-10-31T00:12:06.812Z。总体结果：passed。

仅模拟云端传输；没有调用真实供应商，没有验证真人麦克风或扬声器回声。

| 场景 | 结果 | 耗时 |
|---|---|---|
| real local WS + Qwen adapters: streamed ASR, text, TTS and playback receipts | passed | 6.5 s |
| three natural interruptions cancel old replies; late audio and text stay silent | passed | 9.6 s |
| provisional pause resumes same reply for 嗯。 transcript | passed | 5.0 s |
| provisional pause resumes same reply for empty/noise transcript | passed | 5.0 s |
| thinking pause stays one utterance; ambiguous math waits for explicit confirmation | passed | 5.4 s |
| fault asr_fail: clear error, uncertain reservation, no retry, subsequent typed recovery | passed | 4.3 s |
| fault asr_disconnect: clear error, uncertain reservation, no retry, subsequent typed recovery | passed | 4.3 s |
| fault llm_disconnect: clear error, uncertain reservation, no retry, subsequent typed recovery | passed | 2.1 s |
| fault llm_timeout: clear error, uncertain reservation, no retry, subsequent typed recovery | passed | 2.0 s |
| fault tts_fail: clear error, uncertain reservation, no retry, subsequent typed recovery | passed | 2.1 s |
| fault tts_disconnect: clear error, uncertain reservation, no retry, subsequent typed recovery | passed | 2.1 s |
| disconnect releases capture, playback, connection and backend tasks | passed | 1.8 s |
| device releases capture, playback, connection and backend tasks | passed | 1.7 s |
| leave releases capture, playback, connection and backend tasks | passed | 1.8 s |
| synthetic keyboard and residual echo: observe VAD, recover possible false pauses without new replies | passed | 8.1 s |

连续插话场景中，合成音频调度 → 本地 suspend 调用：251.7、157.7、161.1 ms。同一浏览器 performance.now 时钟；不是人声起点 → 扬声器实际停声，不据此认定达到 300 ms 目标。

JSON 包含播放调度重叠、保留费用预留和合成噪声引起的暂停次数；详细事件与费用流水保留在 Playwright 的 simulation-trace 附件。
