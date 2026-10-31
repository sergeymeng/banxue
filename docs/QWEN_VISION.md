# Qwen 视觉转录适配

核验日期：2026-10-31。第一阶段选择 Qwen 系列作为配置方向；保留用户自选模型与 `VisionService` 替换接口。本轮只完成官方协议核对和模拟请求测试，**没有真实 Key 调用，不证明 Qwen 的识别正确率或延迟**。

## 显式启用，不迁移旧设置

在后端环境中明确选择 `VISION_ADAPTER=qwen_vl`，并由用户填写 VISION_BASE_URL、VISION_MODEL、VISION_API_KEY 和 GBP 单价。没有此项时继续使用既有 `chat_completions` 适配。代码不会根据模型名猜供应商，也不会覆盖原 URL、密钥、文字模型或语音配置。

可从控制台可用的 `qwen3-vl-plus` 非思考模式开始验证，不宣称这是最新、最低价或已实测最佳模型。用户可以选择官方列为支持图片和 JSON Object 的其他型号；仅思考型号不适合本适配。

```dotenv
# 手工合入需要的配置，不要覆盖整个已有 .env
MODEL_MODE=live
VISION_ADAPTER=qwen_vl
VISION_MODEL=qwen3-vl-plus
VISION_BASE_URL=https://YOUR_WORKSPACE_ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
# VISION_API_KEY 在本机填写，不提交、不发给前端
# VISION_INPUT_GBP / VISION_OUTPUT_GBP：用户根据所选型号与币种换算填写
VISION_MAX_OUTPUT_TOKENS=4096
```

北京及新加坡的业务空间端点分别使用 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` 与 `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`；文档说明原 dashscope 域名仍可用。必须让密钥、空间与地域匹配。端点由用户填写，本适配不自动迁移。[官方 Chat Completions 地址与参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)

桌面设置现阶段未增加 `vision_adapter` 字段；主协调如接入“Qwen 视觉”预设，须先明确选择后再写入配置，并同步扩展设置白名单及环境映射。本分支没有改桌面设置或凭据存储。

## 请求与响应

使用 `POST {VISION_BASE_URL}/chat/completions`，图片为用户消息中的 `image_url.url = data:image/png;base64,...`，不传外部文件 URL，不上传原白板快照。Qwen 配置不附带未经本轮验证的 `image_url.detail` 字段；输入 PNG 不被再次缩小。[官方视觉输入与本地文件说明](https://help.aliyun.com/zh/model-studio/vision)

仅视觉请求使用：

```json
{
  "model": "用户选择的视觉型号",
  "max_tokens": 4096,
  "enable_thinking": false,
  "response_format": {"type": "json_object"},
  "messages": ["带 JSON 关键词与本地 schema 的转录要求", "图片用户消息"]
}
```

上面 messages 是结构说明，实际线协议使用标准 role/content 数组。`enable_thinking` 是 HTTP JSON 顶层字段；`extra_body` 是 SDK 的透传选项，不能照搬成 HTTP body 的嵌套字段。[官方思考模式说明](https://help.aliyun.com/zh/model-studio/deep-thinking)

Qwen3-VL 的 JSON Object 适用非思考模式；提示中需含 JSON。当前官方说明图片等多模态输入即使配置 JSON Schema 也会退回 JSON Object，因此服务端仍使用 Pydantic 校验所有步骤、区域和引用，不声称供应商强制遵循 schema。[官方结构化输出说明](https://help.aliyun.com/en/model-studio/qwen-structured-output)

`max_tokens` 采用独立视觉额度，预算预留仍经 Gateway。文字/语音请求不带这些视觉参数。显式 `finish_reason=length/content_filter/...` 的视觉结果被拒绝，不把完整 JSON 外形视为完整识别；无 usage、超时或不确定失败保留费用预留。模型不支持参数、HTTP 错误或 schema 不合格时均不自动降级、不重试、不调用第二个模型修复。

## 复测

设置已选择的型号与价格后，使用 [手写评测脚本](handwriting-evaluation/README.md) 的 `--collect-live`。成功后记录具体模型名、图片指纹、协议适配名、真实错误和用量来源。没有实际运行之前保持 `not_run`。接口 mock 的响应是固定文本，不能当成 Qwen 输出。
