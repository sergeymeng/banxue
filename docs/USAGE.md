# 使用与配置

桌面版的安装、构建和设置见[桌面版说明](DESKTOP.md)；千问语音配置见[语音课堂](QWEN_VOICE.md)。本文介绍开发启动、文字课堂、模型配置和费用记录。命令均从仓库根目录开始执行，另有注明的除外。

## 快速启动

需要 Node.js **22.12+**、Python **3.11+**、[uv](https://docs.astral.sh/uv/)。开发验证环境为 Node 24 / Python 3.13。依赖由 package-lock.json 和 uv.lock 固定。

```bash
./scripts/dev.sh
```

打开 <http://localhost:3000>，后端 API 文档 <http://127.0.0.1:8000/docs>。Ctrl+C 停止。首次启动会安装依赖并复制 `backend/.env.example` 为 `backend/.env`；演示模式无需密钥。tiktoken 第一次使用需要下载 tokenizer 文件，之后读取本地缓存。

也可以用 Docker（本地开发部署）：

```bash
cp backend/.env.example backend/.env  # 已有配置时不要覆盖
chmod 600 backend/.env
docker compose up --build -d
```

地址相同。数据在 `tutor-data` Docker volume 中；`docker compose down` 停止但保留数据。容器只绑定主机 127.0.0.1；这不是已加固的互联网多用户服务。**不要与开发脚本同时占用 3000/8000 端口。** Docker 修改 .env 后用 `docker compose up -d --force-recreate backend` 生效；修改代码需重新 build。

分开启动：

```bash
# 终端一
cd backend
uv sync --frozen
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1

# 终端二
cd frontend
npm ci
npm run dev
```

## 第一次体验

1. 点“添加老师”，填写老师姓名、科目、语言、风格、偏好和默认模型角色。建议保留 A-level 数学；其他科目目前没有自动诊断题库。
2. 说：“我现在数学 B，还有一个月考试，我想冲 A*。”老师只追问缺失信息，例如考试局；回复“Edexcel”。入学抽取目前为中英关键词/格式规则，复杂时间与自由目标需要后续增强。
3. 在“教材”上传 PDF。仓库附有原创示例 `samples/derivatives.pdf`，不冒充官方考卷。提取结果包含页码、章节启发式、考试范围标签；相关片段可展开查看。文本不足的扫描页会显示需要 OCR。
4. 依次完成三道诊断题。支持 `18x+6`、`6(3x+1)`、`dy/dx=18*x+6` 等多项式表达式；“不会”按一次未完成记录。不支持的复杂表达式不武断判错。
5. 诊断后自动进入计划、讲解与练习，不需要反复输入“继续”。打字期间自动推进会暂缓；随时可提示、重讲、临时换话题、休息或结束。
6. 白板可以画笔、公式文本、图形和擦除；老师回复可用“添加老师便签”写入白板并撤销。当前题由控制器单独显示，评分始终依据该题。内置题最终答案在消息框提交，进行精确校验。
7. “请看这一步”导出当前学生页面内容并触发真实视觉模型；教师便签从视觉图像排除。真实模式可主动开启“停笔后观察”：编辑停止 3 秒、至少相隔 20 秒才分析，后台再次去重。**演示模式明确不识别手写内容。** 停笔观察默认保持安静，显式提交完整步骤才可能引发教师检查问题。
8. “结束本节”产生结构化摘要；刷新后点击同一老师恢复未结束课堂，结束后可开始下一节，依据历史薄弱点/到期复习继续。
9. “学习记录”查看带证据的记录；“用量”查看本节输入/输出、模型、缓存、延迟及估算费用。“导出全部数据”保存完整 JSON（桌面版使用系统保存窗口）；删除操作会删除该老师全部关联数据和 PDF。

## 配置真实模型（BYOK）

桌面版请直接使用“设置”：填写三个角色的端点、模型、密钥和单价，点击“保存并应用”。以下 .env 操作仅用于浏览器开发/Docker 部署。

密钥**仅写后端 `backend/.env`**，文件已被 .gitignore 排除。不要写到 NEXT_PUBLIC_* 或前端源码，不要粘贴密钥到聊天。三个角色可用不同供应商/端点/密钥。

将 `MODEL_MODE=live`，填写：

```dotenv
FAST_BASE_URL=https://api.openai.com/v1
FAST_MODEL=gpt-4.1-mini
FAST_API_KEY=你的密钥
REASONING_BASE_URL=https://api.openai.com/v1
REASONING_MODEL=gpt-4.1
REASONING_API_KEY=你的密钥
VISION_BASE_URL=https://api.openai.com/v1
VISION_MODEL=gpt-4.1-mini
VISION_API_KEY=你的密钥
```

模型名是可修改示例，不保证某账号可访问。适配器实现标准 OpenAI-compatible `POST /chat/completions`，文本和 PNG `image_url` 输入；未使用中央代理服务器。文档依据：[Chat Completions 官方 API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

**必须设置每个角色的价格**，单位为 **GBP / 1,000,000 Token**：`FAST_INPUT_GBP`、`FAST_OUTPUT_GBP`、`REASONING_INPUT_GBP`、`REASONING_OUTPUT_GBP`、`VISION_INPUT_GBP`、`VISION_OUTPUT_GBP`。缓存价可选。根据供应商当时的价格和币种自行换算，仓库不把示例价格伪装成当前价格。未配置价格时请求被拦截。

成本相关配置：

| 配置 | 默认 | 含义 |
|---|---:|---|
| REQUEST_BUDGET_GBP | 0.15 | 单请求估算上限 |
| SESSION_BUDGET_GBP | 3 | 每节课估算额度 |
| DAILY_BUDGET_GBP | 5 | 本机 UTC 日估算额度 |
| CONTEXT_TOKENS | 4200 | 文本上下文预算 |
| MAX_OUTPUT_TOKENS | 700 | 最大输出 Token，含供应商计入的推理 Token |
| VISION_TOKEN_ALLOWANCE | 6000 | 图像 Token 保守预留，可按模型调整 |
| HISTORY_MESSAGES | 8 | 每次加载的近期消息数 |
| REQUEST_TIMEOUT | 45 | 请求超时秒数 |

仅普通对话走 FAST；计划、重讲、完整白板步骤检查及换话题走 REASONING；图像走 VISION。当前采用确定性路由，尚无经校准的“自信度不足自动升级”。预算不足暂停，不会为省钱悄悄降低数学评分标准。

供应商用量为 `actual_usage`；费用始终是按配置单价计算的**估算**，不是账单。缺少 usage、超时或学生中断时保留保守预留，避免隐藏可能发生的成本；无自动重试。单进程锁防止并发预算竞争，**必须一个后端 worker**。图像分词、供应商价格变化或未知 usage 使硬账单上限无法由本地保证。删除数据也会删除关联费用记录；供应商侧限额可作为独立约束。£1–£3/60 分钟只是未验证目标。

### 本地 Ollama / 其他兼容供应商

把三角色 URL 分别改为 `http://localhost:11434/v1`（Docker 访问宿主机使用 `http://host.docker.internal:11434/v1`），模型名改为已安装模型。无需认证的本地端点密钥留空，明确把模型价格设为 `0`；这里只表示 API 货币费用，不包括电力/硬件。配置 `COMPLETION_TOKEN_FIELD=max_tokens` 适配只支持旧字段的端点。VISION 必须是实际支持图片的模型；没有视觉模型就使用文字答案。Ollama 分支只做兼容协议实现，未在本轮连接真实 Ollama 验证。

## 模块与数据

- `backend/app/policy.py`：可替换 TeachingPolicy / BaselinePolicy，八种状态和动作契约。
- `curriculum.py`：三知识点题库、基于 AST 与有理数的精确多项式等价校验，禁用 eval。
- `context.py`：按预算装配当前目标、近期对话、历史证据和少量教材片段。
- `llm.py`：三角色适配、费用预留、usage 解析、失败/中断处理。
- `documents.py`：PDF 逐页提取、章节启发式、FTS5 检索。
- `db.py` / `service.py`：SQLite 四层记忆、证据、复习与课堂事务。
- `frontend/components/Whiteboard.tsx`：白板持久化、用户事件过滤、按需图像导出与教师便签。
- `voice.py` / `qwen_voice.py` / `voice_session.py`：独立 ASR/LLM/TTS 契约、千问云端流式适配和课堂插话/播放回执；见[语音说明](QWEN_VOICE.md)。

默认本地数据目录 `backend/data/`。教师代表本机单个学生的独立教师空间，尚无账号/多学生授权模型。教学与模型均无外部工具执行能力。教材只作为不可信证据输入，不进入 system 提示；这降低风险但不等于已证明彻底解决提示注入。`RETAIN_TRANSCRIPTS=false` 关闭完整 turn 文本日志，仍保留最近 30 条课堂消息用于续课、评分证据和结构化摘要；它不是零数据模式。未实现数据库加密或针对未成年人完成合规审计。

文字课堂仍使用 HTTP JSON；千问语音课堂使用受独立票据保护的 WebSocket，文本 SSE 逐步输出并分句合成。语音轮次取消时丢弃旧文本/音频、保留不确定费用；视觉观察仍以单请求超时为界。

完整设计见 [ARCHITECTURE.md](../ARCHITECTURE.md)。评测入口、实测与未测指标见 [EVALUATION.md](EVALUATION.md)。

## 测试

```bash
./scripts/test.sh
# 浏览器测试（会启动隔离的 3100/8100 服务）
cd frontend
npx playwright install chromium
npm run test:e2e
```

浏览器测试使用 `backend/data/e2e/`，不读取主课堂数据库。严格同模型消融时，将 FAST_MODEL 与 REASONING_MODEL（及对应端点）配置为同一个模型，并保持其他预算一致；默认多模型路由本身也是实验变量。

模型接口测试使用 `httpx.MockTransport`，它验证请求/响应、图像路由、错误与费用逻辑，**不证明真实模型准确率**。测试结论和执行范围见 [TEST_REPORT.md](TEST_REPORT.md)。

评测导出：

```bash
python3 scripts/evaluate.py export.json
cd backend && uv run python ../scripts/audit_licenses.py
```
