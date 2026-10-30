# 本轮验证记录

本文记录 0.1 / 0.2 阶段的测试。0.3 的课堂回归、语音和桌面验证见[千问语音课堂验证报告](VOICE_TEST_REPORT.md)。

执行日期：2026-10-30。运行环境：macOS、Python 3.13.15、Node 24.21.0，Docker Engine 29.8.2。以下仅报告实际执行结果。

## 已通过

| 检查 | 结果 | 覆盖范围 |
|---|---|---|
| `uv run pytest -q` | 26 passed | 八状态完整课程、精确多项式/危险表达式、控制中断、PDF/扫描检测、检索隔离、白板存取、导出删除、上下文预算、来源权限、供应商 usage/缓存费率、预算请求前拦截、并发日预算、网络失败、视觉置信度与去重、推理路由、进程重建恢复、失败回滚、模型请求中断 |
| `uv run ruff check app tests` | passed | Python 静态检查 |
| `npm run typecheck` | passed | TypeScript 严格检查 |
| `npm test` | 3 passed | 无编辑不观察、停笔判定、忙碌保护、冷却和新编辑要求 |
| `npm run build` | passed | Next.js 生产构建与静态页面生成 |
| `npm run test:e2e` | 2 passed | Chromium 完整演示课堂 / 390px 手机欢迎页无横向溢出 |
| `docker compose config --quiet` | passed | Compose 配置 |
| `docker compose build` | passed | 前后端镜像构建 |
| `docker compose up -d --wait` | passed | 后端健康检查、前端容器启动 |
| HTTP smoke | 200 | `/health` 返回 demo/ok，前端页面 HTTP 200 |
| 依赖许可证清单 | generated | 269 JS lockfile 条目、36 Python 安装包；不代表法律兼容性结论 |

Playwright 会真实操作页面、上传示例 PDF、画笔书写、导出 PNG 到观察端点、插入教师便签、刷新恢复白板、继续授课；失败的第一轮定位器已修正并复跑成功。页面渲染截图见 classroom.png，已目视检查。测试结束删除套件创建的老师；测试独立数据库路径为 backend/data/e2e。

后端测试存在一个上游 deprecation warning：Starlette TestClient 建议未来使用 httpx2；当前 HTTPX 测试仍通过。未忽略测试失败来制造通过结果。

## 未验证 / 尚不支持

- 没有真实 BYOK 密钥，未向收费供应商请求教学或视觉识别。MockTransport 通过不等于真实供应商联调通过。
- 未运行真实 Ollama 模型；其兼容 URL 和 token 参数可配置。
- 未测手写识别准确率、复杂数学诊断准确率、真实学生学习增益、一周保持率、60 分钟 £1–£3 费用目标。
- 没有 OCR/实时语音/公网多用户安全/完整考纲；不把接口契约当成功能实现。
- 生产打包成功不代表具有 tldraw 生产许可。发布前须取得适用许可或替换白板。
- Chrome/Chromium 已测；Safari、Firefox、触屏笔压/真实平板尚未验证。

## 可重复执行

```bash
./scripts/test.sh
cd frontend
npx playwright install chromium
npm run test:e2e
```

模型接口测试使用本地受控响应，预算/超时/中断测试无需 API Key、不产生模型费用。

## 桌面与界面改版追加验证（0.2）

- 后端：27 项通过，新增桌面令牌对 API/静态 UI 的访问保护测试；Ruff 通过。
- 前端：TypeScript、3 项 Vitest、静态导出构建通过。
- 浏览器：2 项 Playwright 通过，已适配新的课堂/教材/记录页面；切换页面后白板元素仍在可视区域。
- 桌面设置：5 项 Node 测试通过，覆盖密钥脱敏/保留/删除、端点与价格校验、环境变量白名单。
- 打包 .app：真实启动、创建老师、PDF 导入、文字课堂、白板编辑、设置保存后自动重启、进程退出/重启恢复、服务随应用关闭、无令牌 API 访问拒绝均通过。
- 未使用真实 API Key，未测付费模型；系统密钥存储的真实凭据操作尚未做端到端验证。
- 本轮不改变教学策略和教师语言生成行为，仅重构桌面交付、设置与界面。
