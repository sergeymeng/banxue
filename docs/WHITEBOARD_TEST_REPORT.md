# 白板第一阶段验证记录

日期：2026-10-31。分支：`codex/teaching-board`。独立 worktree，从 `94a0102` 开始；不改动主工作区正在进行的语音/识别开发，不合并 main。

## 已通过

| 验证 | 结果 |
|---|---|
| `cd backend && uv run pytest -q` | 41 passed；一条既有 Starlette/httpx 弃用提示 |
| `cd backend && uv run ruff check app tests` | All checks passed |
| `cd frontend && npm run typecheck` | 通过 |
| `cd frontend && npm test` | 23 passed（含 14 项白板动作/状态/安全边界测试） |
| `cd frontend && npm run build` | 静态生产构建通过 |
| `cd frontend && npm run test:e2e` | 7 passed；独立 data/e2e，3100/8100，单后端 worker |
| `cd backend && uv run python ../scripts/audit_licenses.py` | 清单更新；136 个前端条目、54 个桌面条目、42 个 Python 包 |
| 原 SDK 残留检查 | 前端源码/lockfile 无 tldraw 运行依赖；资源脚本清理生成的 public/tldraw；构建 out/tldraw 不存在 |

## 覆盖

- 批次全量校验：课堂/版本、未知字段/操作、无效作者/来源 ID、NaN/Infinity/越界坐标、文字/动作/点数限制、重复动作/元素 ID、快照容量上限。
- 动作逐步执行，暂停/继续/取消，host 临时 busy 与真实待执行暂停，执行回执、失败暂停、订阅回调异常不影响执行原子性。
- 学生与老师在同一页上编辑；老师不得擦除学生元素；教师擦除可撤销，撤销不重播动作；已执行 ID 不复用；复制返回值不可修改内部状态。
- 刷新后学生笔迹、教师元素及已执行记录恢复；待执行动作恢复为暂停；取消只作用于未执行动作。
- 区域 PNG 实际下载、签名/尺寸检查。观察接口图像像素检查：有学生黑色笔迹，没有教师蓝色板书。观察接口测试桩明确标记为测试，不声称视觉识别成功。
- 旧快照只读提示与 JSON 下载、主动新建后原文保留、模拟 503 保存失败提示和重试、再次刷新恢复。
- 浏览器触摸模拟、取消触摸笔画、整笔擦除/撤销、390px 手机宽度不横向溢出。不是压感笔/平板硬件测试。
- 既有完整课堂流程、PDF、学习记录、语音配置缺失和模拟云端语音回归继续通过。
- 截图人工检查：工具栏可用，师生颜色可区分；修正了演示圈选位置，便签高度依据实际换行数计算。演示题保留一项导数供学生在同一道题中补全。

## 接入边界

使用 [契约](WHITEBOARD_CONTRACT.md) 中的 `onReady` / `onBoardEvent` 和 `BoardController`。本轮没有连接真实 LLM 板书生成、手写识别或语音与板书时序；固定动作、测试桩和模拟语音不构成这些模块的真实供应商正确性证据。

单页 1600 × 1200、Unicode 数学文本、整元素橡皮；无 LaTeX、笔压、多人协作或无限画布。撤销历史仅在当前挂载会话保留；快照与动作记录持久化。浏览器关闭时进行尽力刷新，离开前可通过 `flush()` 明确等待落盘；本分支未重做 Electron 退出协调。旧快照原文保留，不提供旧 tldraw 的完整视觉迁移。
