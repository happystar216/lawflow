# 执析宝 (LawFlow) 生产环境全套部署与运维手册

本文档记录了 **执析宝 (LawFlow) 银行流水智能穿透与取证系统** 的完整生产环境架构、服务器配置、AI 接口参数、日常运维及一键发布流程。

---

## 1. 系统架构全景图 (Architecture Overview)

```mermaid
graph TD
    Client["👤 执行律师 / 用户浏览器 (Chrome / Safari / Edge)"] -->|HTTPS 访问| CF_Pages["🌐 前端托管: Cloudflare Pages (https://lawflow-66f.pages.dev)"]
    CF_Pages -->|同源流式网关 /api/parse-bank-statement-stream| CF_Edge["⚡ Cloudflare Edge Functions (TLS 1.3 端到端加密)"]
    CF_Edge -->|反向代理| Nginx["🛡️ 阿里云 ECS Nginx 网关 (Port 80 / 443 / 8000)"]
    Nginx -->|零缓冲 SSE 透传| FastAPI["🚀 FastAPI 高性能后端 (/opt/lawflow-ocr/app.py)"]
    FastAPI -->|pypdfium2 内存切片 (0.2s)| Concurrency["⚡ 8 路多线程并发池 (ThreadPoolExecutor)"]
    Concurrency -->|OpenAI 兼容协议| Qwen["🤖 阿里云通义千问 Qwen3.8-Flash 专属企业视觉引擎"]
```

---

## 2. 核心资产与基础设施信息 (Infrastructure & Credentials)

### 2.1 阿里云 ECS 算力服务器
- **公网 IP**：`114.55.73.208`
- **操作系统**：Alibaba Cloud Linux 3.2104 U13.3 (OpenAnolis 64位)
- **硬件配置**：2 vCPU / 2GB 内存 / 40GB SSD
- **虚拟内存 (SWAP)**：已配置 **4GB SWAP 交换分区**（`/swapfile`），彻底杜绝多页 PDF 解析时的 OOM（内存溢出）风险
- **开放安全组端口**：
  - `80` (HTTP)
  - `443` (HTTPS)
  - `8000` (FastAPI 内部业务端口)
  - `22` (SSH 远程管理端口)

### 2.2 通义千问 Qwen3.8-Flash 专属端点
- **Base URL**：`https://ws-ogk13rh629mh8iti.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
- **Model Name**：`qwen3.8-flash`
- **协议**：OpenAI 兼容协议（支持多模态 `image_url` 与高并发流式输出）

### 2.3 前端生产发布环境
- **生产访问地址**：👉 [https://lawflow-66f.pages.dev](https://lawflow-66f.pages.dev)
- **GitHub 代码仓库**：👉 [https://github.com/happystar216/lawflow](https://github.com/happystar216/lawflow)
- **托管平台**：Cloudflare Pages

---

## 3. 服务器后端配置详情 (Backend Configuration)

### 3.1 后端服务部署路径
- **主程序路径**：`/opt/lawflow-ocr/app.py`
- **Python 独立虚拟环境**：`/opt/lawflow-ocr/venv/`
- **关键依赖包**：`fastapi`, `uvicorn`, `openai`, `pypdfium2`, `pillow`, `opencv-python-headless`, `numpy`, `pdfplumber`

### 3.2 Systemd 守护进程配置 (`/etc/systemd/system/lawflow-ocr.service`)
```ini
[Unit]
Description=LawFlow Qwen3.8-Flash Ultra Engine Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/lawflow-ocr
ExecStart=/opt/lawflow-ocr/venv/bin/uvicorn app:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### 3.3 Nginx 反向代理配置 (`/etc/nginx/conf.d/lawflow.conf`)
```nginx
server {
    listen 80;
    listen 443 ssl http2;
    server_name _;

    ssl_certificate /etc/nginx/lawflow.crt;
    ssl_certificate_key /etc/nginx/lawflow.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 200M;
    client_body_timeout 600s;

    # 关闭 Nginx 缓冲，确保 SSE 逐页流式进度秒级直达浏览器
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        chunked_transfer_encoding off;
    }
}
```

---

## 4. 前端构建与一键发布流程 (Frontend Deployment)

项目根目录下已配置好自动化构建发布脚本。

### 4.1 常用发布命令

```bash
# 1. 运行底层 7 项金融平账与穿透规则自动化测试
npm test

# 2. 编译打包生产静态资源
npm run build

# 3. 部署发布到 Cloudflare Pages 生产网关
npx wrangler pages deploy dist --project-name=lawflow --commit-dirty=true

# 4. 同步代码到 GitHub
git add -A
git commit -m "feat: 更新业务功能"
git push origin main
```

---

## 5. 常用运维与故障排查速查表 (Ops Cheatsheet)

### 5.1 服务器状态检查
```bash
# 检查后端 Python API 服务运行状态
systemctl status lawflow-ocr

# 查看实时运行与大模型调用日志 (实时滚动查看)
journalctl -u lawflow-ocr -f -n 50

# 检查 Nginx 代理状态
systemctl status nginx
```

### 5.2 服务重启与重载
```bash
# 重启后端解析引擎
systemctl restart lawflow-ocr

# 重启 Nginx
systemctl restart nginx
```

### 5.3 健康检查验证
```bash
# 本地端口健康检查 (应返回 HTTP 200 及 {"status":"ok", ...})
curl http://127.0.0.1:8000/health

# 外网 Nginx HTTPS 健康检查
curl -k https://127.0.0.1/health
```

### 5.4 如何更换大模型 API Key 或切换模型？
1. 编辑服务器上的 `/opt/lawflow-ocr/app.py`：
   ```bash
   vim /opt/lawflow-ocr/app.py
   ```
2. 修改开头的配置常量：
   ```python
   QWEN_API_KEY = "您的新API_KEY"
   QWEN_BASE_URL = "您的新网关地址"
   QWEN_MODEL = "qwen3.8-flash"  # 或其他模型
   ```
3. 保存后执行热重启生效：
   ```bash
   systemctl restart lawflow-ocr
   ```

---

## 6. 数据安全与隐私保障 (Data Privacy)

1. **零落盘原则**：上传的 PDF 流水文件全部在内存中进行切片解析，识别提取完即刻释放，服务器磁盘不持久化存储任何当事人的银行流水明细文件。
2. **端到端加密**：全链路采用 TLS 1.3 传输加密，杜绝中间人嗅探。
3. **本地状态持久化**：案件解析结果存储在用户本地浏览器的 `localStorage` 与 `IndexedDB` 中，刷新页面或重新打开即可自动恢复。
