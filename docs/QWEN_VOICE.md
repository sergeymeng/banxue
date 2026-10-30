# 千问云端语音课堂 · 0.3

实现与文档核对日期：2026-10-30。真实千问 ASR/文本/TTS 适配器已经实现；本次没有真实千问 Key，因此真实供应商调用、中文识别质量与真人扬声器插话尚未验证。自动化测试中的供应商响应明确使用 mock。

## 运行与配置

macOS Apple Silicon：打开 `dist/伴学-darwin-arm64/伴学.app`。这是未做 Developer ID 签名、公证的开发评估包。重建命令为 `./scripts/build-desktop.sh`；开发入口为 `./scripts/dev.sh`，后台保持一个 worker。

1. 打开设置 → 语音课堂 → **千问云端（推荐）**。
2. 选择北京或新加坡，点击 **应用此地域推荐模型和单价**。这一步是明确操作，不会覆盖原有文字/视觉模型配置。
3. 输入该地域的百炼 API Key，然后保存并应用。一份 Key 用于本次语音课堂的 ASR、LLM 和 TTS。已保存 Key 不返回界面；留空保留，勾选删除才清除。
4. 高级设置可修改模型、声音、原币单价、预算换算系数和可选业务空间 ID。预设系数 `0.12 GBP/CNY` 是预算假设，不是查询到的实时汇率。更改模型/地域时需核对单价。
5. 进入已有老师的课堂，点击 **开始语音课堂**，允许麦克风。缺 Key、费用配置或不支持的协议模型会明确提示。macOS 拒绝后需在系统设置 → 隐私与安全性 → 麦克风中允许伴学。
6. 说话即可看到识别中和最终文字；老师讲解时可直接插话。可静音、立即停止老师、结束语音、修改转写或继续打字。语音中“继续讲解”显式调用已有课程推进逻辑，未播放内容不会触发自动推进。

“文字与白板连接”沿用原设置，可保持文字演示；语音开启后，语音课堂及其中的文字输入使用真实千问配置并单独计费。结束语音后回到原文字配置。语音中暂缓新视觉请求，已有白板观察和文本仍可进入上下文。

浏览器开发模式在后端 `.env` 中填写 `VOICE_*`，参见 `.env.example`。不要把 Key 放到前端或聊天。开启后音频与相关课堂内容发送到配置的云服务；没有原始录音落盘。转写、课堂消息和播放回执属于课堂记录，遵循已有本地数据导出/删除边界；`RETAIN_TRANSCRIPTS=false` 不保存完整事件转写，仍保留现有有限课堂续课信息。

## 官方协议与预设

以下模型在北京、新加坡都有官方价格条目。Key 必须与地域匹配。公共域名仍有官方接入示例；官方推荐业务空间专属域名，可通过可选 Workspace ID 使用。

| 服务 | 推荐模型 | 协议、端点路径 | 鉴权 | 计费单位 |
|---|---|---|---|---|
| 对话 | `qwen-flash` | HTTPS `/compatible-mode/v1/chat/completions`，SSE，`stream_options.include_usage` | Bearer Key | 输入/输出 Token 分别计费 |
| ASR | `qwen-audio-3.0-asr-flash-streaming` | WSS `/api-ws/v1/inference`，`run-task` → binary PCM → `finish-task` | Bearer Key | 输入音频秒 |
| TTS | `qwen3-tts-flash-realtime`，`Cherry` | WSS `/api-ws/v1/realtime?model=...`，session/text/audio events | Bearer Key | 输入文本字符 |

北京公共域名 `dashscope.aliyuncs.com`；新加坡 `dashscope-intl.aliyuncs.com`。业务空间域名分别为 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` 和 `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`。虽然域名可共享，三种服务的路径、载荷及结束事件不同。

采用 3.0 Streaming ASR 是为了使用其实际支持的 `parameters.vocabulary` 即时热词。每次发言按当前章节传入少量术语，导数和倒数同时保留且权重相同；不启用强制中文语言转换，保留中英混说。3.1 ASR 改为 Token 计费，旧 `qwen3-asr-flash-realtime` 使用另一协议；这些型号不会被本适配器误当作 3.0 秒计费模型。高级模型设置支持同协议、同计费家族的版本，跨家族需实现另一适配器。

| 地域 | 对话输入 CNY/百万 Token | 对话输出 CNY/百万 Token | ASR CNY/秒 | TTS CNY/万字符 |
|---|---:|---:|---:|---:|
| 北京 | 0.15 | 1.5 | 0.00033 | 1 |
| 新加坡（国际） | 0.367 | 2.936 | 0.00066 | 0.954101 |

查询日：2026-10-30。文本价格对应当前小上下文档位：北京不超过 128K 输入、新加坡不超过 256K；本项目默认上下文 4200 Token。免费额度/活动折扣不计入预算。费用统一换算为 GBP 后加入已有请求、课堂、UTC 日预算；费用始终为估算，不冒充账单。供应商 ASR duration、LLM Token usage 和 TTS 原始 usage 分开保存；TTS 字符数本地计数，不能把它标成供应商确认的字符数。

官方依据：

- [模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)
- [Qwen 文本流式输出](https://help.aliyun.com/zh/model-studio/stream)
- [ASR WebSocket 接入](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-websocket-api)
- [ASR 公共域名仍受支持的 SDK 示例](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-harmonyos-sdk)
- [ASR 客户端事件、热词和静音阈值](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events)
- [ASR 服务端事件与 duration](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events)
- [TTS WebSocket 接入](https://help.aliyun.com/en/model-studio/interactive-process-of-qwen-tts-realtime-synthesis)
- [TTS 客户端事件、声音与 PCM 格式](https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-client-events)

## 实现边界

- `voice.py`：ASR、TTS、StreamingLLM、未来 BoardActions 契约和分句/口读/插话规则。
- `qwen_voice.py`：唯一已实现的供应商适配器，协议与地域端点隔离于课堂业务。
- `voice_session.py`：复用 `service.turn`、TeachingPolicy、题目、检索和记忆；每轮 UUID 覆盖文本、句段、音频与回执。
- `voice_cost.py`：ASR 每发言预留最大时长，完成后按供应商时长或本地字节数结算；TTS 按输入字符预留。取消、断线、异常保留不确定预留。无隐式重试。
- 前端 `voice-audio.ts` / `voice-client.ts`：本地声音活动检测、预留缓冲、可暂停音频队列和过期轮次过滤。

默认限制：每发言 60 秒、语音会话 30 分钟、16kHz 单声道 PCM16 输入、24kHz PCM16 输出。每个输入二进制帧最多 16KB、控制消息最多 12KB、ASR 队列最多 256 帧、播放积压最多 90 秒。单实例一个语音课堂。慢连接、设备断开、超时会停止或暂停并给出提示，不后台无限重试。

WebSocket 不依赖 HTTP 中间件：同源 HTTP 先申请 30 秒有效、一次性课堂票据；握手后第一帧提交，校验 Origin、课堂 ID、有效期及单次使用。桌面 HTTP 仍需进程令牌。票据不放 URL，不是供应商 Key。开发版继承已有本机单用户安全边界，不是多用户互联网身份系统。

本地 Silero v5 每帧 32ms，连续 96ms 高语音概率才触发候选；保留最多 480ms 输入预留，1.4 秒低语音概率后结束发言，避免把短思考停顿立刻断句。采集请求 AEC、降噪、自动增益；本地 VAD 不是音量阈值，也不是已验证的回声鉴别器。麦克风采集上下文独立于老师播放上下文；候选出现先通过 gain 静音并 suspend 播放，然后才发送云端消息。

空转写按噪声恢复；完整转写严格匹配“嗯、对、好的、OK、yes”等白名单时恢复原队列。其他转写取消旧轮并答新问题。“负、次方、分母、分子、指数、倒数”等高影响歧义先显示原始转写，要求确认或编辑。原始转写不被术语替换规则重写；语音回答不建立评分证据，明确的键入答案保留原有精确校验。

生成和排队不代表听到。收到播放完成回执才计入已播放句段；打断保存句段 ID 与近似播放毫秒位置，无逐字时间戳。新问题上下文包含当前题/步骤、最近完成句段、打断位置、学生原话及可用白板观察/文本。没有自主教师板书动作队列，本轮只保留契约，不声称已实现音板同步。

## 验证

见 [VOICE_TEST_REPORT.md](VOICE_TEST_REPORT.md)。运行：

```bash
cd backend && uv run pytest -q && uv run ruff check app tests
cd ../frontend && npm run typecheck && npm test && npm run test:e2e
cd ../desktop && npm test && npm run test:smoke && npm run test:voice
```

`test:voice` 在独立临时用户目录中使用假 Key 测试 safeStorage，使用假媒体设备和 mock 云端；不会读取/覆盖用户 Key 或调用付费服务。浏览器测试使用 macOS Tingting 生成的独立合成语音夹具，确认 VAD 检测和本地暂停，不能用于真人准确率或回声能力声明。
