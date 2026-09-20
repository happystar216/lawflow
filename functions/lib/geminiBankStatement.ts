import { normalizeSourceBox } from './sourceRegion';

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

export class RecognitionDiagnosticError extends Error {
  constructor(
    public diagnosticCode: string,
    message: string,
    public diagnostics: Record<string, string | number | boolean | undefined> = {}
  ) {
    super(message);
    this.name = 'RecognitionDiagnosticError';
  }
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
   中国工商银行信用卡历史明细中的【借贷标志】按银行表格含义读取：1 为借记/消费/支出（OUT），2 为贷记/还款/冲正/收入（IN）。
5. 账号统一规范：同一份银行对账单内，若表头有【系统账号】且部分行有【卡号】、部分行为横杠“-”，必须全单统一使用同一个账号/卡号（ac），严禁在同一份单据内交替混用两个账号，确保同一账单流水不被割裂！
6. 严格按物理列位对齐提取：摘要栏经常包含合同还款额或代扣协议文本（例如包含 "@2640.00@6@1@" 等），严禁提取摘要中的文本数值代替实际发生额！必须严格提取表格中【交易金额】一列印刷的真实发生额数值。
7. 忠实还原数字原样：仔细核验千分位逗号与每位数字（例如 “-4,000.00” 是 4000.00，注意区分首位点阵字形），按印刷字面原样输出，严禁自行心算凑数或编造虚假数字。
8. 信用卡与特殊账单：如遇到透支余额为负数、按月打印的周期性利息还款或免收年费（发生额印为 0.00），均如实按原件印刷数值记录。
9. pageChecks 必须逐页列出原件的每一页，包括空白页和非交易文书页；transactions 数量必须等于各交易页 transactionCount 之和。每个交易页必须从该页页眉独立读取本方 bankName、accountName、accountNumber，不得沿用上一页或下一页账号；无法确认时留空，不得猜测。同一页若表格逐行列出多个不同账号，pageChecks.accountNumber 留空，每笔 transactions.ac 必须填写该行自身账号，严禁用页级账号覆盖整页。
10. 点阵打印表中的日期必须逐位读取完整的 8 位数字；同一账号的日期通常按表格物理行顺序排列，如年份突然倒退数年必须回看原图复核。发生额明确印为 0.00 的“结息”行必须输出 amt: 0，不得当作缺失值；“销户/清户/冻结扣划/司法扣划”行必须读取完整的带符号发生额，并用相邻余额差复核是否漏掉中间数字。

【输出格式】：严格输出标准 JSON，字段精简以避免超限：
{
  "totalExtracted": 0,
  "pagesCovered": [],
  "pageChecks": [{"pageNumber": 1, "transactionCount": 0, "pageType": "TRANSACTIONS|ACCOUNT_INFO|DOCUMENT|BLANK|UNKNOWN", "bankName": "该页页眉银行", "accountName": "该页页眉户名", "accountNumber": "单一账号页的本方账号，多账号页留空", "accountNumbers": ["按页面物理顺序列出本页全部本方账号"]}],
  "transactions": [
    {
      "p": 原件页码数字,
      "r": 本页交易明细中从1开始的物理行序号,
      "bk": "银行名称",
      "ac": "账号或卡号",
      "holder": "户名(若未体现则留空)",
      "tm": "交易时间(YYYY-MM-DD HH:mm:ss，无时间则YYYY-MM-DD)",
      "dir": "IN或OUT",
      "amt": 交易金额数值,
      "bal": 余额数值(无法识别填null),
      "cp": "对方户名",
      "ca": "对方账号",
      "sm": "摘要及备注",
      "box": [该交易整行的上边界, 左边界, 下边界, 右边界，按页面左上角为原点的0至1000整数坐标；无法定位填null]
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

  onProgress?.({ statusText: '正在安全读取卷宗文件…', totalTransactions: 0, percent: 5 });

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  const base64Data = btoa(chunks.join(''));

  onProgress?.({ statusText: '文件读取完成，正在识别页面内容…', totalTransactions: 0, percent: 15 });

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
  let finishReason = '';
  let responseFrames = 0;
  let malformedFrames = 0;
  let outputTokens = 0;

  const consumePayload = (payload: any) => {
    responseFrames += 1;
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason) finishReason = String(candidate.finishReason);
    if (Number.isFinite(Number(payload.usageMetadata?.candidatesTokenCount))) {
      outputTokens = Number(payload.usageMetadata.candidatesTokenCount);
    }
    const textChunk = candidate?.content?.parts?.[0]?.text;
    if (!textChunk) return;
    accumulatedText += textChunk;

    const matches = accumulatedText.match(/"amt"\s*:/g);
    const currentCount = matches ? matches.length : 0;
    const bankMatch = textChunk.match(/"bk"\s*:\s*"([^"]+)"/);
    if (bankMatch?.[1]) lastCurrentBank = bankMatch[1];
    if (currentCount <= transactionMatchCount) return;
    transactionMatchCount = currentCount;
    const dynamicPercent = Math.min(95, 20 + Math.floor((transactionMatchCount / 500) * 75));
    onProgress?.({
      statusText: `正在提取【${lastCurrentBank}】流水明细，已读取约 ${transactionMatchCount} 笔…`,
      totalTransactions: transactionMatchCount,
      percent: dynamicPercent,
      currentBank: lastCurrentBank
    });
  };

  try {
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
        if (!dataStr || dataStr === '[DONE]') continue;

        try {
          consumePayload(JSON.parse(dataStr));
        } catch {
          malformedFrames += 1;
        }
      }
    }
  } catch (error) {
    throw new RecognitionDiagnosticError(
      'UPSTREAM_STREAM_INTERRUPTED',
      '上游识别数据流在完成前中断',
      { receivedTransactions: transactionMatchCount, responseFrames, malformedFrames, outputTokens }
    );
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data:')) {
      try {
        consumePayload(JSON.parse(trimmed.slice(5).trim()));
      } catch { malformedFrames += 1; }
    }
  }

  if (/MAX_TOKENS|LENGTH|TOKEN/i.test(finishReason)) {
    throw new RecognitionDiagnosticError(
      'OUTPUT_LIMIT_REACHED',
      '单次识别输出达到长度上限，完整结果尚未生成',
      { receivedTransactions: transactionMatchCount, responseFrames, malformedFrames, outputTokens, finishReason }
    );
  }
  if (finishReason && !/STOP/i.test(finishReason)) {
    throw new RecognitionDiagnosticError(
      'MODEL_STOPPED_EARLY',
      `识别服务提前停止生成（${finishReason}）`,
      { receivedTransactions: transactionMatchCount, responseFrames, malformedFrames, outputTokens, finishReason }
    );
  }
  if (!accumulatedText.trim()) {
    throw new RecognitionDiagnosticError(
      'EMPTY_MODEL_RESPONSE',
      '识别服务已响应，但没有返回可解析的正文',
      { responseFrames, malformedFrames, outputTokens, finishReason }
    );
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
      throw new RecognitionDiagnosticError(
        'INVALID_STRUCTURED_OUTPUT',
        '识别服务返回了内容，但结构化数据不完整且无法恢复',
        { receivedTransactions: transactionMatchCount, responseFrames, malformedFrames, outputTokens, finishReason, responseCharacters: cleanJsonText.length }
      );
    }
  }

  const expectedHolder = options?.respondentName?.trim() || '';
  const pageIdentities = new Map<number, { bankName: string; accountName: string; accountNumber: string; accountNumbers: string[] }>();
  for (const check of Array.isArray(parsedResult.pageChecks) ? parsedResult.pageChecks : []) {
    const pageNumber = Number(check?.pageNumber);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) continue;
    pageIdentities.set(pageNumber, {
      bankName: String(check?.bankName || '').trim(),
      accountName: String(check?.accountName || '').trim(),
      accountNumber: normalizeExtractedAccountNumber(check?.accountNumber),
      accountNumbers: [...new Set<string>((Array.isArray(check?.accountNumbers) ? check.accountNumbers as unknown[] : [])
        .map((value: unknown) => normalizeExtractedAccountNumber(value))
        .filter(isReliableExtractedAccountNumber))]
    });
  }
  const documentAccountNumbers = [...new Set([...pageIdentities.values()].flatMap(listedIdentityAccountNumbers))];

  // A page-level identity is useful for ordinary single-account statements and
  // protects against a model carrying the previous page's account forward. It
  // must not overwrite row-level accounts on consolidated ledgers where one
  // physical page contains several distinct accounts.
  const transactionAccountsByPage = new Map<number, Set<string>>();
  for (const tx of rawTxList) {
    const pageNumber = Number.parseInt(String(tx?.p || ''), 10);
    const accountNumber = normalizeExtractedAccountNumber(tx?.ac);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !isReliableExtractedAccountNumber(accountNumber)) continue;
    const accounts = transactionAccountsByPage.get(pageNumber) || new Set<string>();
    accounts.add(accountNumber);
    transactionAccountsByPage.set(pageNumber, accounts);
  }
  const consolidatedPageResolution = resolveConsolidatedPageAccounts(rawTxList, pageIdentities);
  const rowCountByPage = new Map<number, number>();

  const rawTransactions = rawTxList.map((tx: any, idx: number) => {
    const rawHolder = String(tx.holder || '').trim();
    const resolvedAccountName = rawHolder || expectedHolder || '被执行人';
    const transactionTime = normalizeGeminiDateTime(tx.tm);
    const direction = normalizeGeminiDirection(tx.dir);
    const rawAmount = Number(tx.amt);
    const amount = Number.isFinite(rawAmount) ? Math.abs(rawAmount) : 0;
    const rawBalance = tx.bal === null || tx.bal === undefined || tx.bal === '' ? null : Number(tx.bal);
    const balance = rawBalance !== null && Number.isFinite(rawBalance) ? rawBalance : null;
    const rawPageNumber = Number.parseInt(String(tx.p || ''), 10);
    const inferredRowIndex = (rowCountByPage.get(rawPageNumber) || 0) + 1;
    rowCountByPage.set(rawPageNumber, inferredRowIndex);
    const reportedRowIndex = Number.parseInt(String(tx.r || ''), 10);
    const pageIdentity = pageIdentities.get(rawPageNumber);
    const rowAccountNumber = normalizeExtractedAccountNumber(tx.ac);
    const isMultiAccountPage = (transactionAccountsByPage.get(rawPageNumber)?.size || 0) > 1;
    const resolvedAccountNumber = canonicalDocumentAccountNumber(
      consolidatedPageResolution.accountByTransactionIndex.get(idx)
      || (isMultiAccountPage && isReliableExtractedAccountNumber(rowAccountNumber)
        ? rowAccountNumber
        : pageIdentity?.accountNumber || rowAccountNumber),
      documentAccountNumbers
    );
    const dataQualityIssues: Array<'INVALID_DATE' | 'INVALID_AMOUNT' | 'UNKNOWN_DIRECTION'> = [];
    if (!transactionTime) dataQualityIssues.push('INVALID_DATE');
    if (!Number.isFinite(rawAmount) || amount <= 0) dataQualityIssues.push('INVALID_AMOUNT');
    if (direction === 'UNKNOWN') dataQualityIssues.push('UNKNOWN_DIRECTION');
    return {
      id: `TX_GEMINI_${idx + 1}`,
      accountNumber: resolvedAccountNumber,
      accountName: pageIdentity?.accountName || resolvedAccountName,
      bankName: pageIdentity?.bankName || String(tx.bk || '商业银行'),
      transactionTime,
      transactionDate: transactionTime.slice(0, 10),
      direction,
      amount,
      balance,
      counterpartyName: String(tx.cp || ''),
      counterpartyAccount: String(tx.ca || ''),
      counterpartyBank: '',
      summary: String(tx.sm || ''),
      rawSourceFile: file.name,
      rawPageNumber: Number.isInteger(rawPageNumber) && rawPageNumber > 0 ? rawPageNumber : undefined,
      rawRowIndex: Number.isInteger(reportedRowIndex) && reportedRowIndex > 0 ? reportedRowIndex : inferredRowIndex,
      rawText: `${tx.tm || ''} ${tx.dir || ''} ${tx.amt || ''} ${tx.sm || ''}`,
      sourceRegion: normalizeSourceBox(tx.box),
      balanceAvailable: balance !== null,
      extractionMethod: 'GEMINI_DIRECT_PDF',
      extractionConfidence: dataQualityIssues.length ? 0.4 : 0.9,
      reviewStatus: dataQualityIssues.length ? 'PENDING' : 'AUTO_PASSED',
      dataQualityIssues
    };
  });

  // Deduplication preserves the extracted values. Any mathematical correction is performed later
  // by the shared normalizer, which records the original values and requires lawyer review.
  const transactions = deduplicateGeminiTransactions(rawTransactions);
  const expectedPages = Math.max(1, Number(options?.totalPages) || 1);
  const reportedPages = Array.isArray(parsedResult.pagesCovered)
    ? parsedResult.pagesCovered.map((page: unknown) => Number(page)).filter((page: number) => Number.isInteger(page) && page >= 1 && page <= expectedPages)
    : [];
  const checkedPages = Array.isArray(parsedResult.pageChecks)
    ? parsedResult.pageChecks.map((item: any) => Number(item?.pageNumber)).filter((page: number) => Number.isInteger(page) && page >= 1 && page <= expectedPages)
    : [];
  const transactionPages = transactions.map((item: any) => item.rawPageNumber).filter((page: unknown): page is number => typeof page === 'number');
  const pagesCovered = [...new Set([...reportedPages, ...checkedPages, ...transactionPages])].sort((a, b) => a - b);
  const missingPages = Array.from({ length: expectedPages }, (_, index) => index + 1).filter(page => !pagesCovered.includes(page));
  const pageChecks = Array.isArray(parsedResult.pageChecks) ? parsedResult.pageChecks : [];
  const allCheckedPagesReportZero = pageChecks.length > 0
    && pageChecks.every((item: any) => Number(item?.transactionCount) === 0);
  const warnings = [
    '智能识别结果须由律师对照原件复核',
    ...consolidatedPageResolution.warnings,
    ...(transactions.length === 0
      ? [allCheckedPagesReportZero && missingPages.length === 0
        ? '原件各页均未识别到交易明细；请确认所选查询期间是否确无流水'
        : '未识别到流水明细，且页面覆盖可能不完整；请对照原件确认是否存在漏识别']
      : []),
    ...(missingPages.length ? [`页面覆盖不完整，缺少第 ${missingPages.join('、')} 页的结构化确认`] : [])
  ];

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
        endBalance: t.balance ?? 0,
        isBalanced: true,
        balanceDiff: 0,
        balanceAvailable: t.balanceAvailable !== false
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

  // Account-list pages are evidence in their own right. Keep every listed
  // account even when only some of them have transaction rows elsewhere in the
  // document. Short detail-page numbers are reconciled to a unique longer
  // account-list number above, so the three active accounts are not duplicated.
  for (const identity of pageIdentities.values()) {
    const listed = listedIdentityAccountNumbers(identity);
    for (const listedNumber of listed) {
      const accountNumber = canonicalDocumentAccountNumber(listedNumber, documentAccountNumbers);
      if (!isReliableExtractedAccountNumber(accountNumber)) continue;
      const existing = [...accountMap.values()].find(account =>
        areEquivalentDocumentAccountNumbers(account.accountNumber, accountNumber)
      );
      if (existing) continue;
      const bankName = identity.bankName
        || [...accountMap.values()][0]?.bankName
        || '待核对银行';
      const key = `${bankName}_${accountNumber}`;
      accountMap.set(key, {
        accountNumber,
        accountName: identity.accountName || expectedHolder || '待核对户名',
        bankName,
        ownerType: 'DEBTOR_MAIN',
        fileName: file.name,
        fileType: 'pdf',
        totalIn: 0,
        totalOut: 0,
        transactionCount: 0,
        startDate: '',
        endDate: '',
        startBalance: 0,
        endBalance: 0,
        isBalanced: false,
        balanceDiff: 0,
        balanceAvailable: false
      });
    }
  }

  if (transactions.length === 0) {
    for (const identity of pageIdentities.values()) {
      if (!identity.bankName && !identity.accountName && !identity.accountNumber) continue;
      const accountNumber = identity.accountNumber || '待核对账号';
      const key = `${identity.bankName || '待核对银行'}_${accountNumber}`;
      if (accountMap.has(key)) continue;
      accountMap.set(key, {
        accountNumber,
        accountName: identity.accountName || expectedHolder || '待核对户名',
        bankName: identity.bankName || '待核对银行',
        ownerType: 'DEBTOR_MAIN',
        fileName: file.name,
        fileType: 'pdf',
        totalIn: 0,
        totalOut: 0,
        transactionCount: 0,
        startDate: '',
        endDate: '',
        startBalance: 0,
        endBalance: 0,
        isBalanced: false,
        balanceDiff: 0,
        balanceAvailable: false
      });
    }
  }

  for (const acc of accountMap.values()) {
    const calculatedEndBalance = acc.startBalance + acc.totalIn - acc.totalOut;
    acc.balanceDiff = Math.abs(calculatedEndBalance - acc.endBalance);
    acc.isBalanced = acc.transactionCount > 0 && acc.balanceDiff < 1.0;
    acc.parseStatus = 'NEEDS_REVIEW';
    acc.parseWarnings = warnings;
    acc.coveredPages = pagesCovered;
    acc.totalPages = expectedPages;
  }

  let accounts = Array.from(accountMap.values());
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
    balanceAvailable: false,
    parseStatus: 'NEEDS_REVIEW',
    parseWarnings: warnings,
    coveredPages: pagesCovered,
    totalPages: expectedPages
  };
  if (accounts.length === 0) accounts = [mainAccount];

  return {
    account: mainAccount,
    accounts,
    transactions,
    totalCount: transactions.length,
    pagesCovered,
    warnings,
    countComplete: missingPages.length === 0 && pagesCovered.length === expectedPages
  };
}

function normalizeExtractedAccountNumber(value: unknown): string {
  return String(value || '').replace(/[\s\-_—–·•]/g, '');
}

function listedIdentityAccountNumbers(identity: { accountNumber: string; accountNumbers: string[] }): string[] {
  // On an account-list page, the plural field is the authoritative physical
  // list. The singular field is only a fallback for ordinary one-account pages;
  // models sometimes put a customer number or a shortened duplicate there.
  if (identity.accountNumbers.length > 0) return [...new Set(identity.accountNumbers)];
  return isReliableExtractedAccountNumber(identity.accountNumber) ? [identity.accountNumber] : [];
}

function canonicalDocumentAccountNumber(value: string, candidates: string[]): string {
  const normalized = normalizeExtractedAccountNumber(value);
  if (!isReliableExtractedAccountNumber(normalized)) return normalized;
  const matches = [...new Set(candidates
    .map(normalizeExtractedAccountNumber)
    .filter(candidate => areEquivalentDocumentAccountNumbers(candidate, normalized)))];
  if (!matches.length) return normalized;
  const maxLength = Math.max(...matches.map(candidate => candidate.length));
  const longest = matches.filter(candidate => candidate.length === maxLength);
  return longest.length === 1 ? longest[0] : normalized;
}

function areEquivalentDocumentAccountNumbers(left: string, right: string): boolean {
  const a = normalizeExtractedAccountNumber(left);
  const b = normalizeExtractedAccountNumber(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  const prefixLength = longer.length - shorter.length;
  return shorter.length >= 10 && prefixLength >= 1 && prefixLength <= 4 && longer.endsWith(shorter);
}

function resolveConsolidatedPageAccounts(
  rawTransactions: any[],
  pageIdentities: Map<number, { accountNumber: string; accountNumbers: string[] }>
): { accountByTransactionIndex: Map<number, string>; warnings: string[] } {
  const accountByTransactionIndex = new Map<number, string>();
  const warnings: string[] = [];
  const byPage = new Map<number, Array<{ transaction: any; index: number }>>();
  rawTransactions.forEach((transaction, index) => {
    const pageNumber = Number.parseInt(String(transaction?.p || ''), 10);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return;
    byPage.set(pageNumber, [...(byPage.get(pageNumber) || []), { transaction, index }]);
  });

  for (const [pageNumber, entries] of byPage) {
    const rowAccounts = [...new Set(entries
      .map(entry => normalizeExtractedAccountNumber(entry.transaction?.ac))
      .filter(isReliableExtractedAccountNumber))];
    if (rowAccounts.length > 1) continue;

    const segments: Array<typeof entries> = [];
    let current: typeof entries = [];
    for (const entry of entries) {
      if (current.length && isLikelyConsolidatedAccountBoundary(current[current.length - 1].transaction, entry.transaction)) {
        segments.push(current);
        current = [];
      }
      current.push(entry);
    }
    if (current.length) segments.push(current);
    if (segments.length <= 1) continue;

    const identity = pageIdentities.get(pageNumber);
    const candidates = identity ? listedIdentityAccountNumbers(identity) : [];
    const hasCompleteAccountList = candidates.length === segments.length;
    segments.forEach((segment, segmentIndex) => {
      const accountNumber = hasCompleteAccountList
        ? candidates[segmentIndex]
        : segmentIndex === 0 && rowAccounts[0]
          ? rowAccounts[0]
          : `待核对账号-第${pageNumber}页-分组${segmentIndex + 1}`;
      segment.forEach(entry => accountByTransactionIndex.set(entry.index, accountNumber));
    });
    if (!hasCompleteAccountList) {
      warnings.push(`第 ${pageNumber} 页检测到 ${segments.length} 组余额彼此不连续的账号段，逐笔账号未可靠读取；系统已分组保留，请对照原件核对账号`);
    }
  }

  return { accountByTransactionIndex, warnings };
}

function isLikelyConsolidatedAccountBoundary(previous: any, current: any): boolean {
  const previousBalance = Number(previous?.bal);
  const currentBalance = Number(current?.bal);
  const amount = Math.abs(Number(current?.amt));
  const direction = normalizeGeminiDirection(current?.dir);
  if (![previousBalance, currentBalance, amount].every(Number.isFinite) || direction === 'UNKNOWN') return false;
  const text = `${previous?.sm || ''} ${current?.sm || ''}`;
  if (!/结息|利息结算|计息/.test(text)) return false;
  const expectedBalance = previousBalance + (direction === 'IN' ? amount : -amount);
  const gap = Math.abs(expectedBalance - currentBalance);
  return gap >= Math.max(1000, amount * 20);
}

function isReliableExtractedAccountNumber(value: string): boolean {
  return value.length >= 6 && !/未知|待核对|待确认|无账号/i.test(value);
}

function normalizeGeminiDirection(value: unknown): 'IN' | 'OUT' | 'UNKNOWN' {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'IN') return 'IN';
  if (normalized === 'OUT') return 'OUT';
  return 'UNKNOWN';
}

function normalizeGeminiDateTime(value: unknown): string {
  const text = String(value || '').trim().replace(/\//g, '-');
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
  const isoDate = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  if (!match[4]) return isoDate;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (hour > 23 || minute > 59 || second > 59) return '';
  return `${isoDate} ${match[4].padStart(2, '0')}:${match[5].padStart(2, '0')}:${String(match[6] || '0').padStart(2, '0')}`;
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
