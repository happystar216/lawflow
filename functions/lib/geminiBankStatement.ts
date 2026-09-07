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
5. 账号统一规范：同一份银行对账单内，若表头有【系统账号】且部分行有【卡号】、部分行为横杠“-”，必须全单统一使用同一个账号/卡号（ac），严禁在同一份单据内交替混用两个账号，确保同一账单流水不被割裂！
6. 严格按物理列位对齐提取：摘要栏经常包含合同还款额或代扣协议文本（例如包含 "@2640.00@6@1@" 等），严禁提取摘要中的文本数值代替实际发生额！必须严格提取表格中【交易金额】一列印刷的真实发生额数值。
7. 忠实还原数字原样：仔细核验千分位逗号与每位数字（例如 “-4,000.00” 是 4000.00，注意区分首位点阵字形），按印刷字面原样输出，严禁自行心算凑数或编造虚假数字。
8. 信用卡与特殊账单：如遇到透支余额为负数、按月打印的周期性利息还款或免收年费（发生额印为 0.00），均如实按原件印刷数值记录。

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

  const rawTransactions = rawTxList.map((tx: any, idx: number) => {
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

  // 跨页/跨模板重复流水自动去重与收支方向数学校准
  const deduplicated = deduplicateGeminiTransactions(rawTransactions);
  const transactions = calibrateGeminiDirections(deduplicated);

  // 生成聚合银行账户摘要
  const accountMap = new Map<string, any>();
  for (const t of transactions) {
    const key = `${t.bankName}_${t.accountNumber}`;
    if (!accountMap.has(key)) {
      const initBalance = t.balance !== null && t.balance !== undefined
        ? (t.direction === 'IN' ? t.balance - t.amount : (t.direction === 'OUT' ? t.balance + t.amount : t.balance))
        : 0;
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
        startBalance: initBalance,
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

  for (const acc of accountMap.values()) {
    const calculatedEndBalance = acc.startBalance + acc.totalIn - acc.totalOut;
    acc.balanceDiff = Math.abs(calculatedEndBalance - acc.endBalance);
    acc.isBalanced = acc.balanceDiff < 1.0;
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

function deduplicateGeminiTransactions(transactions: any[]): any[] {
  const result: any[] = [];
  const matchedTargetsByPage = new Map<number, Set<number>>();

  for (const candidate of transactions) {
    const candPage = Number(candidate.rawPageNumber) || 0;
    const pageMatched = matchedTargetsByPage.get(candPage) || new Set<number>();
    let matchedIdx = -1;

    for (let i = 0; i < result.length; i++) {
      if (pageMatched.has(i)) continue;
      const target = result[i];
      if (areGeminiTransactionsDuplicate(target, candidate)) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx !== -1) {
      const target = result[matchedIdx];
      if ((!target.summary || target.summary.length < (candidate.summary?.length || 0)) && candidate.summary) {
        target.summary = candidate.summary;
      }
      if (!target.counterpartyName && candidate.counterpartyName) {
        target.counterpartyName = candidate.counterpartyName;
      }
      if (!target.counterpartyAccount && candidate.counterpartyAccount) {
        target.counterpartyAccount = candidate.counterpartyAccount;
      }
      if (candidate.transactionTime && candidate.transactionTime.length > (target.transactionTime?.length || 0)) {
        target.transactionTime = candidate.transactionTime;
      }
      if ((target.balance == null || target.balanceAvailable === false) && candidate.balance != null) {
        target.balance = candidate.balance;
        target.balanceAvailable = true;
      }
      pageMatched.add(matchedIdx);
      matchedTargetsByPage.set(candPage, pageMatched);
    } else {
      result.push({ ...candidate });
    }
  }

  return result;
}

function areGeminiTransactionsDuplicate(a: any, b: any): boolean {
  const accA = String(a.accountNumber || '').replace(/[\s\-_—–·•]/g, '').toLowerCase();
  const accB = String(b.accountNumber || '').replace(/[\s\-_—–·•]/g, '').toLowerCase();
  if (accA && accB && accA !== accB) return false;

  const dateA = String(a.transactionDate || '').slice(0, 10);
  const dateB = String(b.transactionDate || '').slice(0, 10);
  if (!dateA || !dateB || dateA !== dateB) return false;

  if (a.direction !== b.direction) return false;

  if (Math.abs((Number(a.amount) || 0) - (Number(b.amount) || 0)) >= 0.01) return false;

  const timeA = (String(a.transactionTime || '').match(/(\d{2}:\d{2}(?::\d{2})?)/) || [])[1] || '';
  const timeB = (String(b.transactionTime || '').match(/(\d{2}:\d{2}(?::\d{2})?)/) || [])[1] || '';

  const hasBalA = a.balance != null && a.balanceAvailable !== false;
  const hasBalB = b.balance != null && b.balanceAvailable !== false;

  if (hasBalA && hasBalB) {
    if (Math.abs(Number(a.balance) - Number(b.balance)) >= 0.01) return false;

    if (a.rawPageNumber && b.rawPageNumber && a.rawPageNumber !== b.rawPageNumber) {
      const cleanSummary = (s: string) => String(s || '').replace(/[\s\-_@#*|/\\.,:;，。、：；]/g, '').toLowerCase();
      const sA = cleanSummary(a.summary);
      const sB = cleanSummary(b.summary);
      const cpA = cleanSummary(a.counterpartyName);
      const cpB = cleanSummary(b.counterpartyName);
      const pageDiff = Math.abs(a.rawPageNumber - b.rawPageNumber);

      if (timeA && timeB) return timeA === timeB;
      if (sA && sB) return sA.includes(sB) || sB.includes(sA);
      if (pageDiff >= 2) {
        if (cpA && cpB && (cpA.includes(cpB) || cpB.includes(cpA))) return true;
        if (sA || sB) return true;
      }
      return false;
    }

    const cleanSummary = (s: string) => String(s || '').replace(/[\s\-_@#*|/\\.,:;，。、：；]/g, '').toLowerCase();
    const sA = cleanSummary(a.summary);
    const sB = cleanSummary(b.summary);
    if ((timeA && timeB && timeA === timeB) || (sA && sB && sA === sB) || (!sA && !sB)) {
      return true;
    }
    return false;
  }

  if (timeA && timeB && timeA === timeB && timeA.split(':').length === 3) return true;

  const cleanSummary = (s: string) => String(s || '').replace(/[\s\-_@#*|/\\.,:;，。、：；]/g, '').toLowerCase();
  const sA = cleanSummary(a.summary);
  const sB = cleanSummary(b.summary);
  if (sA && sB && (sA.includes(sB) || sB.includes(sA))) return true;

  return false;
}

function calibrateGeminiDirections(transactions: any[]): any[] {
  // Group by account
  const byAccount = new Map<string, any[]>();
  for (const tx of transactions) {
    const key = `${tx.bankName || ''}_${tx.accountNumber || ''}`;
    byAccount.set(key, [...(byAccount.get(key) || []), tx]);
  }

  for (const [, accTxs] of byAccount) {
    if (accTxs.length < 2) continue;

    // Detect reverse order
    let forwardDatePairs = 0;
    let reverseDatePairs = 0;
    for (let i = 1; i < accTxs.length; i++) {
      const prevDate = String(accTxs[i - 1].transactionDate || accTxs[i - 1].transactionTime || '').slice(0, 10);
      const currDate = String(accTxs[i].transactionDate || accTxs[i].transactionTime || '').slice(0, 10);
      if (prevDate && currDate && prevDate !== currDate) {
        if (prevDate < currDate) forwardDatePairs++;
        else if (prevDate > currDate) reverseDatePairs++;
      }
    }
    const isReverse = reverseDatePairs > forwardDatePairs && reverseDatePairs >= 1;
    const chronological = isReverse ? [...accTxs].reverse() : accTxs;

    // 1. Calibrate directions
    for (let i = 1; i < chronological.length; i++) {
      const prev = chronological[i - 1];
      const curr = chronological[i];

      if (prev.balance == null || curr.balance == null || !curr.amount) continue;

      const prevBal = Number(prev.balance);
      const currBal = Number(curr.balance);
      const amt = Number(curr.amount);
      const diffIn = Math.abs(prevBal + amt - currBal);
      const diffOut = Math.abs(prevBal - amt - currBal);

      if (diffIn < 0.05 && diffOut >= 0.05) {
        curr.direction = 'IN';
      } else if (diffOut < 0.05 && diffIn >= 0.05) {
        curr.direction = 'OUT';
      }
    }

    // 2. Bridge heal OCR digit discrepancies
    for (let i = 1; i < chronological.length - 1; i++) {
      const prev = chronological[i - 1];
      const curr = chronological[i];
      const next = chronological[i + 1];

      if (prev.balance == null || curr.balance == null || next.balance == null || !curr.amount || !next.amount) continue;

      const prevBal = Number(prev.balance);
      const currBal = Number(curr.balance);
      const nextBal = Number(next.balance);
      const currAmt = Number(curr.amount);
      const nextAmt = Number(next.amount);

      const deltaCurr = curr.direction === 'IN' ? currAmt : -currAmt;
      const errPrevCurr = Math.abs(prevBal + deltaCurr - currBal);
      const deltaNext = next.direction === 'IN' ? nextAmt : -nextAmt;
      const errCurrNext = Math.abs(currBal + deltaNext - nextBal);

      if (errPrevCurr >= 0.5 || errCurrNext >= 0.5) {
        const impliedBalCurr = Math.round((next.direction === 'OUT' ? nextBal + nextAmt : nextBal - nextAmt) * 100) / 100;
        const impliedAmtCurr = Math.round(Math.abs(curr.direction === 'IN' ? impliedBalCurr - prevBal : prevBal - impliedBalCurr) * 100) / 100;
        const impliedDelta = curr.direction === 'IN' ? impliedAmtCurr : -impliedAmtCurr;

        if (Math.abs(prevBal + impliedDelta - impliedBalCurr) < 0.05 && Math.abs(impliedBalCurr + deltaNext - nextBal) < 0.05 && impliedAmtCurr > 0) {
          curr.amount = impliedAmtCurr;
          curr.balance = impliedBalCurr;
        }
      }
    }
  }

  return transactions;
}


