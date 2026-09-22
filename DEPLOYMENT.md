# 执析宝（LawFlow）部署说明

## 架构

```text
律师浏览器
  → Cloudflare Pages 前端
  → MinerU 精准解析 API（PDF 转逐页文字和 HTML 表格）
  → Cloudflare Pages Function /api/normalize-mineru-result
  → 已配置的阿里云百炼或 Gemini 模型服务（业务字段整理）
```

系统不再依赖阿里云 ECS、Nginx、FastAPI、PaddleOCR 或临时 Cloudflare Tunnel。原 PDF 只提交给 MinerU；大模型接收的是 MinerU 已提取的逐页文字、表格和带固定行号的规则草稿，服务密钥均不进入浏览器。

## Cloudflare 环境变量

在 Cloudflare Pages 项目的生产环境和预览环境中配置：

- `DASHSCOPE_API_KEY`：百炼 API Key，必须配置为 Secret。
- `DASHSCOPE_BASE_URL`：北京地域业务空间的 OpenAI 兼容地址，例如 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。
- `QWEN_MODEL`：可选，默认 `qwen3.8-flash`。
- `GEMINI_API_KEY`：可选；百炼整理失败或未配置时，可作为 MinerU 结构化结果整理的备用模型服务。
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

发布前确认 Cloudflare 环境变量已经配置。若缺少密钥或北京地域 Base URL，上传页会返回明确的配置错误，不会退回旧 OCR 链路。

## PDF 解析约束

- 模型：默认 `qwen3.8-flash`，可由 `QWEN_MODEL` 调整。
- 协议：OpenAI 兼容 Chat Completions；模型输入为 MinerU 结构化文字和 HTML 表格，不再直接传 PDF。
- 输入：MinerU 逐页 JSON/HTML 表格及程序生成的逐行草稿。
- 应用限制：单文件不超过 75 MB；前端和服务端都会校验。
- MinerU 直读：原 PDF 通过官方精准解析接口异步上传；应用保守地按单任务 200 页处理更长文件，自动连续切段并恢复原页码。当前试验路线不再先做页面分类或银行分档，而是把 MinerU 的表格结果分批交给大模型整理；程序用固定行号、页码和规则草稿防止大模型漏行，并在整理失败时明确报错。
- 完整性：每个交易草稿都有不可变 sourceKey；模型必须逐项返回。漏返、重复或新增的结果不会覆盖原始行，并会转成人工核对提示。
- 数据：解析结果和原始 PDF 保存在浏览器 IndexedDB，未实施应用层静态加密；原 PDF 按 MinerU 的数据处理规则发送，提取后的结构化文字和表格按所选模型服务的数据处理规则发送。
