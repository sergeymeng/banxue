# 依赖许可核查

本轮核查安装包元数据、lockfile 与 tldraw 官方条款；并不构成整个依赖树已获得法律清算的声明。

| 直接依赖 | 本轮安装版本 | 声明许可 |
|---|---|---|
| Next.js | 16.4.3 | MIT |
| React / React DOM | 19.3.1 | MIT |
| tldraw / @tldraw/assets | 5.6.0 | tldraw license，专有、source-available |
| TypeScript | 5.9.3 | Apache-2.0 |
| Vitest | 5.0.5 | MIT |
| Playwright | 1.64.1 | Apache-2.0 |
| FastAPI / SQLAlchemy / HTTPX / Uvicorn | 见 uv.lock | 各包原许可证，见机器清单 |
| pypdf / tiktoken / Pydantic | 见 uv.lock | 各包原许可证，见机器清单 |

机器生成的 [dependency-licenses.json](dependency-licenses.json) 包含 lockfile 中 JS 包和本轮安装 Python 包的版本/许可元数据。UNDECLARED 与 SEE LICENSE 项需要查阅原文件，不代表 MIT。字体、图标、传递依赖也保留原许可证。

依据 [tldraw 官方许可说明](https://tldraw.dev/community/license) 与 [tldraw 原始许可证](https://github.com/tldraw/tldraw/blob/main/LICENSE.md)，SDK 默认许可仅允许开发用途；生产用途需要适用的 trial/commercial/hobby 许可。即使本机运行也应按实际使用场景核对条款，不能把“localhost 技术上可显示”误当成生产法律许可。不得绕过许可证校验、移除标识，或将 SDK 重新许可为 MIT。

本项目 LICENSE 只覆盖自编代码。保留用户指定 tldraw 是首轮工程取舍，**“全部组件完全开源且无生产许可限制”这一目标尚未实现**。本地 Docker 配置用于开发评估；前端支持 `NEXT_PUBLIC_TLDRAW_LICENSE_KEY` 传入合法许可，该公开许可标识不是模型 API 密钥。

白板代码隔离在 Whiteboard.tsx；选择另一白板后需要实现快照、用户编辑订阅、PNG 导出、便签、迁移与撤销契约。不能只替换 npm 包名就宣称兼容。

## 桌面包新增依赖

Electron 45.2.0 声明 MIT，内部 Chromium 与其他组件保留各自许可（随 Electron 分发的 LICENSE/Chromium notices）；@electron/packager 20.3.0 使用其声明许可。PyInstaller 6.22.3 为带引导程序例外的 GPL 许可，应用运行时依赖仍分别保留许可证；不能将整个打包产物统称 MIT。项目中的原始许可证指针见 `docs/licenses/tldraw-package-LICENSE.md`。

本机产物是本地开发评估包，没有 Developer ID 签名/Apple 公证，不作为已经完成许可审查的正式产品发布。


## 千问语音课堂（0.3）新增依赖

| 组件 | 安装版本/资源 | 许可 |
|---|---|---|
| `@ricky0123/vad-web` | 0.0.31 | ISC，含独立 Silero 模型声明 |
| Silero VAD | 包内 `silero_vad_v5.onnx` | MIT（Silero Team） |
| `onnxruntime-web` | 1.31.1 | MIT；附第三方 notices |
| Python `websockets` | 16.1.1 | BSD-3-Clause |

VAD 与 ONNX WASM/模块随静态前端打包，不从 CDN 加载。只运行轻量语音活动检测，不部署或训练本地 ASR/LLM/TTS。许可正文保存在 `docs/licenses/` 并随桌面资源分发。千问云服务本身不因客户端代码开源而成为开源模型分发；使用须遵守账号服务条款。tldraw 原有专有许可、水印和校验保持不变。

浏览器声学测试夹具 `frontend/tests/fixtures/interruption-synthetic.wav` 是使用本机 macOS Tingting 生成的合成中文语音，只是测试输入，不含学生录音，也不将系统声音资源打包为产品模型。它不能作为真人准确率、回声或千问 TTS 质量证据。
