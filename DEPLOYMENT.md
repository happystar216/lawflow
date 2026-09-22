# 执析宝（LawFlow）部署说明

## 架构

```text
律师浏览器
  → Cloudflare Pages 前端
  → MinerU 精准解析 API（PDF 转逐页文字和 HTML 表格）
  → Cloudflare Pages Function /api/normalize-mineru-result
  → Gemini 模型服务（业务字段整理）
```

系统不再依赖阿里云 ECS、Nginx、FastAPI、PaddleOCR 或临时 Cloudflare Tunnel。原 PDF 只提交给 MinerU；MinerU 的整份逐页文字和 HTML 表格随后一次性交给大模型，大模型直接返回最终账户、流水和逐页完整性检查。服务密钥均不进入浏览器。

## Cloudflare 环境变量

在 Cloudflare Pages 项目的生产环境和预览环境中配置：

- `GEMINI_API_KEY`：Gemini API Key，当前 PDF 结构化整理必需，必须配置为 Secret。
- `GEMINI_MODEL`：可选，指定实际可用的 Gemini 模型名。
- `MINERU_API_TOKEN`：当前 PDF 主识别路线必需；在 MinerU API 管理页面创建。PDF 会直接提交 MinerU，再由已配置的大模型依据逐页 JSON/HTML 表格整理银行、账户和流水字段。
- `LAWFLOW_ALLOWED_ORIGIN`：生产站点的唯一允许来源，例如 `https://lawflow.example.com`。
- `LAWFLOW_REQUIRE_ACCESS`：生产环境建议设为 `true`，并先为 Pages 项目配置 Cloudflare Access 策略。开启后，没有经过 Access 的解析请求会被拒绝。

浏览器中的本地用户配置只用于同一设备上的资料分区，不是服务器身份认证。公开部署时必须启用 Cloudflare Access，并在 Cloudflare 侧配置速率限制和请求额度，防止模型密钥被匿名消耗。

本地调试时将 [.dev.vars.example](./.dev.vars.example) 复制为 `.dev.vars` 并填写真实值；`.dev.vars` 已被 Git 忽略。

## 本地验证

```bash
npm test
npm run build
npx wrangler pages dev dist
```

本地 Vite 开发服务器不执行 Pages Functions。验证真实 PDF 上传时，应使用 `wrangler pages dev dist`。

## 发布

```bash
npm run deploy
```

发布前确认 Cloudflare 环境变量已经配置。若缺少 Gemini 或 MinerU 密钥，上传页会返回明确的配置错误，不会退回旧 OCR 链路。

## PDF 解析约束

- 模型：默认 `gemini-3.8-flash`，可由 `GEMINI_MODEL` 调整。
- 协议：Gemini GenerateContent；模型输入为 MinerU 结构化文字和 HTML 表格，不再直接传 PDF。
- 输入：整份 MinerU 逐页文字和 HTML 表格；前端不预先生成规则流水，也不把结果拆成多个模型批次。
- 应用限制：单文件不超过 75 MB；前端和服务端都会校验。
- MinerU 直读：原 PDF 通过官方精准解析接口异步上传；超过 MinerU 单任务 200 页限制时，仅在传输层连续切段并恢复原页码。合并后的完整 MinerU 结果只调用一次大模型，不做页面分类、银行分档或模型批处理。
- 完整性：提示词要求模型为原文件每一页返回 pageChecks，并保证逐页笔数之和等于最终流水数；MinerU 表格疑似截断或跨列异常时必须明确转成人工核对提示，不能静默丢行。
- 数据：解析结果和原始 PDF 保存在浏览器 IndexedDB，未实施应用层静态加密；原 PDF 按 MinerU 的数据处理规则发送，提取后的结构化文字和表格按所选模型服务的数据处理规则发送。
