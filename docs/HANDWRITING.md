# 区域图片识别与解题观察（阶段一）

**第二轮接线以 [HANDWRITING_INTEGRATION.md](HANDWRITING_INTEGRATION.md) 为准**：补充 revision/element IDs、确认前 flush 与过期校验；[Qwen 显式适配](QWEN_VISION.md)。下文保留第一轮流程背景，旧 source 示例已被第二轮契约取代。

分支 `codex/handwriting`，独立工作区 `../banxue-handwriting`。本阶段实现视觉服务、结构化观察、原图核对与错误记录工具。实际视觉模型能力尚未验证，不能以接口模拟或合成图片测试宣称已可靠识别真实学生手写。

## 数据流与边界

区域 PNG → `VisionService.recognize` → 结构校验 → 保存原图/转录事件 → 学生核对与修改 → 确认事件 → `turn(event="board")`。图中文字只作为不可信数据，转录服务不解题、不推断学生心理、不评分。新识别不进入语言生成上下文；确认后的文本也不提升为 system 指令。

`app/vision.py` 定义服务协议与 schema，默认 `GatewayVisionService` 使用用户填写的 VISION_BASE_URL / VISION_MODEL / VISION_API_KEY / GBP 单价。`create_app(..., vision_service=...)` 可注入其他适配器。替换实现必须复用相同预算记账约束，不能在服务协议外悄悄重试付费请求。mock 仅用于协议测试；演示模式在调用适配器之前拒绝识别。

`VISION_MAX_OUTPUT_TOKENS` 默认 4096，可在后端环境配置；独立于文字默认 700，已用于预算预留。PNG 以 `detail: high` 发送，不在服务端缩小。图片 token allowance、实际输出及费用仍是估计；供应商提供 usage 时保留其来源。兼容服务若不接受图像 detail 或严格 JSON，需要另写适配器；当前没有供应商兼容性实测结论。

## 与白板分支对接

本分支不实现框选、裁剪、旋转或白板坐标变换。白板提供**已经裁剪好的** PNG，且其边缘应与 `source.region` 对应；如果加 padding，region 必须包含 padding。UI 中先以原图预览选区，避免切断分数线、指数与多行上下文。

前端契约位于 `frontend/lib/handwriting.ts`：

```ts
const result = await submitRegion(lesson.id, {
  image: 'data:image/png;base64,...',
  trigger: 'explicit',
  source: {
    kind: 'whiteboard_region',
    page_id: 'page:abc',
    snapshot_id: 'immutable-document-revision',
    region: { x: 120, y: -30, width: 640, height: 420 },
    label: '第 2 题，第 1–3 步'
  }
});
if (result.lesson) onResult(result);
```

`source.region` 使用白板文档坐标，不是屏幕 CSS 像素。`snapshot_id` 必须是对应裁剪图的不可变版本标识，而非每次渲染都变化的 ID。后端验证元数据完整性，不验证它是否确实对应白板快照。上传/测试图片的 kind 分别为 `upload` / `fixture`，不声称具有白板坐标。

观察结果中的所有 `region` 是**相对收到的 PNG**的归一化矩形：`x,y,width,height`，范围 0..1。映射回白板时：`board_x = source.region.x + x * source.region.width`，其余轴同理。只适用于无旋转、轴对齐裁剪；旋转需白板分支扩展契约版本。模型框只是估计，人工可修正。

页面已挂载独立 `ObservationReview`，监听 lesson 的 `latest_observation_id` / `pending_observation_id` 并读取持久化原图。区域 API 返回后更新 lesson 即可触发核对。旧 `/observe` 是相同流程的兼容入口，缺 source 时明确标记 `legacy_page`，绝不推断为选区。`Whiteboard.tsx` 只有一行状态文案修改，移除了置信度百分比；旧白板导出逻辑留待另一分支替换。

## API 与存储

- `POST /api/lessons/{lesson_id}/observations`：`{image, source, trigger}`；成功返回 `{lesson, observation, sources, decision: WAIT}`。新结果 `status=pending`。同一图片、来源与课堂阶段去重，返回现有记录；20 秒冷却，失败也不绕过冷却。
- `GET /api/lessons/{lesson_id}/observations`：课堂观察历史摘要。
- `GET /api/lessons/{lesson_id}/observations/{id}`：原图 data URL、原始 observation、状态、确认内容与 reviewed 结果；必须属于该课堂。
- `POST .../{id}/confirm`：`{image_sha256, steps, resolutions, step_complete}`。`resolutions` 必须逐项覆盖原歧义 ID。步骤 ID 唯一、order 连续、框不越界；至少一条 active，不能剩下 unclear。允许补漏、删除误识别、重排、标记 crossed_out，原转录不覆盖。
- `POST .../{id}/discard`：保留原图/原转录但暂不采用，清除待确认状态、允许课堂自动推进；已确认记录不可丢弃。

`steps[]` 含 `id/order/text/expressions/region/mark`；`expressions` 为该行 LaTeX 字符串数组；`mark` 为 active/crossed_out/unclear。`ambiguities[]` 含 `id/step_id/region/reason/alternatives`。服务端附加 `source`（图像尺寸与 SHA-256）、`provenance`（适配器/模型/模式/提示词版本）、不确定性说明与事件 ID，禁止供应商自行伪造这些来源字段。完整 schema 可见 `/openapi.json` 请求部分及 `Transcription.model_json_schema()`。

确认不表示数学正确或学生已掌握。教学上下文仅含已确认 active 步骤、确认事件 ID 与不确定性；不创建 Knowledge 证据。`step_complete` 由学生核对时勾选，停笔/旧请求参数/模型输出均不能代替它。教学策略和 baseline 都要求确认。旧数据库中有 confidence 的观察不能通过新的 board gate。

课堂/题目已经切换、出现更新观察、图片哈希不符或当前暂停/语音中时，确认返回 409。相同确认重发是幂等的；不同内容不能覆盖已确认记录。需要继续修正时应重新提供更新的图片/快照，或先暂不采用待确认结果再重新识别。教师回复失败返回 `teaching_error`，核对已经保存；不会自动重新调用教师或视觉模型。

原图保存在观察 Event 中，包含在既有 JSON 导出里；删除教师时 SQLite 外键级联删除。没有新的磁盘图片孤儿、外部图片 URL、供应商密钥或真实学生数据入库到仓库。单图 data URL 上限 4MB（前端文件上限约 3MB），最长边 4096，最多 800 万像素，拒绝截断图、伪 PNG 和动画 PNG。观察图片是主动保存的复核资料，不受 `RETAIN_TRANSCRIPTS`（聊天轮次文本）开关控制；界面明确告知保存与发送。

## 评测

见 [评测说明与状态](handwriting-evaluation/README.md)、[固定图片标签](handwriting-evaluation/manifest.json) 和 [核对界面截图](handwriting-evaluation/review.png)。
