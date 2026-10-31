# 依赖许可核查

本轮核查安装包元数据、更新后的 lockfile 与白板候选官方条款；并不构成整个依赖树已获得法律清算的声明。

| 直接依赖 | 本轮安装版本 | 声明许可 |
|---|---|---|
| Next.js | 16.4.3 | MIT |
| React / React DOM | 19.3.1 | MIT |
| PDF.js (`pdfjs-dist`) | 6.4.299 | Apache-2.0；PDF 渲染，字体/CMap/WASM 保留包内各自许可 |
| 自研 SVG 白板 | v1 | 仓库 MIT；不新增依赖 |
| TypeScript | 5.9.3 | Apache-2.0 |
| Vitest | 5.0.5 | MIT |
| Playwright | 1.64.1 | Apache-2.0 |
| FastAPI / SQLAlchemy / HTTPX / Uvicorn | 见 uv.lock | 各包原许可证，见机器清单 |
| pypdf / tiktoken / Pydantic | 见 uv.lock | 各包原许可证，见机器清单 |

机器生成的 [dependency-licenses.json](dependency-licenses.json) 包含 lockfile 中 JS 包和本轮安装 Python 包的版本/许可元数据。UNDECLARED 与 SEE LICENSE 项需要查阅原文件，不代表 MIT。字体、图标、传递依赖也保留原许可证。

依据 [tldraw 官方许可说明](https://tldraw.dev/community/license) 与 [tldraw 原始许可证](https://github.com/tldraw/tldraw/blob/main/LICENSE.md)，SDK 默认许可仅允许开发用途；生产用途需要适用的 trial/commercial/hobby 许可。即使本机运行也应按实际使用场景核对条款，不能把“localhost 技术上可显示”误当成生产法律许可。不得绕过许可证校验、移除标识，或将 SDK 重新许可为 MIT。

本项目 LICENSE 只覆盖自编代码。当前白板已替换为自研 React/SVG 实现，`tldraw`、`@tldraw/assets` 及其独占传递依赖已从前端 lockfile 移除。不分发原 SDK 资源，不使用许可密钥，不改动旧 SDK 的水印或校验。历史 tldraw 许可证原文仍保留供历史构建核查。**不能据此宣称所有依赖为 MIT 或整个发布包完成法律审查。**

[选型记录](WHITEBOARD_DECISION.md)比较 tldraw、Excalidraw、Konva 与自研 SVG，说明版本范围和原文依据。[接口契约](WHITEBOARD_CONTRACT.md)定义快照、动作队列、归属、导出、撤销和旧数据保留边界。

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

VAD 与 ONNX WASM/模块随静态前端打包，不从 CDN 加载。只运行轻量语音活动检测，不部署或训练本地 ASR/LLM/TTS。许可正文保存在 `docs/licenses/` 并随桌面资源分发。千问云服务本身不因客户端代码开源而成为开源模型分发；使用须遵守账号服务条款。当前白板不再包含 tldraw SDK；历史 SDK 的专有许可、水印和校验要求保持不变。

浏览器声学测试夹具 `frontend/tests/fixtures/interruption-synthetic.wav` 是使用本机 macOS Tingting 生成的合成中文语音，只是测试输入，不含学生录音，也不将系统声音资源打包为产品模型。它不能作为真人准确率、回声或千问 TTS 质量证据。

PDF.js 的 worker、CMap、标准字体及 WASM 从安装包复制到本地静态目录，桌面版一并打包，无需 CDN。Apache 许可证见 [pdfjs-LICENSE.txt](licenses/pdfjs-LICENSE.txt)，`public/pdf/` 也包含原文；字体与 CMap 的许可随其目录保留。
