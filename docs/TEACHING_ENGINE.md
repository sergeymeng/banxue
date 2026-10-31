# 教学过程与模块契约

本分支只实现教学策略、题内进度、上下文和语言表达。现有 A-level 求导题库不扩充为完整考纲。语音适配器、白板渲染器与视觉模型实现保持原样。

## 一道题如何进行

八个课堂状态保持兼容。在诊断、引导练习、独立练习内部，`exercise_flow` 保存题目键、步骤位置、提示级别与是否已经进入分步引导。

- 链式法则：内层导数 → 外层导数（用 x 表示）→ 合并为完整导数。
- 乘积法则题：允许先展开，再逐项求导；不要求唯一解法。
- 幂函数题：逐项检查，再合并，处理常数项。

学生可直接提交完整正确答案。`du/dx`、`dy/du` 不会被当成 `dy/dx` 的正确答案；未覆盖的符号表达先确认。分步校验只使用人工审阅的表达式与现有多项式等价检查器，语言模型不能创建判分规则。

例：引导题 `y=(2x+3)^3`。

| 输入/事件 | 教学处理 |
| --- | --- |
| 进入练习 | 提出原题，询问 `u=2x+3` 的导数，然后等待 |
| “不会” | 提示当前一步，不记为错误答案 |
| 再要提示 / “重讲” | 解释当前局部步骤，不倾倒整题答案 |
| `du/dx=3` | 记录带证据 ID 的步骤检查，针对系数和常数项反馈 |
| `du/dx=2` | 确认这一表达式成立，询问外层导数 |
| “为什么乘内层导数？” | 先回应追问，保留步骤位置 |
| “你说错了” | 询问具体句子或符号；下一次澄清不作为答题评分 |
| “回到原题” | 返回原位置，不给独立题未经记录的提示 |
| 最终导数正确 | 安排现有题库的独立迁移题 |
| “换题” | 切换到下一知识点的引导题，不把跳过计为错误 |
| “结束”再开始下一节 | 恢复未完成的题、步骤、提示状态和白板快照 |

空消息与等待答题时的 `auto` 不产生额外讲解。语音课堂的 `auto` 不推进；学生明确说“继续”可推进计划/讲解状态。暂停后先恢复，再明确继续。正常完成独立练习后进入回顾；追问优先于结束回顾。

## 策略、语言与证据

`TeachingPolicy` 产生动作、原因、受限表达要求和状态变化；`teaching_steps.py` 提供确定性的答题解释；`context.py` 约束真实模型的表达；`teaching_language.py` 仅在离线演示中表达决定，不修改状态或判断掌握。

模型通常每轮一到三句、只问一个具体问题，结合学生最近输入，不重复泛泛鼓励。离线演示只回答少量内置求导追问，对范围外问题明确说明限制。真实模型是否能持续遵守表达要求仍需真实课堂评估。

`step_assessment` 记录局部步骤，不累加知识掌握统计。最终表达式产生 `assessment`，知识记录、诊断结果和 `last_check` 均可追溯到数据库 Event ID，并明确表达不确定性。等价性检查的 `confidence=1` 只指确定性多项式比较，不是理解或长期掌握概率。曾用提示的正确答案保留 `assisted=true`，较早安排复习。

识别结果、播放完成、板书执行、学生说“不会”均不产生能力成绩。模型调用失败时，新的教学进度和证据不提交。

## 语音输入契约（使用现有入口）

现有语音模块继续调用：

```python
await service.turn(db, lesson, teacher, gateway, text, event,
    voice_context={
        "input_source": "voice",  # typed 才允许确定性答题评分
        "heard_completed": [{
            "turn_id": "reply-1", "segment_id": "s1",
            "status": "completed", "text": "令 u 等于 2x 加 3。"
        }],
        "interrupted_at": {
            "turn_id": "reply-1", "segment_id": "s2",
            "status": "interrupted", "elapsed_ms": 130,
            "text": "这个句段只播放了一部分。",
            "alignment": "approximate_segment_boundary"
        }
    })
```

接收端把完整播放的句段与未完整播放的句段分开，在有限上下文中先保留回执，再放摘要。没有逐字对齐时，不把整个中断句段算作听过，也不从毫秒位置猜测听到了哪个词。历史中 `delivery=voice_generated_not_confirmed` 的消息标为“仅生成”。回执是客户端报告的播放事实，不是听觉、注意或理解的证明。

本分支不改变 WebSocket、ASR、TTS、播放器或计费逻辑。语音适配器继续负责身份、句段 ID、过期结果过滤及实际播放；本分支消费经过适配器验证的回执。口头数学表达需确认，最终通过学生键入的表达式进入确定性评分。

## 白板输出与执行回执

`decision.board_actions` 是本轮新增的提案；`lesson.board_actions` 是有界状态账本（最多 20 条）。提案覆盖题目、当前步骤提示和已验证步骤；不实现自动写板书的执行器。`purpose` 为 `question | step_prompt | verified_step`，后者必须引用 `evidence_ids`。

```json
{
  "action_id": "server-generated-id",
  "kind": "write_math",
  "text": "求 y=(2x+3)^3 的导数。",
  "exercise_key": "0:GUIDED_PRACTICE",
  "status": "proposed",
  "purpose": "question",
  "step_index": 0,
  "evidence_ids": []
}
```

白板适配器消费提案后，通过教学侧函数回报结果：

```python
service.receive_teaching_events(db, lesson, [{
    "event_id": "board-receipt-1",
    "kind": "board_receipt",
    "action_id": "server-generated-id",
    "status": "executed"  # 或 failed / cancelled
}])
```

这不是新增的 HTTP 或 WebSocket 路由。适配器接线时应在现有课堂串行锁下，重新读取当前 lesson，再调用这个边界函数。它只保存回执，不调用模型、不推进课堂、不写成绩。调用方负责课堂身份校验、执行动作、停止/取消队列以及当前白板版本校验。

重复 event ID 幂等；未知 action ID、已经结束的动作和取消之后的迟到回执不改变状态。暂停、结束、插话/追问及换题会取消相应未执行提案。执行器必须检查最新状态，再执行队列中的提案。只有 `executed` 可进入“已展示”上下文，`proposed`、`failed`、`cancelled` 均不能。

## 视觉观察契约：先核对，再讨论

新观察必须由学生在手写模块中核对。教学模块不依据模型自报 confidence 授权，旧数据包含 confidence 也不能绕过确认，低 confidence 的旧数据没有获得更宽松的通道。未确认转录不进入任何语言生成上下文。baseline 同样遵守这条边界。

跨模块使用以下**服务器可信适配边界**，不能将视觉模型返回的 JSON 原样作为 `observation` 接收：

```python
service.receive_teaching_events(db, lesson, [{
    "event_id": "review-delivery-1",
    "kind": "vision_observation",
    "exercise_key": "0:GUIDED_PRACTICE",
    "observation": {
        "id": "persisted-observation-id",
        "confirmation_event_id": "persisted-student-review-event-id",
        "exercise_key": "0:GUIDED_PRACTICE",
        "confirmed": True,
        "step_complete": True,  # 学生明确提交，而非模型输出或停笔
        "source": {"kind": "whiteboard_region", "sha256": "image-hash",
                   "snapshot_id": "revision-7", "page_id": "page-1"},
        "image_sha256": "image-hash",
        "steps": [{"id": "step-1", "text": "du/dx=2", "mark": "active"}],
        "uncertainty": "student_reviewed_transcription; mathematical_correctness_unassessed"
    }
}])
await service.turn(db, lesson, teacher, gateway, event="board")
```

接收端重新从 active 步骤构造 `visible_text`，不相信客户端/模型预拼的文本；crossed_out 内容不会进入教学提示，尚有 unclear 时拒绝确认交接。确认不自动调用多项式判分，不写 Knowledge，不产出“已验证步骤”板书；即使确认的是错误数学，也只提检查问题。评分仍通过独立的学生表达式提交路径完成。

`bind_handwriting_observation` 兼容手写分支当前的紧凑交接字段：通过 observation ID 和 confirmation Event ID 读取数据库，核对课堂归属、原观察类型/状态、当前题目/阶段、图片哈希和 student_review 来源，再从持久化 reviewed 记录补齐 source 和 exercise_key。缺少记录时不猜来源、不回退到 confidence。这个适配只依赖已有 Event 表，不导入或复制手写模块。

未核对、缺少来源、旧题目或已被更新观察替代的内容不会进入模型上下文。存在 `pending_observation_id` 时自动推进停止；新待核对观察不能被旧确认回执清除。新事件批次的 schema 与语义检查一起原子应用。

这里没有新增路由或前端确认界面；由集成分支保留手写分支的 observe/confirm/discard 路径，且负责会话身份、不可变白板版本与学生确认入口的校验。教学侧旧 `/observe` 在本分支仍能返回确认提示，但高 confidence 不再额外触发语言模型。

## 逐步板书与取消交接

教师决定之后、最终表达式检查证据写入之前，不向执行器公布板书提案。服务完成本轮后生成提案：

- 进入引导题：题目与一个步骤问题。
- 提示/重讲：只写当前提示；重讲可写当前局部解释，辅助标记保留。
- 步骤验证通过：从人工审阅题库取对应表达式，写入 `verified_step`，携带刚产生的 Event ID，再提出下一步问题。不会复用学生输入来生成可执行代码或任意标记。
- 进入独立题：只写题目。恢复和返回原题不会提前写答案；学生主动求助后才允许写当前提示。

提案文本为白板 v1 接受的纯 Unicode，最多 400 字符，不是 LaTeX、HTML 或 SVG。教学层不分配几何位置；集成层将 `action_id` 映射为白板 v1 action `id`，为 element 分配稳定唯一 ID、author=teacher 及布局，组成 `controller.enqueue({version:1,id,lessonId,actions})`。不要把模型回复直接拼成白板动作。

每轮返回 `decision.board_cancellations: string[]`。暂停、结束、追问/纠正或换题取消旧的未执行提案；新步骤问题取代旧的未执行步骤问题。集成层必须先处理取消，再发送本轮新增动作。白板 v1 的 `cancel()` 取消所有 pending；若它连带取消仍有效的提案，必须把这些实际取消状态回报教学账本，不能复用旧 action ID 来重放。需要重新展示时由新的教学回合产生新 ID。不要因新提案而自动 resume 被暂停的执行器。

执行器回报 `executed / failed / cancelled`；白板 v1 的 `pending` 对应教学侧 `proposed`，不是执行回执。`executedRevision` 可映射为回执的 `executed_revision`。重复、未知、旧题目、已取消和暂停后的迟到回执忽略。已执行回执是历史事实：undo 不使它回到 proposed，也不证明目前仍可见；实际可见内容以当前白板快照为准，更不证明语音已播放或学生已掌握。

## 验证与边界

使用合成学生输入和测试事件独立验证本分支，不需要 provider key。新增教学回归覆盖三类题九组步骤、分级提示、局部重讲、追问/纠正、停止与续课、证据来源、未播放内容、重复/过期板书回执、低置信度和迟到视觉事件、上下文预算以及独立题恢复时不泄漏提示。

运行：

```bash
cd backend
uv run pytest -q
uv run ruff check app tests
cd ../frontend
npm run typecheck
npm test
npm run test:e2e
```

浏览器回归使用 `data/e2e`、3100/8100 端口和单个 backend worker。测试通过不代表真实 LLM、ASR、TTS 或手写识别已验证。白板提案还需由白板分支接入执行器，本分支不会把提案当作已写出。

第一轮验证结果（2026-10-31）：后端 64 项通过、Ruff 通过；前端类型检查通过、9 项单测通过；4 项浏览器集成通过。没有修改前端界面，因此未额外执行生产构建。测试产生的通用课堂截图和语音仿真产物未纳入本分支提交。

第二轮沿用 Qwen 云端作为首阶段默认表达方案，由使用者配置自己的 Key。教学策略、确认契约和板书提案没有供应商依赖，仍通过既有 complete/gateway 接口替换表达适配器；本轮未修改模型设置或供应商底层。

第二轮验证结果（2026-10-31）：后端 80 项通过，Ruff 通过；前端类型检查及 9 项单测通过；原有 4 项浏览器集成通过，临时副本仅替换端口为 3203/8203、数据目录为 `data/e2e/teaching-engine`，避免干扰并行分支。临时配置和测试副本已删除，无前端源码改动。真实 Qwen/视觉与白板执行接线不由这些模拟测试证明。
