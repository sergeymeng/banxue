# 手写观察评测记录

日期：2026-10-31。此目录区分流程回归和真实视觉结果。

## 当前证据

- 后端：60 项测试通过，覆盖 PNG 解码、区域/步骤约束、模型结构错误、预算和 timeout、重复提交、确认与丢弃、过期版本、课堂隔离、重启恢复、导出/删除、提示注入数据边界及不写掌握记录。
- 前端：9 项现有单元测试通过，类型检查和生产构建通过。
- 浏览器：6 项 E2E 通过，其中新增 2 项覆盖原图预览、定位覆盖、分母歧义修改、顺序调整、删除误识别、刷新恢复、确认和 demo 禁用识别。手写 E2E 的供应商响应由 Playwright 模拟，不能证明模型准确性。
- 已检查 [核对界面截图](review.png) 的图像/框对齐与编辑布局。
- 本机配置检查：demo；无视觉密钥，无视觉价格。**真实识别：未运行；实际识别错误：尚无观测数据。** [机器可读状态](live-status.json) 与 [差异报告](report.json) 保留 not_run，不填成 0 错误或 100% 准确。

## 小型固定集

6 张 900×420 PNG 位于 `frontend/public/handwriting`。自建字体与笔划合成图，不含真实学生内容，不代表自然手写分布；字体文件不随项目分发。用 `scripts/handwriting/generate_fixtures.py` 在 macOS 重新生成，SHA-256 存入 manifest。

| ID | 检查点 | 特别要求 |
|---|---|---|
| fraction | 竖式分数、分母 2x | 不能漏掉分母变量或误认成减号 |
| exponent | 上标、负指数、多行 | x²、x⁻¹、x⁻² 不能摊平为乘法 |
| negative | 一元负号、括号内减号 | 保留 `-(x-2)` 的负号作用域 |
| parentheses | 括号展开、多行先后 | 图中故意写错的推导必须照录，不能自行解对 |
| mixed | 中文、英文术语、公式 | 保留“先求 derivative”“令”“所以” |
| correction | 涂掉旧结果、旁写替代结果 | 不把涂掉的 3x² 当成保留步骤；允许对阅读分组提出歧义 |

下一轮需在用户许可后增加匿名真实笔迹，包含不同书写者、拍照倾斜/低对比和复杂涂改；当前 6 张只作为开发冒烟集。

## 真实运行与错误记录

配置所选视觉模型、GBP 单价和预算，启动单 worker 后端，在 UI 建立**专用测试课堂**。以下命令按同一服务预算执行 6 次视觉请求（不确认、不调用解题教师），有 20 秒间隔，不重试。运行前可将预算设为可接受的上限。

```bash
# 仓库根目录，后端已有依赖；lesson-id 使用专用测试课堂 ID
backend/.venv/bin/python scripts/handwriting/evaluate.py \
  --collect-live --base-url http://127.0.0.1:8000 \
  --lesson-id TEST_LESSON_ID \
  --output docs/handwriting-evaluation/live-run.json

# 对已保存结果重算字面差异，不调用模型
backend/.venv/bin/python scripts/handwriting/evaluate.py \
  --predictions docs/handwriting-evaluation/live-run.json \
  --output docs/handwriting-evaluation/reviewed-differences.json
```

保留每例的原图指纹、完整 observation、模型来源、HTTP 错误、预期/实测差异及整节用量；每完成一例即落盘。输入脚本不读取或输出密钥。当前脚本针对本地开发 HTTP 服务，桌面随机令牌服务需通过桌面 UI 使用，不能绕过认证。

字面差异只去除空白，不做代数化简，避免掩盖负号/括号错误。等价 LaTeX、分行方式及中文文本与公式的重复表示可能造成差异，必须人工对照原图确认；没有输出时明确记录失败，不能当作正确。

人工错误记录用以下字段附在实际运行结果的对应 case 下：

```json
{
  "confirmed_errors": [
    {
      "step": 1,
      "kind": "denominator_omission",
      "expected": "从标签填写",
      "actual": "从实际模型输出填写",
      "region": {"x": 0.2, "y": 0.3, "width": 0.2, "height": 0.2},
      "review_status": "human_verified",
      "note": "说明漏字、符号、顺序或涂改问题"
    }
  ]
}
```

以上只是记录格式，不是本次发现的错误。应分别汇报表达式转录、步骤顺序、涂改、歧义遗漏和定位问题；小型合成集上的实测比例也不能称为经过校准的准确率。
