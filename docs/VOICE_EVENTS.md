# 语音与课堂前端的事件接口

2026-10-31。此前 `useVoice` 只返回界面状态与操作方法，`VoiceClient` 只有构造时的内部回调；其他课堂组件无法安全订阅暂停、取消和播放回执。现在二者均提供 `subscribe(listener): () => void`，返回取消订阅函数。原调用方式兼容，不需要修改课堂壳才能使用现有语音。

定义：`frontend/lib/voice-events.ts`。生产入口：`frontend/lib/use-voice.ts` 和 `frontend/lib/voice-client.ts`。本次没有修改 page.tsx、globals.css 或 Whiteboard.tsx，没有接线或宣称已实现语音与板书同步。

## 事件契约

所有事件含 `lesson_id`、每次 VoiceClient 独立生成的 `session_id`、会话内递增 `sequence`、浏览器 `performance.now()` 的 `at_ms`。没有供应商 Key、票据、PCM、原始转写或教师正文。对象只读并冻结；事件通知是有序同步通知，不回放历史。

| type | 额外字段 | 语义与建议处理 |
|---|---|---|
| `state_changed` | `state`, `turn_id: string \| null` | `connecting/listening/thinking/speaking/paused/off`，仅状态变化通知。沿用现有 UI 状态，不据此决定删除或恢复板书队列。`listening` 不替代 `voice.muted`；`speaking` 不表示已测得扬声器声学起点。 |
| `turn_started` | `turn_id` | 旧轮已失效，新回复轮次开始。新动作队列应绑定该 ID。 |
| `candidate_paused` | `turn_id: string \| null`, `utterance_id` | 本地 VAD 确认语音起始，老师已经调用静音/暂停；事件发生在网络 `begin` 发送前。只暂停匹配轮次的未执行动作，保留恢复可能。null 表示没有旧回复。 |
| `resumed` | `turn_id`, `utterance_id: string \| null`, `reason: recognition/manual` | 当前轮次实际从暂停恢复；空转写/短应答或手动恢复。相同恢复的服务端回声不重复通知。只恢复同一会话、同一轮次的队列。 |
| `interruption_confirmed` | `turn_id: string \| null`, `utterance_id` | ASR 后将发言判定为实质问题，旧回复即将取消。**不代表数学歧义已被用户确认**；可能随后等待转写确认。 |
| `turn_cancelled` | `turn_id`, `reason` | 轮次已在本地失效、旧音频已清理。丢弃该轮未执行动作。原因：`interruption/typed_input/manual_stop/server/replacement/session_end`。同一取消的迟到服务器确认不重复通知。 |
| `playback_receipt` | `turn_id`, `segment_id`, `status: completed/interrupted`, `elapsed_ms`, `alignment` | 来自实际播放器回执；排队、收到文本或 TTS 数据不会生成 completed。`alignment` 固定为 `approximate_segment_boundary`，不是逐字对齐，也不是学生掌握证据。 |
| `session_ended` | 无 | 当前语音会话结束；已执行本地关闭与资源清理流程。取消/清理该 session 遗留的动作；可继续文字课堂。随后有 `off` 状态事件。 |

暂停时的 interrupted 回执可能先于 `candidate_paused`。确认打断先于该轮 `turn_cancelled`；两者之间可能出现状态通知。结束时先发送当前轮的回执/取消，再 session_ended/off。消费者按事件类型处理，不依赖相邻数组位置。

## 课堂壳接线方式（主协调后续实现）

```tsx
const voice = useVoice(lesson, available, receive, showError);
const subscribeVoice = voice.subscribe; // hook 生命周期内稳定，包括关闭后重新开始语音
useEffect(() => subscribeVoice(event => {
  if (event.lesson_id !== lesson?.id) return;
  // 动作所属身份使用 (event.session_id, event.turn_id)，不要只依赖 turn_id 或 UI state。
  // candidate_paused -> pause matching pending actions
  // resumed -> resume matching paused actions
  // turn_cancelled / session_ended -> discard matching pending actions
  // playback_receipt -> update delivery only, never mastery
}), [subscribeVoice, lesson?.id]);
```

直接使用客户端时，在 `await client.start()` 前调用 `client.subscribe(...)`，以接收初始事件。客户端关闭后自动移除自己的订阅；hook 的订阅可跨同一 hook 的语音重启，在 effect 清理时取消。hook 只转发其当前 client 的事件，结束事件发送后才移除当前引用，避免丢掉最终回执和取消通知。重复 close 返回相同清理 Promise。

监听器需短小、只执行本地队列操作。同步异常和异步 rejection 被隔离，不影响音频、发送及其他订阅者；异步监听器自身的完成顺序不受事件接口保证。不要在同步回调里调用语音控制造成重入；需要这样做时另外排入任务。事件不提供历史重放，初始展示继续读取 hook 的 `state/muted`。

服务端轮次/发言校验继续保留。客户端在提交文字修正时立即使旧发言 ID 失效；已取消轮次、旧发言的迟到文本/音频/识别结果不会通知订阅者或取消新回答。

## 验证范围

新增客户端测试使用模拟媒体、模拟云端事件，覆盖本地暂停先于网络、短应答恢复、确认/取消去重、迟到结果隔离、完成回执时机、重复关闭、监听器异常/退订和文字修正使旧识别失效。原浏览器与完整链路仿真继续运行。未新增真实供应商、真人麦克风、扬声器回声或声学延迟验证声明；现有仿真记录的边界仍有效。

本分支验证（2026-10-31）：前端 14 项单测通过（新增 5 项事件用例），类型检查通过；后端 43 项和 Ruff 通过；原浏览器 4 项、完整链路语音仿真 15 项、桌面设置/权限 8 项通过。`DESKTOP_BUILD=1 npm run build` 静态生产构建通过。桌面壳未修改，本事件分支未重新打包应用；主协调合并后统一进行桌面接线验证。历史仿真截图与报告不因本轮重复运行而覆盖。
