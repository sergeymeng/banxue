# 白板选型与许可核查（2026-10-31）

本分支把课堂白板替换为自研 React + 浏览器 SVG 实现，新增代码适用仓库 MIT 许可，不引入新 npm 依赖。范围是单机同一课堂的一块解题白板；不含多人联网协作。

| 候选 | 许可依据 | 对本阶段的适合程度 | 决定 |
|---|---|---|---|
| tldraw 5.6.0 | [官方许可](https://tldraw.dev/community/license)、仓库保留的原文 `docs/licenses/tldraw-package-LICENSE.md` | 编辑器成熟，但 SDK 专有许可不符合完全开源目标 | 移除运行依赖、样式与资源复制；不修改 SDK、校验或水印 |
| Excalidraw | [上游 MIT 原文](https://github.com/excalidraw/excalidraw/blob/master/LICENSE) | 自由绘图和完整编辑器成熟；需额外适配数学文本、动作回执、教师/学生归属和旧格式 | 可作为以后更完整编辑器的候选；本次没有安装或宣称核查其完整依赖树 |
| Konva | [上游项目与 MIT 声明](https://github.com/konvajs/konva)、[官方 FAQ](https://konvajs.org/docs/faq.html) | 提供图形场景基础，仍需实现队列、历史、归属与工具栏 | 本阶段图形数量/种类有限，暂不增加中间层 |
| 自研 SVG | 仓库 [MIT](../LICENSE)，原生浏览器 API | 可以用受约束的数据直接表示笔画、文本、公式、箭头、矩形和椭圆；导出与屏幕使用相同几何 | 采用；维护成本由本项目承担 |

这里对候选的工程取舍是本项目判断，不是上游性能对比测试结果。

## 许可边界

- 已从 `frontend/package.json`、lockfile 移除 `tldraw`、`@tldraw/assets` 及其独占传递依赖。新版不分发 tldraw 字体、图标或翻译。使用系统字体。资源脚本会清理旧 checkout 中生成的 `public/tldraw`，避免重新打包旧资源。
- 保留历史 tldraw 许可原文与仓库的禁止绕过要求；旧版构建仍按原许可处理。新版不使用 `NEXT_PUBLIC_TLDRAW_LICENSE_KEY`。
- 运行 `cd backend && uv run python ../scripts/audit_licenses.py` 更新 `docs/dependency-licenses.json`，直接依赖版本来自 lockfile。元数据不等于完整法律审查；`UNDECLARED`、`SEE LICENSE` 项仍须结合分发内容核查。
- React/Next、语音运行时、桌面 Electron/Chromium、Python/PyInstaller 仍有各自许可和 notices。移除专有白板 SDK 不意味着整个应用、模型服务或所有依赖都变成 MIT。

2026-10-31 的前端 lockfile 核查结果：保留 136 个包条目，移除 150 个 tldraw 相关条目，保留包的版本没有变化，没有新增条目。声明许可分布为 MIT 70、Apache-2.0 23、BSD-3-Clause 11、ISC 4、0BSD 1、MPL-2.0 12、CC-BY-4.0 1，以及 LGPL/Apache/MIT 组合 14。其中 Sharp/libvips 包含 LGPL，Lightning CSS 为 MPL，caniuse-lite 数据为 CC-BY；这些不能归为 MIT。lockfile 包含未安装平台的可选二进制，实际分发应按目标平台保留相应声明。没有发现前端 `UNDECLARED` 条目；这仍不替代包内 notices 核查。

## 第一阶段能力与边界

学生可用鼠标、触摸、笔写字，整笔擦除、撤销/重做、框选区域、缩放并导出 PNG。教师通过严格校验的动作依次添加文本、Unicode 公式、笔画、矩形、椭圆圈选、箭头并擦除教师元素。蓝色表示老师，黑色表示学生；归属同时保存在数据中。

白板是 1600 × 1200 的单页，可滚动和缩放。公式是 Unicode 数学文本，不支持 LaTeX 排版；没有笔压笔锋、像素级橡皮、对象移动/旋转、多页或无限画布。屏幕文本按宽度换行、按元素高度裁切，接入方须给内容足够空间。该范围适合验证逐步解题动作，不宣称与通用绘图编辑器功能等价。

旧快照不做不完整的自动转换：显示只读提示，允许下载原始 JSON；用户明确新建后原文保存在 `legacySnapshot`，随新版快照继续保存。旧快照完整视觉恢复/编辑需要后续迁移器或合法使用旧版；没有静默清空旧数据。

详见 [接口契约](WHITEBOARD_CONTRACT.md)。教学和手写识别通过该接口接入；当前“开发演示”只有固定动作，不调用模型、不识别手写、不产生掌握度证据。
