# 执析宝（LawFlow）部署说明

## 架构

```text
律师浏览器
  → Cloudflare Pages 前端
  → Cloudflare Pages Function /api/parse-bank-statement-stream
  → 已配置的 Gemini 或阿里云百炼模型服务
```

系统不再依赖阿里云 ECS、Nginx、FastAPI、PaddleOCR 或临时 Cloudflare Tunnel。PDF 经 Cloudflare 服务端函数以 Base64 形式直接提交给 Qwen，API Key 不进入浏览器。

## Cloudflare 环境变量

在 Cloudflare Pages 项目的生产环境和预览环境中配置：

- `DASHSCOPE_API_KEY`：百炼 API Key，必须配置为 Secret。
- `DASHSCOPE_BASE_URL`：北京地域业务空间的 OpenAI 兼容地址，例如 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。
- `QWEN_MODEL`：可选，默认 `qwen3.8-flash`。
- `GEMINI_API_KEY`：可选；配置后 PDF 优先走 Gemini 直传解析。
- `GEMINI_MODEL`：可选，指定实际可用的 Gemini 模型名。
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

- 模型：`qwen3.8-flash`。
- 协议：OpenAI 兼容 Chat Completions；不能改用 Responses API 传 PDF。
- 输入：Base64 PDF。
- 应用限制：单文件不超过 75 MB；前端和服务端都会校验。
- 完整性：Qwen 路径执行独立计数和逐页校验；Gemini 路径检查页面覆盖，但因没有独立二次清点，结果统一进入律师人工复核。
- 数据：解析结果和原始 PDF 保存在浏览器 IndexedDB，未实施应用层静态加密；PDF 还会按照所选模型服务的数据处理规则发送至 Gemini 或百炼。
