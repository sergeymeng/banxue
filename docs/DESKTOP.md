# 桌面版 0.3

新增千问语音配置、受限麦克风权限、VAD 与流式播放；详见 [配置与使用](QWEN_VOICE.md) 和 [验证报告](VOICE_TEST_REPORT.md)。

本轮产物：`dist/伴学-darwin-arm64/伴学.app`，适用于 Apple Silicon Mac。应用包含前端、Python 服务和运行依赖，不需要先开终端、Docker 或浏览器。初次打开是演示模式，不调用付费模型。

## 使用

- 双击 `.app`；也可以拖入 Applications。提供的 DMG 用于复制安装。
- 点击“添加老师”，创建后直接进入课堂。
- 左侧切换课堂、教材、学习记录和用量。上次的老师会自动打开。
- “设置”或 ⌘, 配置三个模型角色、API Key、单价和预算；保存后自动应用，无需改 .env。
- ⌘N 添加老师，⌘O 导入教材。导出数据使用系统保存窗口。
- 退出应用会停止内置服务；重开恢复课堂。软件不会自动调用模型，除非已经启用真实模式且触发教学/观察操作。

模型密钥通过 Electron safeStorage 的异步接口使用 macOS Keychain 保护的加密机制保存。已有密钥不会重新显示在设置页面；留空保留，勾选删除才清除。假 Key 的加密保存、密文文件及不回传渲染层已通过桌面测试；真实用户 Key 和付费 API 调用尚未验证。这个开发包没有 Developer ID 签名和 Apple 公证；macOS 在分发/更新时可能要求安全确认或重新授权密钥访问。

学习数据：`~/Library/Application Support/Banxue/learning`。设置文件位于同级 `settings.json`；包含密钥时保存的是密文。浏览器开发版的 .env 配置和数据、Docker volume 都保持独立；本轮没有迁移旧数据。

## 构建

在 macOS / Apple Silicon 上，需要 Node 22.12+、uv、Python 3.11+ 和系统开发工具：

```bash
./scripts/build-desktop.sh
```

脚本会静态导出 Next.js、用 PyInstaller 打包 Python、用 Electron Packager 生成应用。首次构建需下载依赖和 tokenizer；生成后的演示应用运行不依赖互联网。项目构建文件和产物被 Git 忽略，原始源码保留在 desktop/。

只更新前端与桌面壳时可复用已打包的引擎：

```bash
cd frontend && DESKTOP_BUILD=1 npm run build
# 在仓库根目录更新 build/desktop-resources/web 后
cd desktop && npm run package
```

## 验证

```bash
cd desktop
npm test
npm run test:smoke
npm run test:voice  # 假 Key、假麦克风、mock 云端；真实打包 VAD/播放与 CSP
```

`test:smoke` 启动真实打包后的 `.app`，使用临时数据目录测试创建老师、目标交流、PDF、白板、设置应用、退出/重开、状态恢复、服务退出，以及无令牌访问 API 被拒绝。不会访问用户已有学习数据，也不会调用付费模型。

截图 `desktop-app.png`、`desktop-settings.png` 来自真实应用窗口；Playwright 内容截图不包含 macOS 原生交通灯按钮。界面修改已通过浏览器课堂回归和手机宽度测试。

## 尚未完成

- Developer ID 签名、公证、自动更新和正式发布流程。
- Windows、Linux、Intel Mac 的构建/验证。
- 旧版 Docker/开发数据库的一键迁移。
- 应用强制退出前最后一个未完成白板保存请求的保证；看到“已保存到本机”后再退出最可靠。
- 真模型课堂、视觉准确率和真实凭据的端到端验证。
- 当前前端已采用自研 SVG 白板，重打包时使用最新静态产物。历史 tldraw 构建仍须遵守原 SDK 许可；本构建供本地开发评估。
