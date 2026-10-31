# 本地 AI 私人教师 MVP

## 范围与数据流

单用户、本机优先。Next.js/React + tldraw → FastAPI JSON API → 独立 TeachingPolicy → 有界 ContextBuilder → OpenAI-compatible adapter → SQLite。HTTP 请求返回完整教师轮次；SSE 发送开始/完成事件。不做多用户协作；0.3 新增独立的千问流式语音课堂。文字会话是控制通道，白板是工作区。

## 教学控制

八个持久化状态：ONBOARDING → DIAGNOSTIC → PLANNING → EXPLAINING → GUIDED_PRACTICE → INDEPENDENT_PRACTICE → REVIEW → SESSION_SUMMARY。TeachingPolicy 产生结构化 action、reason、instruction 和自动推进标记，语言模型只负责表达。可中断的有限自动步骤由前端定时触发，服务端校验当前状态；绝不在等待学生解题时无限生成。暂停、结束、重讲、换题是独立控制。基线模式跳过策略，使用同样模型/上下文和计量。

MVP 内置范围为 A-level 多项式求导的三个知识点。确定性多项式等价校验为内置题评分；任意问题转推理模型，但不会把其未经验证的判断写成客观成绩。入学信息从自由文本提取，缺字段逐个问。考试局只是用户报告范围，内置题不冒充官方考纲。

## 四层记忆

1. Session：状态、当前题、近期对话、白板快照、暂停位。
2. Lesson summary：结构化课堂摘要和事件来源；结束时生成，无模型费。
3. Knowledge：知识点尝试/正确次数、置信度、证据事件 ID、复习日期；单次证据不等于长期掌握。
4. Document/Chunk：PDF 原文件、本地逐页文本、章节启发式、SQLite FTS5 检索索引。每次最多选取三个片段；检索空结果明确返回。

教师间数据隔离，单教师对应本机单学生。继续未结束课堂直接恢复；新课加载上次摘要、知识记录及到期复习。无无限历史拼接。

## 白板

tldraw 文档编辑事件本地 debounce 保存；仅用户变更设置 dirty。自动观察默认关闭，启用后停笔 3 秒且距上次视觉请求至少 20 秒才触发；“请看这一步”可显式触发。旧白板仍导出整页并标记为 legacy_page，选区裁剪由白板分支实现；区域图片契约与独立核对界面见 docs/HANDWRITING.md。本分支用上传的区域 PNG 和固定合成图片开发，不把整页导出称为用户选区。

PNG 必须可完整解码；图片尺寸、哈希、来源页/快照/选区、原图、模型转录和人工修改都保存在 SQLite 观察事件中，随教师导出/删除。VisionService 可替换，默认适配器沿用用户的 VISION 配置与 Gateway 预算，使用 high 图像细节与独立视觉输出额度。结构化结果包含中文/英文文本、LaTeX 表达式、步骤顺序、归一化区域、涂改状态、歧义及来源。定位是模型估计，不是校准坐标；不接收模型 confidence 作为准确率。

新识别先进入待核对状态，不进入教学上下文、不触发教师生成或评分。学生可修正文本/表达式/顺序/区域、补漏、标记涂掉、逐项说明歧义，或暂不采用；待核对时暂停自动推进。确认后产生来源事件，只把保留步骤作为不可信课堂数据交给教学模块；选择“这一步写完了”才触发 board 检查问题。所有视觉结果均不自动更新 Knowledge。重复确认不会再次请求模型；教师生成失败保留核对记录与不确定费用。

## 模型与成本

FAST/REASONING/VISION 分别配置 URL、模型、密钥、输入/输出/缓存价格。支持标准 /chat/completions 和 Ollama 兼容端点；demo 显式为本地规则模拟，不冒充 LLM/视觉。预算单位 GBP，价格必须由用户填写，不硬编码成最新价格。供应商 token usage 原样保留，费用一直标为估算。未知计费不显示成零。

文本上下文采用 tiktoken 估算并执行硬上限；非对应 tokenizer 可能有误差。请求预算预留输入+最大输出+视觉 token allowance，单请求/课堂/UTC 日预算一起检查。全局串行锁和数据库预留防止单进程并发超支，故部署限定一个 worker。网络超时/返回异常保留不确定费用预留，禁止隐式重试产生额外账单。不能保证供应商真实账单上限（计价变化/图像 tokenizer 差异），需要供应商侧限额。

## 隐私与失败

密钥仅 .env/进程环境读取；API 返回配置不返回密钥，日志不保存 prompts/headers。本机 origin/Host 校验，无公网部署授权体系。上传限制 20MB/300 页，拒绝非 PDF、加密 PDF，扫描空白页标记 OCR_REQUIRED，不能声称读懂。教材作为不可信 user 数据，永不提升为 system 指令；模型无工具、文件系统或执行权限。单教师完整 JSON 导出包括原始 PDF 的 base64；删除清理全部关联记录/文件/FTS，浏览器不保留学习数据。

语音使用独立 ASR/LLM/TTS 适配、一次性票据 WebSocket 和本地 VAD；评测导出区分实测/代理/未测指标，支持策略消融。不是教学效果证明。

## 许可

自编代码 MIT；tldraw 5 SDK 单独受 tldraw license 约束。当前组合不是全套宽松许可开源。发布前应取得适用授权或替换白板。见 docs/DEPENDENCIES.md。

## 桌面应用（0.2）

Electron 主进程管理一个打包后的 Python 服务，Next.js 通过 `output: export` 生成静态界面，由同一个 FastAPI 端口提供。PyInstaller onedir 包含 Python、运行依赖与 tiktoken 缓存；已生成的 .app 不依赖用户安装 Node、Python、Docker 或联网下载 tokenizer。

每次启动随机分配 loopback 端口，并生成只存于进程内的访问令牌。主进程给自己窗口的请求注入令牌，后端对 UI/API 全部校验；普通浏览器直接访问该端口返回 401。窗口开启 sandbox/contextIsolation，关闭 nodeIntegration，禁止远程导航、webview、新窗口；只对当前可信主窗口的 audio-only 请求开放麦克风。模型供应商请求仍只发生在 Python 服务。

设置通过白名单 IPC 读写。已保存 API Key 不返回渲染进程；输入的新密钥传给主进程，用 Electron safeStorage 异步接口调用系统密钥提供者加密，密文写入应用私有目录。无密钥的设置仅含非敏感字段，可明文保存。设置应用会重启内置服务，失败时尝试恢复旧配置。保存设置过程中不要提交新课堂请求；正式版本应进一步完善忙碌协调与退出前的白板持久化。

数据路径：macOS `~/Library/Application Support/Banxue/learning`，与此前 Docker volume 和 backend/data 开发数据独立。没有未经请求自动迁移或删除旧数据。应用退出会终止它启动的服务。桌面 UI 使用系统字体、紧凑工具栏与独立教材/记录/用量页面，保留现有教学策略和教师语言逻辑。

打包范围：本机生成并验证 macOS Apple Silicon .app。没有 Developer ID 签名/Apple 公证，尚未在 Windows/Intel Mac 验证。tldraw 许可边界不因桌面打包而改变；此构建用于本地开发评估。


## 千问云端语音课堂（0.3）

本地 AudioWorklet + Silero VAD → 课堂票据 WebSocket → Qwen ASR（inference 二进制 PCM）→ 原 `service.turn` / TeachingPolicy / 有界上下文 → Qwen 文本 SSE → 分句队列 → Qwen TTS（realtime JSON/PCM）→ 独立老师播放 AudioContext。业务层不包含供应商事件协议，适配器可替换。

插话候选先本地 gain 静音并暂停播放时钟，麦克风继续监听；原 TTS 消费暂缓。ASR 完成后空结果/白名单短应答恢复队列，实质问题取消旧轮和旧任务。每个回复与句段有独立 ID，客户端和服务器同时拒绝过期结果。按句段完成回执记录已播放内容，打断位置为近似毫秒边界。未播放内容不触发自动推进，也不能构成评分证据。没有自主板书动作队列，保留未来暂停/取消契约。

语音配置独立于既有文字/视觉配置，复用 safeStorage、课堂数据库和 GBP 预算。ASR 以秒、TTS 以字符预留，取消/超时不释放不确定支出；不重试付费调用。WebSocket 独立验证来源、一次性身份票据及课堂绑定；HTTP 中间件不能代替该验证。详细协议、官方价格依据、限制与复测步骤见 `docs/QWEN_VOICE.md`。
