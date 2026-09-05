# 执析宝（LawFlow）部署说明

## 架构

```text
律师浏览器
  → Cloudflare Pages 前端
  → Cloudflare Pages Function /api/parse-bank-statement-stream
  → 阿里云百炼北京地域 Chat Completions
  → qwen3.8-flash 原生 PDF 理解
```

系统不再依赖阿里云 ECS、Nginx、FastAPI、PaddleOCR 或临时 Cloudflare Tunnel。PDF 经 Cloudflare 服务端函数以 Base64 形式直接提交给 Qwen，API Key 不进入浏览器。

## Cloudflare 环境变量

在 Cloudflare Pages 项目的生产环境和预览环境中配置：

- `DASHSCOPE_API_KEY`：百炼 API Key，必须配置为 Secret。
- `DASHSCOPE_BASE_URL`：北京地域业务空间的 OpenAI 兼容地址，例如 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。
- `QWEN_MODEL`：可选，默认 `qwen3.8-flash`。

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
- 官方限制：单文件不超过 150 MB、最多 500 页。
- 完整性：模型返回逐页交易数；逐页合计与交易数组长度不一致时，本次解析失败并要求重试，避免少笔结果静默入库。
- 数据：解析结果保存在浏览器 IndexedDB；原始 PDF 不在本项目服务器持久化，但会按照百炼服务的数据处理规则发送至模型端。
