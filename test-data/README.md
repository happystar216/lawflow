# Real PDF regression datasets

Real-case datasets are generated under `test-data/private/` and are intentionally ignored by Git because they contain personal and banking information.

Each dataset contains:

- `manifest.json`: immutable source fingerprint and build settings.
- `pages/`: stable page images used for visual comparison.
- `raw-pages/`: one resumable recognition result per source page.
- `benchmark.json`: consolidated accounts and transactions.
- `review-queue.json`: page-level discrepancies that still require source review.
- `summary.json`: compact counts suitable for automated regression checks.

Build or resume the Hu Yanhong dataset with:

```bash
npx tsx scripts/buildRealPdfBenchmark.ts \
  "/Users/happy/Downloads/胡艳红流水合并.pdf" \
  "test-data/private/hu-yanhong"
```

This generated dataset is a benchmark draft until every queued page has been checked against its page image. Do not treat an unreviewed machine extraction as legal ground truth.

---

## 5-Page Synthetic Benchmark PDF (`test-data/benchmark_5pages.pdf`)

用于模拟线上生产环境高发异常场景的 5 页合成基准流水文件，可通过 `python3 scripts/generate_benchmark_pdf.py` 重新生成。

### 覆盖的线上核心异常场景矩阵：

| 页码 | 页面特征 | 模拟的线上真实问题 | 系统的预期处理逻辑 |
| :--- | :--- | :--- | :--- |
| **P1** | 标准完整表头与时间序列流水 | 正常 baseline 测试 | 正确解析户名（赵立明）、账号（6217000100288391028）、开户行、时间、收支方向与期初期末余额，校验 $\text{期初}+\text{入}-\text{出}=\text{期末}$ 正常平账。 |
| **P2** | **红色半透明法院司法印章遮挡** + 跨行长摘要 + 终身寿险大额扣费 + ATM大额夜间提现（无对手方） | 印章遮挡文字、跨行折行导致的行错位、特殊关键资产线索识别 | 视觉模型穿透红色印章提取被遮挡的金额与对手方；长摘要合并为一条；自动捕获“保险资产”与“大额取现”作为司法线索。 |
| **P3** | **续页无顶栏抬头** + **人为余额跳跃断层** | 跨页续表丢失账户信息、打印或扫描遗漏行导致的平账断裂 | 自动继承前页账户主体；在 Step 2 触发 `BALANCE_DISCONTINUITY`（余额不衔接）红色警告，要求律师原件对照复核。 |
| **P4** | **双面复印空白背面**（仅含“【本页无交易正文·复印留白备查页】”微小水印） | 常见双面扫描导致 50% 空白页产生幻觉生成假交易、报错中断 | 独立清点 Pass 识别 `transactionCount: 0`，标记为 `BLANK_PAGE`，不虚构任何假交易，不中断整体流程。 |
| **P5** | **多银行/多账户同一卷宗切换**（光大二类卡 6226721003232085） + **两卡内部转账** + 销户结清 | 同一案卷内混合多张卡、同一人多账户之间“左手倒右手”资金对冲 | 自动识别抬头切换并拆分为独立的 Account Tab；在 Step 4 运行内部轧差（Internal Netting）规则，将两卡之间的互转自动对冲。 |
