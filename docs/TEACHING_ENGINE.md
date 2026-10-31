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

`decision.board_actions` 是本轮新增的提案；`lesson.board_actions` 是有界状态账本（最多 20 条）。目前只提案题目，不实现自动写板书的执行器。

```json
{
  "action_id": "server-generated-id",
  "kind": "write_math",
  "text": "求 y=(2x+3)^3 的导数。",
  "exercise_key": "0:GUIDED_PRACTICE",
  "status": "proposed"
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

## 视觉观察契约

```python
service.receive_teaching_events(db, lesson, [{
    "event_id": "vision-observation-1",
    "kind": "vision_observation",
    "exercise_key": "0:GUIDED_PRACTICE",
    "visible_text": "du/dx = 2?",
    "confidence": 0.4,
    "step_complete": True
}])
# 需要教师回应时，适配器再单独触发：
await service.turn(db, lesson, teacher, gateway, event="board")
```

观察必须绑定当前题；错题目键或暂停期间的观察不接收。视觉适配器还需校验当前白板快照版本，不能将旧快照结果用于新笔迹。新契约不是手写识别实现，也不会让 demo 模式获得视觉能力。

步骤未完成时等待；已明确提交但低置信度时直接要求确认，不额外调用语言模型；高置信度时提出检查问题，仍不评分。学生需要键入表达式确认。原 `/observe` 路径继续兼容，模型与图像处理实现未修改。

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

本分支验证结果（2026-10-31）：后端 64 项通过、Ruff 通过；前端类型检查通过、9 项单测通过；4 项浏览器集成通过。没有修改前端界面，因此未额外执行生产构建。测试产生的通用课堂截图和语音仿真产物未纳入本分支提交。
