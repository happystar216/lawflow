# 线上黑盒自动化调试

该服务运行在本机，但通过真实 Chrome 操作指定的 LawFlow 线上地址。PDF、Excel 和 CSV 都从页面原有上传入口进入，因此识别、保存、规范化、平账和资金分析与真实用户流程一致。

## 启动

```bash
npm run debug:online
```

默认监听 `http://127.0.0.1:4318`，默认访问 `https://lawtool.cocoaiagent.com/`。调试产物保存在 `tmp/online-debug-runs/`，默认 24 小时后自动删除，且不会进入 Git。

推荐设置本地令牌：

```bash
LAWFLOW_DEBUG_TOKEN="仅本机使用的随机字符串" npm run debug:online
```

如线上还有站点级口令门禁，可设置 `LAWFLOW_SITE_PASSWORD`。如 Chrome 不在默认位置，可设置 `LAWFLOW_CHROME_PATH`。

## 提交文件

```bash
curl -H "Authorization: Bearer $LAWFLOW_DEBUG_TOKEN" \
  -F 'respondentName=胡艳红' \
  -F 'file=@/绝对路径/银行流水.pdf' \
  http://127.0.0.1:4318/debug/runs
```

同一请求可以重复传入 `file`，用于验证多个文件的账户交叉和内部转账：

```bash
curl -H "Authorization: Bearer $LAWFLOW_DEBUG_TOKEN" \
  -F 'file=@/绝对路径/第一份.xlsx' \
  -F 'file=@/绝对路径/第二份.pdf' \
  http://127.0.0.1:4318/debug/runs
```

指定 Cloudflare 预览或本地网址时增加 `target` 字段。出于安全考虑，默认只允许正式域名、localhost 和 127.0.0.1；其他域名需加入 `LAWFLOW_DEBUG_ALLOWED_HOSTS`。

## 查询

```bash
curl -H "Authorization: Bearer $LAWFLOW_DEBUG_TOKEN" \
  http://127.0.0.1:4318/debug/runs/RUN_ID
```

任务完成后读取完整结构化结果：

```bash
curl -H "Authorization: Bearer $LAWFLOW_DEBUG_TOKEN" \
  http://127.0.0.1:4318/debug/runs/RUN_ID/result
```

结果包含账户、流水、人工核对项、账户平账报告、资金分析报告、页面导入状态、浏览器报错、失败请求和最终页面截图。

删除某次运行及其本地文件：

```bash
curl -X DELETE -H "Authorization: Bearer $LAWFLOW_DEBUG_TOKEN" \
  http://127.0.0.1:4318/debug/runs/RUN_ID
```

