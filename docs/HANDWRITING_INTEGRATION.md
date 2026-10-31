# 白板／课堂核对接线契约（第二轮）

本轮未修改 `page.tsx`、`Whiteboard.tsx`、全局 CSS 或其他分支。以 `../banxue-teaching-board/docs/WHITEBOARD_CONTRACT.md` 的单页 1600×1200、`BoardExport` v1 为依据。集成协调者负责下列接线。

## 导出、保存、识别

`frontend/lib/handwriting.ts` 提供结构兼容的 `prepareStudentRegion(controller, region?)`。它调用 `exportRegion({author:'student', region})`，随后 `flush()`，再比较导出 revision 与最新 revision；导出过程中有编辑则不提交旧图片。没有 region 时仍是完整学生页，应在 UI 如实命名。

```ts
const input = await prepareStudentRegion(controller, selectedRegion);
const response = await submitRegion(lesson.id, input);
if (response.lesson) receive(response);
```

与主线程捕获的 lessonId/controller 绑定；用户切换课堂后，不得把旧导出结果投递到新课堂。现有 `receive` 的课堂 ID 检查仍需保留。

转换后的 source：

```json
{
  "kind": "whiteboard_region",
  "page_id": "main",
  "snapshot_id": "banxue-board:v1:7",
  "revision": 7,
  "element_ids": ["student-element-1", "student-element-2"],
  "author": "student",
  "region": {"x": 120, "y": 20, "width": 640, "height": 420}
}
```

`BoardExport.elementIds` → `source.element_ids`；revision 原样传递，不使用时间戳生成替代版本。snapshot_id 由 revision 确定。author 必须 student；all/teacher、空 ID、重复 ID、缺 revision 均拒绝。source.region 使用原白板坐标，步骤/歧义的框仍为图片相对 0..1。

后端要求该课堂已保存 `format:'banxue-board',version:1` 的同 revision 快照。所列元素必须恰好等于该区域与学生元素相交的集合；不接受漏掉笔迹或把教师元素标成学生。此处使用与 exporter 相同的轴对齐相交规则。后端不重渲染 PNG，不能把这个绑定称为对像素来源的密码学证明。

## 确认前必须再次 flush

为 `ObservationReview` 提供：

```tsx
<ObservationReview
  lesson={lesson}
  boardRevision={boardRevision} // onBoardEvent(edit) 更新；包括 teacher edit
  beforeConfirm={async () => {
    await controller.flush();
    return controller.getSnapshot().revision;
  }}
  onSubmitting={setReviewSubmitting} // 立即锁定绘制、动作队列、换课、语音与其他生成入口
  voiceActive={voice.active}
  disabled={busy || lesson.paused || lesson.state === 'SESSION_SUMMARY'}
  live={config?.mode === 'live'}
  onResult={receive}
  onError={report}
/>
```

`onSubmitting(true/false)` 在确认请求开始/结束调用，宿主用它暂停板书队列并锁定其他入口。不要在请求结束时擅自恢复原本已暂停的队列。

`beforeConfirm` 必须来自当前课堂的 controller，保存失败必须 reject。本机笔迹版本未知／变化时，组件禁止确认；callback 缺失也不提交白板结果。提交中宿主应暂锁编辑与执行器，或保证每次编辑即时更新 revision 并在提交前完成 flush；不要仅依赖 600ms debounce。主线程若还允许教师动作在此期间执行，可能出现已过时的输出；应在核对期间暂停动作队列。

POST confirm 增加 `board_revision`，须等于原 source.revision 与最新持久化 revision。后端另外比较学生元素摘要，防止内容修改却重用同一 revision。新笔迹、擦除、同版本内容变动、teacher 导致全局 revision 增长均保守地返回 409，要求重新读取。即使变化发生在选区外也会拒绝；这是 v1 的有意保守策略。

观察同时绑定 state、topic_index、current_exercise、exercise_flow.key/step、detour、可选 teaching_revision 及最新 turn Event ID。任何新课堂轮次都会使旧的待确认结果失效，即使状态与题目编号相同；暂停再恢复也需重新读取。这样不依赖题目恰好改变字符串，能防止“换题后又回到原编号”的旧确认。GET detail 返回 `stale_reason`；POST confirm 最终检查仍为权威结果。旧版未带完整绑定的 pending 记录可查看／丢弃，但应重新识别。

确认按键明确表示“确认这一步，请老师看看”，传 `step_complete:true`；折叠项可以只保存（false）。默认确认采用学生看得见的步骤文本；隐藏 LaTeX 只有在手工编辑或勾选已核对后才提交，防止步骤文本已改正而旧公式仍被当成已确认。原模型公式始终保留在原稿中。歧义允许按键确认或补充说明，不强制学生逐项填写解释文字。

识别不会更新掌握程度。教学交接仍为 `turn(event='board')`，confirmed、confirmation_event_id、uncertainty、有效步骤及 source 进入 lesson.observation。教学分支可消费这些来源；不要把确认事件等同于数学正确证据。

## 语音与并发限制

保留服务端 guards：语音会话存在时，新识别返回 skipped，确认返回 409。GET 原图／记录继续可用，组件在 voiceActive 时允许本地阅读与草稿编辑，禁用识别和提交。草稿仅在当前组件内存中，关闭同一弹窗保留，刷新会丢失；语音产生新课堂轮次后旧结果必须重读。

目前不能在语音连接中确认后又额外调用 HTTP 教学生成，也不会自动 TTS 播放 HTTP 回复。协调者若要后续支持，必须选择单一课堂控制通道，在 voice session 队列中接收已确认观察、取消/串行化旧轮次、绑定回复 ID 和播放回执；不能仅删除 `voice_sessions` guard。开始语音／换课堂／发起教学轮次与核对提交应互斥。后端共享锁序列化付费请求，但不能替代前端暂停绘制、刷新快照及语音单通道调度。

## 独立验证

```bash
cd backend
uv run pytest -q
uv run ruff check app tests
cd ../frontend
npm run typecheck
npm test
npm run build
npm run test:e2e -- --config playwright.handwriting.config.ts
```

后一个命令仅跑手写流程浏览器测试，默认端口 3317/8317，数据在 `backend/data/e2e/handwriting`。可通过 HANDWRITING_E2E_UI_PORT / HANDWRITING_E2E_API_PORT 改端口。`reuseExistingServer:false`；占用时失败，不接管或杀死其他服务。
