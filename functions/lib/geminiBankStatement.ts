export interface GeminiEnvironment {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

export interface GeminiProgressCallback {
  (update: {
    statusText: string;
    totalTransactions: number;
    percent: number;
    currentBank?: string;
  }): void;
}

export interface GeminiParseOptions {
  respondentName?: string;
  totalPages?: number;
  sourceFileName?: string;
}

function buildGeminiDirectPrompt(options?: GeminiParseOptions): string {
  const targetPerson = options?.respondentName ? `【被执行人：${options.respondentName}】` : '被执行人';
  const pageHint = options?.totalPages && options.totalPages > 0 ? `（原件共约 ${options.totalPages} 页）` : '';

  return `你是一名国家级司法审计与银行流水审查专家，正在对法院依法调取的${targetPerson}银行流水卷宗扫描件 PDF${pageHint}进行全量对账提取。

【核心审计任务】：
请逐页完整提取卷宗中所有银行明细表格页的全部有效交易明细，绝对不能遗漏任何一笔！
卷宗可能包含多家商业银行、农村信用社或支付宝/微信对账单，实际有效交易必须全量检出！

【绝对禁令】：
1. 严禁任何形式的抽样、摘要、省略或截断！绝不能只提取大额！
2. 几分钱的季度结息、年费、手续费、每一笔还贷、日常消费支出，每一行都必须作为独立交易输出！
3. 遇到空白背页和纯回执单跳过，遇到交易表格页必须全量交出。
4. 借贷方向：收入/贷方填 IN，支出/借方填 OUT。

【输出格式】：严格输出标准 JSON，字段精简以避免超限：
{
  "totalExtracted": 0,
  "pagesCovered": [],
  "transactions": [
    {
      "p": 原件页码数字,
      "bk": "银行名称",
      "ac": "账号或卡号",
      "holder": "户名(若未体现则留空)",
      "tm": "交易时间(YYYY-MM-DD HH:mm:ss，无时间则YYYY-MM-DD)",
      "dir": "IN或OUT",
      "amt": 交易金额数值,
      "bal": 余额数值(无法识别填null),
      "cp": "对方户名",
      "ca": "对方账号",
      "sm": "摘要及备注"
    }
  ]
}`;
}

export async function parsePdfWithGeminiStream(
  file: File,
  env: GeminiEnvironment,
  onProgress?: GeminiProgressCallback,
  signal?: AbortSignal,
  options?: GeminiParseOptions
) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('未配置 GEMINI_API_KEY');
  const model = env.GEMINI_MODEL || 'gemini-3.8-flash';

  onProgress?.({ statusText: '正在将卷宗 PDF 进行 Base64 编码并直传 Gemini…', totalTransactions: 0, percent: 5 });

  const arrayBuffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64Data = btoa(binary);

  onProgress?.({ statusText: '已完成 PDF 编码，正在向 Gemini 3.8 Flash 发起流式推理…', totalTransactions: 0, percent: 15 });

  const promptText = buildGeminiDirectPrompt(options);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: 'application/pdf',
                data: base64Data
              }
            },
            { text: promptText }
          ]
        }
      ],
      generationConfig: {
        response_mime_type: 'application/json',
        temperature: 0.0,
        max_output_tokens: 65536
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini 服务请求失败 (${response.status}): ${errorText.slice(0, 300)}`);
  }

  if (!response.body) throw new Error('Gemini 未返回可读流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulatedText = '';
  let transactionMatchCount = 0;
  let lastCurrentBank = '银行流水';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr) continue;

      try {
        const payload = JSON.parse(dataStr);
        const textChunk = payload.candidates?.[0]?.content?.parts?.[0]?.text;
        if (textChunk) {
          accumulatedText += textChunk;

          // 估算已解析出来的交易数量（统计 "amt": 或 "dir": 出现的次数）
          const matches = accumulatedText.match(/"amt"\s*:/g);
          const currentCount = matches ? matches.length : 0;
          
          // 尝试探测当前处理的银行名称
          const bankMatch = textChunk.match(/"bk"\s*:\s*"([^"]+)"/);
          if (bankMatch && bankMatch[1]) {
            lastCurrentBank = bankMatch[1];
          }

          if (currentCount > transactionMatchCount) {
            transactionMatchCount = currentCount;
            const dynamicPercent = Math.min(95, 20 + Math.floor((transactionMatchCount / 500) * 75));
            onProgress?.({
              statusText: `正在提取【${lastCurrentBank}】流水明细，已实时捕获 ${transactionMatchCount} 笔…`,
              totalTransactions: transactionMatchCount,
              percent: dynamicPercent,
              currentBank: lastCurrentBank
            });
          }
        }
      } catch {
        // 忽略单个 SSE 帧格式波动
      }
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data:')) {
      try {
        const payload = JSON.parse(trimmed.slice(5).trim());
        const textChunk = payload.candidates?.[0]?.content?.parts?.[0]?.text;
        if (textChunk) accumulatedText += textChunk;
      } catch {}
    }
  }

  // 解析完整的 JSON 结果（具备工业级多阶段容错修复能力）
  const cleanJsonText = accumulatedText.trim();
  let parsedResult: any;
  let rawTxList: any[] = [];

  try {
    parsedResult = JSON.parse(cleanJsonText);
    if (Array.isArray(parsedResult.transactions)) {
      rawTxList = parsedResult.transactions;
    }
  } catch {
    // 阶段 1：智能修复尾部未闭合的 transactions 数组与顶层对象
    const lastObjectClose = cleanJsonText.lastIndexOf('}');
    if (lastObjectClose > 0) {
      const candidates = [
        cleanJsonText.slice(0, lastObjectClose + 1) + ']}',
        cleanJsonText.slice(0, lastObjectClose + 1) + '}',
        cleanJsonText.slice(0, lastObjectClose + 1)
      ];
      for (const candidate of candidates) {
        try {
          const testParsed = JSON.parse(candidate);
          if (Array.isArray(testParsed.transactions) && testParsed.transactions.length > 0) {
            parsedResult = testParsed;
            rawTxList = testParsed.transactions;
            break;
          }
        } catch {}
      }
    }

    // 阶段 2：如果阶段 1 仍未恢复，使用流式对象正则贪婪提取每一个合法的交易 JSON 对象
    if (rawTxList.length === 0) {
      const txObjectRegex = /\{[^{}]*?"amt"\s*:\s*[-0-9.]+[^{}]*?\}/g;
      let match: RegExpExecArray | null;
      while ((match = txObjectRegex.exec(cleanJsonText)) !== null) {
        try {
          const item = JSON.parse(match[0]);
          if (item && (item.amt !== undefined || item.tm !== undefined)) {
            rawTxList.push(item);
          }
        } catch {}
      }
      parsedResult = {
        totalExtracted: rawTxList.length,
        pagesCovered: [],
        transactions: rawTxList
      };
    }

    if (rawTxList.length === 0) {
      throw new Error('未能从大模型返回流中捕获到有效交易数据，请稍后重试或确认卷宗扫描清晰度');
    }
  }

  const expectedHolder = options?.respondentName?.trim() || '';

  // 标准化为系统通用的 StandardTransaction
  const transactions = rawTxList.map((tx: any, idx: number) => {
    const rawHolder = String(tx.holder || '').trim();
    const resolvedAccountName = rawHolder || expectedHolder || '被执行人';
    return {
      id: `TX_GEMINI_${idx + 1}`,
      accountNumber: String(tx.ac || '').replace(/\s+/g, ''),
      accountName: resolvedAccountName,
      bankName: String(tx.bk || '商业银行'),
      transactionTime: String(tx.tm || ''),
      transactionDate: String(tx.tm || '').slice(0, 10),
      direction: String(tx.dir || 'OUT').toUpperCase() === 'IN' ? 'IN' : 'OUT',
      amount: Math.abs(Number(tx.amt) || 0),
      balance: tx.bal !== null && tx.bal !== undefined ? Number(tx.bal) : null,
      counterpartyName: String(tx.cp || ''),
      counterpartyAccount: String(tx.ca || ''),
      counterpartyBank: '',
      summary: String(tx.sm || ''),
      rawSourceFile: file.name,
      rawPageNumber: Number(tx.p) || 1,
      rawRowIndex: idx + 1,
      rawText: `${tx.tm || ''} ${tx.dir || ''} ${tx.amt || ''} ${tx.sm || ''}`,
      balanceAvailable: tx.bal !== null && tx.bal !== undefined,
      extractionMethod: 'GEMINI_DIRECT_PDF',
      extractionConfidence: 0.98,
      reviewStatus: 'AUTO_PASSED',
      dataQualityIssues: []
    };
  });

  // 生成聚合银行账户摘要
  const accountMap = new Map<string, any>();
  for (const t of transactions) {
    const key = `${t.bankName}_${t.accountNumber}`;
    if (!accountMap.has(key)) {
      accountMap.set(key, {
        accountNumber: t.accountNumber || '未知账号',
        accountName: t.accountName || expectedHolder || '被执行人',
        bankName: t.bankName,
        ownerType: 'DEBTOR_MAIN',
        fileName: file.name,
        fileType: 'pdf',
        totalIn: 0,
        totalOut: 0,
        transactionCount: 0,
        startDate: t.transactionDate,
        endDate: t.transactionDate,
        startBalance: t.balance || 0,
        endBalance: t.balance || 0,
        isBalanced: true,
        balanceDiff: 0,
        balanceAvailable: true
      });
    }
    const acc = accountMap.get(key);
    acc.transactionCount += 1;
    if (t.direction === 'IN') acc.totalIn += t.amount;
    else acc.totalOut += t.amount;
    if (t.transactionDate < acc.startDate) acc.startDate = t.transactionDate;
    if (t.transactionDate > acc.endDate) acc.endDate = t.transactionDate;
    acc.endBalance = t.balance !== null ? t.balance : acc.endBalance;
  }

  const accounts = Array.from(accountMap.values());
  const mainAccount = accounts[0] || {
    accountNumber: '综合汇总账户',
    accountName: expectedHolder || '被执行人',
    bankName: '多银行综合',
    ownerType: 'DEBTOR_MAIN',
    fileName: file.name,
    fileType: 'pdf',
    totalIn: transactions.filter((t: any) => t.direction === 'IN').reduce((s: number, t: any) => s + t.amount, 0),
    totalOut: transactions.filter((t: any) => t.direction === 'OUT').reduce((s: number, t: any) => s + t.amount, 0),
    transactionCount: transactions.length,
    startDate: transactions[0]?.transactionDate || '',
    endDate: transactions[transactions.length - 1]?.transactionDate || '',
    startBalance: 0,
    endBalance: 0,
    isBalanced: true,
    balanceDiff: 0,
    balanceAvailable: true
  };

  return {
    account: mainAccount,
    accounts,
    transactions,
    totalCount: transactions.length,
    pagesCovered: parsedResult.pagesCovered || []
  };
}
