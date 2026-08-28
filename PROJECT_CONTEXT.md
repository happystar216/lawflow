# 执析宝 (LawFlow) 完整项目交接与开发上下文手册 (PROJECT_CONTEXT)

> **💡 本文档专为 Codex / 后续 AI 开发助手及接手工程师编写**。  
> 包含执析宝（LawFlow）的**业务背景、系统架构、代码索引、6大核心业务流程、算法规则引擎、部署资产与后续可扩展方向**，阅读本文档即可直接上手开发与修改。

---

## 1. 项目定位与业务背景 (Product Overview)

- **产品名称**：执析宝 (LawFlow)
- **目标用户**：执行律师、法官、法务调查人员、破产管理人
- **核心痛点**：
  法院通过《律师调查令》调取的银行流水往往是**上百页横版打印、竖向扫描的纸质扫描件卷宗**，上面布满法院红色公章、水印，且存在多账户交叉转账。律师人工逐笔对账极其耗时耗力，且容易漏掉被执行人“借道隐匿财产、虚假财产报告、借款代偿”等关键证据。
- **产品核心价值**：
  1. **多模态秒级解析**：支持 Excel/CSV 及 100+ 页 PDF 扫描件，通过多模态 AI 自动穿透印章与旋转自适应，秒级提取全量流水；
  2. **严格会计平账**：自动校验 $\text{期初} + \sum\text{收入} - \sum\text{支出} = \text{期末}$，确保司法证据链严丝合缝；
  3. **四大司法穿透规则**：自动识别大额资金异动、疑似隐匿资产、代持账户净额轧差、虚假财产申报线索；
  4. **全自动报告交付**：一键生成《执行财产调查审计报告》与《律师调查令申请线索清单》，支持导出标准 Excel 与 Word。

---

## 2. 系统全景架构 (Architecture & Tech Stack)

```mermaid
graph TD
    User["👤 律师 / 用户浏览器"] -->|HTTPS (TLS 1.3)| CF_Pages["🌐 前端: Cloudflare Pages (React 18 + TS + Vite + Tailwind)"]
    CF_Pages -->|同源代理 /api/parse-bank-statement-stream| CF_Edge["⚡ Cloudflare Edge Functions"]
    CF_Edge -->|无损 SSE 流式反代| Nginx["🛡️ 阿里云 ECS Nginx (Port 80/443/8000)"]
    Nginx -->|零缓冲| FastAPI["🚀 FastAPI 异步服务 (/opt/lawflow-ocr/app.py)"]
    FastAPI -->|pypdfium2 内存切片| ThreadPool["⚡ 8 路高并发线程池"]
    ThreadPool -->|OpenAI 兼容协议| Qwen["🤖 通义千问 Qwen3.8-Flash 专属企业多模态引擎"]
```

### 2.1 技术栈清单
- **前端框架**：`React 18` + `TypeScript` + `Vite` + `TailwindCSS`
- **图标与组件**：`lucide-react`
- **本地存储**：`IndexedDB` (基于原生 IDB 封装) + `localStorage` 双重实时自动保存恢复
- **后端框架**：`FastAPI` + `Uvicorn` + `Python 3.8`
- **PDF/图像处理**：`pypdfium2`（高性能 C++ 渲染）、`pdfplumber`、`Pillow`、`OpenCV-Python-Headless`
- **AI 视觉引擎**：阿里云百炼 `Qwen3.8-Flash` 专属企业端点
- **云基础设施**：阿里云 ECS Linux (`114.55.73.208`) + Cloudflare Pages

---

## 3. 核心业务工作流 (6-Step Legal Workflow)

系统采用向导式 6 步法，各步骤功能与组件对应如下：

```
Step 0: 案件基本信息录入 ──► Step 1: 证据文件上传解析 ──► Step 2: 账户主体归属确认
                                                                      │
Step 5: 律师人工核验定性 ◄── Step 4: 智能计算与穿透分析 ◄── Step 3: 前置特征标注设置
        │
        ▼
Step 6: 报告与证据一键导出
```

### Step 0: 案件立案与时间轴 (`src/components/Step0CaseSetup.tsx`)
- 录入案号、执行法院、申请执行人、被执行人、执行标的额；
- 配置关键司法时间节点：**借款发生日**、**立案执行日**、**财产申报截止日**、**查封冻结日**；
- 录入被执行人已向法院申报的财产清单（用于后续对比是否构成“虚假财产报告”）。

### Step 1: 证据上传与流式解析 (`src/components/Step1Upload.tsx`)
- 支持拖拽上传各大银行导出的 Excel、CSV、PDF 扫描件；
- **真实 SSE 逐页流式进度**：实时显示 `正在识别第 X / 128 页 · 已提取有效明细 N 笔`；
- **交互控制**：提供 **「⏹ 停止解析」** 按钮（基于 `AbortController` 毫秒级中断）；
- **自适应修复**：自动识别并跳过空白背面，自适应纠正 270° 旋转横版流水。

### Step 2: 账户主体归属确认 (`src/components/Step2Verify.tsx`)
- 确认各银行账户与当事人的主体关系：
  - `DEBTOR_MAIN`：被执行人主账户（用于主资金链平账）
  - `DEBTOR_CONTROLLED`：被执行人实际控制/名义代持账户
  - `SPOUSE`：配偶账户
  - `RELATED_COMPANY`：关联企业账户
  - `SUSPICIOUS_THIRD_PARTY`：可疑第三方账户
- 展示各账户期初期末余额、进出总额、平账一致性。

### Step 3: 前置特征标注 (`src/components/Step3PreAnnotation.tsx`)
- 设置大额交易阈值（如单笔 $\ge$ 5 万元）；
- 设置敏感对手方关注名单、高频交易识别窗口、夜间异常交易筛选规则。

### Step 4: 智能计算与穿透分析 (`src/components/Step4Compute.tsx` & `src/engine/`)
- 运行 **LawFlow 法务规则引擎**，自动执行：
  1. **资金池合并轧差**：被执行人名下多个账户之间的“左手倒右手”内部互转自动对冲，还原真实对外净流入流出；
  2. **四大核心司法规则计算**：
     - **规则 1（大额异常隐匿）**：在执行立案或冻结前后，大额资金突击转出或取现；
     - **规则 2（疑似应收债权/外部借款）**：大额资金转给第三方，且摘要注明“借款/往来款/投资”，自动生成追索线索；
     - **规则 3（代偿代还核查）**：摘要注明“还款/代还”，自动列为律师人工核验任务；
     - **规则 4（虚假财产报告比对）**：若被执行人向法院申报“无财产”，但流水显示申报截止日账户仍有大额余额或隐藏大额收益，根据《民诉法》第 248 条自动生成拘留/罚款惩戒证据链。

### Step 5: 后置人工核验 (`src/components/Step5PostAnnotation.tsx`)
- 律师对系统初筛出的可疑线索进行一键确认、排除或补充律师意见；
- 生成待申请调取凭证清单。

### Step 6: 报告与证据导出 (`src/components/Step6Export.tsx`)
- 一键导出标准 **Excel 结构化流水台账**；
- 一键生成 **Word / Markdown 格式的《执行财产调查与证据分析报告》**；
- 一键生成 **《协助执行通知书 / 律师调查令申请书》线索附件**。

---

## 4. 代码目录结构与核心文件索引 (Codebase Map)

```
law-tools/
├── DEPLOYMENT.md                     # 生产环境运维手册 (IP、服务配置、端口)
├── PROJECT_CONTEXT.md                # 本文档 (项目全局开发交接手册)
├── package.json                      # 前端依赖配置
├── vite.config.ts                    # Vite 打包配置
├── functions/                        # Cloudflare Pages Functions (Edge 代理)
│   └── api/
│       └── parse-bank-statement-stream.ts # 生产端同源 SSE 流式代理
├── src/
│   ├── App.tsx                       # 顶层应用入口，状态驱动与自动持久化
│   ├── types/                        # 核心 TypeScript 类型定义
│   │   ├── case.ts                   # 案件元数据与时间轴类型
│   │   ├── transaction.ts            # 银行流水交易结构体定义
│   │   └── evidence.ts               # 证据分析报告与规则线索类型
│   ├── engine/                       # 司法分析与对账核心算法引擎
│   │   ├── engine.ts                 # LawFlowEngine 主类 (平账、净额、四大规则)
│   │   ├── internalNetting.ts        # 账户内部互转轧差对冲算法
│   │   └── balanceAuditor.ts         # 会计平账一致性审计器
│   ├── parsers/                      # 流水解析器
│   │   ├── excelParser.ts            # 电子版 Excel / CSV 解析
│   │   └── aliyunEcsOcr.ts           # 前端流式 SSE 读取器 (支持 AbortController)
│   ├── store/                        # 状态持久化
│   │   ├── caseStore.ts              # IndexedDB 案件库 (多案件自动存储)
│   │   └── authStore.ts              # 用户鉴权与会话管理
│   └── components/                   # UI 组件库
│       ├── Header.tsx                # 顶部导航栏 (含版本徽章与案件切换)
│       ├── WorkflowStepper.tsx       # 6 步流程式进度导航器
│       ├── Step0CaseSetup.tsx        # Step 0: 案件基本信息
│       ├── Step1Upload.tsx           # Step 1: 证据文件上传与实时进度
│       ├── Step2Verify.tsx           # Step 2: 账户主体归属确认
│       ├── Step3PreAnnotation.tsx    # Step 3: 前置特征标注
│       ├── Step4Compute.tsx          # Step 4: 智能计算与对账结果
│       ├── Step5PostAnnotation.tsx   # Step 5: 律师核验与定性
│       ├── Step6Export.tsx           # Step 6: 导出报告与证据
│       └── CaseManagerModal.tsx      # 案件管理弹窗 (切换/新建/删除案件)
└── tests/                            # 自动化单元测试
    └── rules.test.ts                 # 7 项核心平账与穿透规则单测 (100% 通过)
```

---

## 5. 生产环境与服务器资产 (Live Environment)

- **线上生产访问地址**：👉 **[https://lawflow-66f.pages.dev](https://lawflow-66f.pages.dev)**
- **GitHub 代码仓库**：👉 **[https://github.com/happystar216/lawflow](https://github.com/happystar216/lawflow)**
- **阿里云 ECS 服务器**：
  - IP：`114.55.73.208`
  - 操作系统：Alibaba Cloud Linux 3.2104 U13.3 (2 vCPU / 2GB RAM + 4GB SWAP)
  - 守护服务：`/etc/systemd/system/lawflow-ocr.service`
  - Nginx 配置：`/etc/nginx/conf.d/lawflow.conf`
  - 后端程序：`/opt/lawflow-ocr/app.py`
- **通义千问 Qwen3.8-Flash 接口**：
  - Base URL：`https://ws-ogk13rh629mh8iti.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`
  - Model：`qwen3.8-flash`
  - Concurrency：8 路多线程并发切片流式处理

---

## 6. 本地开发与发布标准命令 (Developer Cheatsheet)

```bash
# 1. 运行自动化单元测试 (包含 7 项金融平账与四大司法穿透规则)
npm test

# 2. 本地启动开发服务器
npm run dev

# 3. 生产打包构建
npm run build

# 4. 发布部署到 Cloudflare Pages 生产环境
npx wrangler pages deploy dist --project-name=lawflow --commit-dirty=true

# 5. 代码提交到 GitHub
git add -A && git commit -m "feat: 你的修改说明" && git push origin main
```

---

## 7. 后续建议开发方向 (Roadmap for Codex)

若您继续对项目进行功能增强，推荐优先考虑以下方向：

1. **多银行模板智能适配库**：
   在 `src/parsers/` 中继续扩充中国各大商业银行（如招商银行、中国银行、农业银行、交通银行、民生银行等）的专属对账字段映射表。
2. **知识图谱关系可视化（D3.js / ECharts）**：
   在 `Step4Compute.tsx` 中增加资金流向知识图谱可视化（被执行人 $\to$ 关联公司 $\to$ 可疑第三方 $\to$ 购房/理财资金流动的拓扑网络图）。
3. **批量案件一键归档与打包下载**：
   在 `Step6Export.tsx` 中增加将所有 Excel 凭证、Word 审计报告、证据切片一键打包压缩为 `.zip` 下载的功能。
