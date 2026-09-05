interface QwenEnvironment {
  DASHSCOPE_API_KEY?: string;
  DASHSCOPE_BASE_URL?: string;
  QWEN_MODEL?: string;
}

interface QwenRawTransaction {
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  transactionTime?: string;
  transactionDate?: string;
  direction?: string;
  amount?: number | string;
  balance?: number | string | null;
  counterpartyName?: string;
  counterpartyAccount?: string;
  counterpartyBank?: string;
  summary?: string;
  rawPageNumber?: number | string;
  rawRowIndex?: number | string;
  rawText?: string;
  confidence?: number | string;
}

interface QwenDocumentResult {
  document?: {
    bankName?: string;
    accountName?: string;
    accountNumber?: string;
    startBalance?: number | string | null;
    endBalance?: number | string | null;
  };
  pageChecks?: Array<{ pageNumber?: number; transactionCount?: number; pageType?: string; note?: string }>;
  transactions?: QwenRawTransaction[];
  warnings?: string[];
}

export interface QwenChunkOptions {
  sourceFileName?: string;
  pageStart?: number;
  pageEnd?: number;
  totalPages?: number;
  chunkId?: string;
  inputKind?: 'pdf' | 'image';
  contextBefore?: File;
  contextAfter?: File;
  auditHint?: string;
  isPageSlice?: boolean;
  signal?: AbortSignal;
}

export interface QwenParseResult {
  account: Record<string, unknown>;
  transactions: Array<Record<string, unknown>>;
  warnings: string[];
  pageCount: number;
  model: string;
  coveredPages: number[];
  pageStart: number;
  pageEnd: number;
  totalPages: number;
  expectedTransactionCount: number;
  countComplete: boolean;
  usageTokens?: number;
  pageQuality: Array<{
    page: number;
    expectedCount: number;
    extractedCount: number;
    status: 'COMPLETE' | 'NEEDS_REVIEW';
    pageType?: PageType;
  }>;
}

type PageType = 'TRANSACTIONS' | 'ACCOUNT_INFO' | 'DOCUMENT' | 'BLANK' | 'UNKNOWN';

const extractionPrompt = (expectedPages: number, inputKind: 'pdf' | 'image', isPageSlice = false) => `你是银行流水证据结构化专家。本次输入是原始银行流水的${isPageSlice ? '单页纵向局部图像' : inputKind === 'image' ? '单页原件图像' : `一个 PDF 分片，共 ${expectedPages} 页`}。请完整读取每一页、每一行交易明细，输出 JSON，不要输出解释或 Markdown。

最高优先级要求：
1. 不得只提取大额、可疑或示例交易；所有有效交易逐笔输出，包括小额、手续费、利息、冲正、现金、保险、理财和内部转账。
2. 不得因对手方、摘要、余额或账号缺失而丢弃一笔已有日期与发生额的交易；缺失文本用空字符串，余额无法识别时用 null。
3. 借方/支出为 OUT，贷方/收入为 IN。若银行版式以正负号表达，以该版式含义为准；确实无法判断时填 UNKNOWN，不得猜测。
4. 同一交易跨行展示时合并为一笔；不要把页眉、页脚、合计、小计、期初余额、期末余额当作交易。
5. rawPageNumber 必须使用本分片内的 1 起始页码，范围是 1 到 ${expectedPages}；不要猜测原文件页码。${isPageSlice ? ' 本图只是原页的一段：只输出本段中可见且有交易序号、日期或关键字段的交易；跨出图像边缘的续行不得虚构，也不要把表头当交易。rawRowIndex 按本段从上到下排列即可。' : ''}
6. pageChecks 必须严格包含 ${expectedPages} 项，每页一项；即使没有交易，也必须输出 transactionCount: 0。pageType 必须填写 TRANSACTIONS（交易明细）、ACCOUNT_INFO（开户/账户信息）、DOCUMENT（法院或银行文书）、BLANK（空白）或 UNKNOWN。
7. rawRowIndex 使用该页交易明细的 1 起始顺序。transactions 数量必须等于各页有效交易数之和。
8. 一个分片可能同时包含多家银行或多个账户。每笔 transaction 的 bankName、accountName、accountNumber 必须填写“流水所属的本方账户”（通常来自页眉、账户信息栏或银行卡号），绝不能填写收款人、付款人或对手方的银行与账号。向多家不同银行转账仍然归属于发起交易的同一个本方账户；对方信息只能放入 counterpartyName、counterpartyAccount、counterpartyBank。
9. 不得把不同本方银行或不同本方账号的交易统一归入 document 中的单一账户。页面切换本方账户时，按该页实际抬头填写。

严格输出以下结构：
{
  "document":{"bankName":"","accountName":"","accountNumber":"","startBalance":null,"endBalance":null},
  "pageChecks":[{"pageNumber":1,"transactionCount":0,"pageType":"TRANSACTIONS","note":""}],
  "transactions":[{"bankName":"","accountName":"","accountNumber":"","transactionTime":"YYYY-MM-DD HH:mm:ss；没有时间则 YYYY-MM-DD","transactionDate":"YYYY-MM-DD","direction":"IN、OUT 或 UNKNOWN","amount":0,"balance":null,"counterpartyName":"","counterpartyAccount":"","counterpartyBank":"","summary":"","rawText":"原始行文字","confidence":0.95,"rawPageNumber":1,"rawRowIndex":1}],
  "warnings":[]
}`;

const countVerificationPrompt = `你只负责判断页面类型并独立清点这一页中的有效银行交易明细。开户信息、账户清单、余额查询、法院文书、调查令回执都不是交易明细，必须计为0。跨行显示的同一笔只计1笔，页眉、页脚、合计、小计、期初和期末余额不计。严格输出 JSON：{"pageType":"TRANSACTIONS、ACCOUNT_INFO、DOCUMENT、BLANK 或 UNKNOWN","transactionCount":0,"readability":"CLEAR、UNCERTAIN 或 BLANK"}`;

const contextualAuditPrompt = (hint: string) => `这是一次异常页复核。输入图片依次标注为上一页、目标页、下一页；只输出目标页的结构化结果，上一页和下一页仅用于拼接跨页交易、确认列含义和本方账户。禁止把相邻页独立交易重复输出。

重点检查：
1. 目标页顶部如果只是上一页末笔的续行，不得在目标页重复生成；目标页底部开始、在下一页续写的交易，应借助下一页补全并归入目标页。跨页交易以“首次出现交易序号或交易日期的页面”为归属页，只输出一次。
   强制规则：如果目标页最后一个交易序号只有日期/时间等表头字段，必须查看下一页顶部，并把“下一页第一个新交易序号出现之前”的所有无序号行合并到该末笔，补齐方向、发生额、余额、对手方和摘要。只要这些字段在下一页顶部可见，就不得输出 amount=0、direction=UNKNOWN 或空白占位。
2. 用相邻余额验证借贷方向：前余额 + 收入 - 支出 = 当前余额。如果整页方向反了，按余额关系纠正。
3. 防止把余额列当发生额、把发生额当余额；若现有结果出现余额全为0或发生额等于页面余额，应重新按表头定位列。
4. 交易日期、金额、余额、借贷方向必须来自同一个序号，不能把下一行日期与上一行金额拼在一起。
5. 页面不是交易明细时，pageType正确分类且transactionCount为0。

现有结果及程序检测提示仅供排错，不得直接照抄：${hint.slice(0, 12000)}`;

export async function parseBankStatementWithQwen(
  file: File,
  env: QwenEnvironment,
  onActivity?: (message: string) => void,
  options: QwenChunkOptions = {}
): Promise<QwenParseResult> {
  if (!env.DASHSCOPE_API_KEY || !env.DASHSCOPE_BASE_URL) throw new Error('页面解析服务尚未完成配置');
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImage = file.type.startsWith('image/') || /\.(?:png|jpe?g|webp)$/i.test(file.name);
  if (!isPdf && !isImage) throw new Error('当前仅接收页面图片或 PDF 文件');
  if (file.size > (isImage ? 20 : 150) * 1024 * 1024) throw new Error('页面文件超过大小限制');

  const pageStart = positiveInteger(options.pageStart) || 1;
  const pageEnd = positiveInteger(options.pageEnd) || pageStart;
  const totalPages = positiveInteger(options.totalPages) || pageEnd;
  if (pageEnd < pageStart || pageEnd > totalPages) throw new Error('PDF 分片页码参数无效');
  const expectedPages = pageEnd - pageStart + 1;
  if (isImage && expectedPages !== 1) throw new Error('一张页面图片只能对应一个原始页码');
  const model = env.QWEN_MODEL || 'qwen3.8-flash';
  const baseUrl = env.DASHSCOPE_BASE_URL.replace(/\/+$/, '');
  const inputKind = isImage ? 'image' as const : 'pdf' as const;
  const mimeType = isImage ? (file.type || 'image/jpeg') : 'application/pdf';
  const fileData = `data:${mimeType};base64,${arrayBufferToBase64(await file.arrayBuffer())}`;
  onActivity?.(`正在读取第 ${pageStart}–${pageEnd} 页全部交易…`);

  let inputContent = isImage
    ? [
        { type: 'text', text: extractionPrompt(expectedPages, inputKind, options.isPageSlice) },
        { type: 'image_url', image_url: { url: fileData } }
      ]
    : [
        { type: 'text', text: extractionPrompt(expectedPages, inputKind, options.isPageSlice) },
        { type: 'file', file: { file_data: fileData, filename: file.name, file_format: 'pdf' } }
      ];
  if (isImage && (options.contextBefore || options.contextAfter)) {
    const contextualImages: unknown[] = [];
    if (options.contextBefore) {
      contextualImages.push({ type: 'text', text: '上一页（仅作上下文）' });
      contextualImages.push({ type: 'image_url', image_url: { url: await fileDataUrl(options.contextBefore) } });
    }
    contextualImages.push({ type: 'text', text: '目标页（只提取这一页）' });
    contextualImages.push({ type: 'image_url', image_url: { url: fileData } });
    if (options.contextAfter) {
      contextualImages.push({ type: 'text', text: '下一页（仅作上下文）' });
      contextualImages.push({ type: 'image_url', image_url: { url: await fileDataUrl(options.contextAfter) } });
    }
    inputContent = [
      { type: 'text', text: extractionPrompt(expectedPages, inputKind, options.isPageSlice) },
      { type: 'text', text: contextualAuditPrompt(options.auditHint || '') },
      ...contextualImages
    ];
  } else if (isImage && options.auditHint) {
    inputContent = [
      { type: 'text', text: extractionPrompt(expectedPages, inputKind, options.isPageSlice) },
      { type: 'text', text: `补充读取要求：${options.auditHint.slice(0, 6000)}` },
      { type: 'image_url', image_url: { url: fileData } }
    ];
  }

  const callService = (content: unknown[], maxTokens: number) => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST', signal: options.signal,
    headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, messages: [{ role: 'user', content }], stream: false,
      response_format: { type: 'json_object' }, enable_thinking: false, temperature: 0, max_tokens: maxTokens
    })
  });
  const verificationContent = [
    { type: 'text', text: countVerificationPrompt },
    ...(isImage
      ? [{ type: 'image_url', image_url: { url: fileData } }]
      : [{ type: 'file', file: { file_data: fileData, filename: file.name, file_format: 'pdf' } }])
  ];
  // Keep the two independent passes sequential so a single edge request never holds two large encoded images at once.
  const extractionResponse = await callService(inputContent, 32768);
  if (!extractionResponse.ok) throw new Error(`页面解析服务请求失败（${extractionResponse.status}）`);
  const payload = await extractionResponse.json() as any;
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('页面解析结果为空');
  const verificationSettled = await callService(verificationContent, 512).then(async response => {
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<any>;
    }).then(payload => ({ payload }))
      .catch(error => ({ error }));
  let independentCount: number | undefined;
  let independentReadability: string | undefined;
  let independentPageType: PageType | undefined;
  let verificationUsage = 0;
  if ('payload' in verificationSettled) {
    try {
      const verification = parseJsonContent(verificationSettled.payload?.choices?.[0]?.message?.content || '');
      const rawCount = Number.parseInt(String((verification as any).transactionCount ?? ''), 10);
      if (Number.isFinite(rawCount) && rawCount >= 0) independentCount = rawCount;
      independentReadability = cleanText((verification as any).readability).toUpperCase();
      independentPageType = normalizePageType((verification as any).pageType);
      verificationUsage = nonNegativeInteger(verificationSettled.payload?.usage?.total_tokens);
    } catch {
      // The extraction remains usable; the missing independent check is made visible for lawyer review below.
    }
  }
  onActivity?.(`第 ${pageStart}–${pageEnd} 页结构化结果已返回，正在校验…`);
  return normalizeResult(parseJsonContent(content), model, {
    ...options,
    pageStart,
    pageEnd,
    totalPages,
    inputKind,
    sourceFileName: options.sourceFileName || file.name,
    independentCount,
    independentReadability,
    independentPageType,
    usageTokens: nonNegativeInteger(payload?.usage?.total_tokens) + verificationUsage
  });
}

function parseJsonContent(content: string): QwenDocumentResult {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('页面解析结果结构不完整');
  }
}

function normalizeResult(
  raw: QwenDocumentResult,
  model: string,
  options: QwenChunkOptions & { sourceFileName: string; pageStart: number; pageEnd: number; totalPages: number; inputKind: 'pdf' | 'image'; independentCount?: number; independentReadability?: string; independentPageType?: PageType; usageTokens?: number }
): QwenParseResult {
  const document = raw.document || {};
  const expectedPages = options.pageEnd - options.pageStart + 1;
  const accountNumber = cleanText(document.accountNumber) || `待核验-${options.sourceFileName.replace(/\.[^.]+$/, '')}`;
  const accountName = cleanText(document.accountName) || options.sourceFileName.replace(/\.[^.]+$/, '');
  const bankName = cleanText(document.bankName) || '待核验银行';
  const transactions = (Array.isArray(raw.transactions) ? raw.transactions : []).map((item, index) => {
    const rowBankName = cleanText(item.bankName) || bankName;
    const rowAccountName = cleanText(item.accountName) || accountName;
    const rowAccountNumber = cleanText(item.accountNumber) || cleanText(document.accountNumber)
      || `待核验-${rowBankName}-${options.sourceFileName.replace(/\.[^.]+$/, '')}`;
    const transactionTime = normalizeDateTime(item.transactionTime || item.transactionDate);
    const transactionDate = normalizeDate(item.transactionDate || transactionTime);
    const localPage = positiveInteger(item.rawPageNumber) || 1;
    if (localPage > expectedPages) throw new Error(`解析结果出现超出当前范围的页码 ${localPage}`);
    const page = options.pageStart + localPage - 1;
    const row = positiveInteger(item.rawRowIndex) || index + 1;
    const balanceAvailable = item.balance !== null && item.balance !== undefined && item.balance !== '';
    const direction = normalizeDirection(item.direction);
    const amount = money(item.amount);
    const dataQualityIssues: Array<'INVALID_DATE' | 'INVALID_AMOUNT' | 'UNKNOWN_DIRECTION'> = [];
    if (!transactionDate) dataQualityIssues.push('INVALID_DATE');
    if (!isValidMoney(item.amount) || amount <= 0) dataQualityIssues.push('INVALID_AMOUNT');
    if (direction === 'UNKNOWN') dataQualityIssues.push('UNKNOWN_DIRECTION');
    const rowConfidence = dataQualityIssues.length ? Math.min(confidence(item.confidence), 0.5) : confidence(item.confidence);
    return {
      id: `TX_PDF_P${page}_R${row}_${index + 1}`,
      accountNumber: rowAccountNumber, accountName: rowAccountName, bankName: rowBankName, transactionTime, transactionDate,
      direction, amount, balance: signedMoney(item.balance),
      counterpartyName: cleanText(item.counterpartyName), counterpartyAccount: cleanText(item.counterpartyAccount),
      counterpartyBank: cleanText(item.counterpartyBank), summary: cleanText(item.summary),
      rawSourceFile: options.sourceFileName, rawPageNumber: page, rawRowIndex: row,
      rawText: cleanText(item.rawText), balanceAvailable,
      extractionMethod: options.inputKind === 'image' ? 'DOCUMENT_IMAGE' : 'DOCUMENT_PDF', extractionConfidence: rowConfidence,
      extractionChunkId: cleanText(options.chunkId) || `P${options.pageStart}-${options.pageEnd}`,
      reviewStatus: rowConfidence < 0.8 ? 'PENDING' : 'AUTO_PASSED', dataQualityIssues
    };
  });

  const pageChecks = Array.isArray(raw.pageChecks) ? raw.pageChecks : [];
  const isPageSlice = Boolean(options.isPageSlice);
  // Free-form model comments are intentionally not exposed as lawyer review tasks. They are often
  // speculative or self-contradictory; only the structured fields and deterministic checks below
  // may create actionable warnings.
  const warnings: string[] = [];
  for (const transaction of transactions) {
    const location = `第 ${transaction.rawPageNumber} 页第 ${transaction.rawRowIndex} 笔`;
    if (transaction.dataQualityIssues.includes('INVALID_DATE')) warnings.push(`${location}交易日期无法确认，已保留原始行并列入待核对`);
    if (transaction.dataQualityIssues.includes('INVALID_AMOUNT')) warnings.push(`${location}交易金额无法确认，已保留原始行并列入待核对`);
    if (transaction.dataQualityIssues.includes('UNKNOWN_DIRECTION')) warnings.push(`${location}收支方向无法确认，未计入收入或支出汇总`);
  }
  const checkedPages = new Set([
    ...pageChecks.map(page => positiveInteger(page.pageNumber)).filter(Boolean),
    ...transactions.map(transaction => Number(transaction.rawPageNumber) - options.pageStart + 1).filter(Boolean)
  ]);
  const missingPages = Array.from({ length: expectedPages }, (_, index) => index + 1).filter(page => !checkedPages.has(page));
  if (missingPages.length) {
    if (expectedPages === 1 && transactions.length === 0) {
      warnings.push(`原PDF第 ${options.pageStart} 页未识别到交易且缺少页面汇总，系统按疑似空白/扫描残页继续；律师需对照原件确认`);
    } else {
      throw new Error(`逐页检查不完整，缺少当前分段内第 ${missingPages.join('、')} 页`);
    }
  } else if (!pageChecks.length && transactions.length > 0) {
    warnings.push(`缺少页面汇总，系统已依据 ${transactions.length} 笔逐笔明细的页码确认页面覆盖`);
  }
  const pageCheckTotal = pageChecks.reduce((sum, page) => sum + nonNegativeInteger(page.transactionCount), 0);
  const pageQuality = Array.from({ length: expectedPages }, (_, index) => {
    const localPage = index + 1;
    const reportedCount = pageChecks
      .filter(page => positiveInteger(page.pageNumber) === localPage)
      .reduce((sum, page) => sum + nonNegativeInteger(page.transactionCount), 0);
    const independentCount = expectedPages === 1 ? options.independentCount : undefined;
    const expectedCount = Math.max(reportedCount, independentCount ?? 0);
    const extractedCount = transactions.filter(transaction => Number(transaction.rawPageNumber) === options.pageStart + index).length;
    const reportedType = normalizePageType(pageChecks.find(page => positiveInteger(page.pageNumber) === localPage)?.pageType);
    const pageType = expectedPages === 1 ? options.independentPageType || reportedType : reportedType;
    const nonTransactionPage = pageType === 'ACCOUNT_INFO' || pageType === 'DOCUMENT' || pageType === 'BLANK';
    return {
      page: options.pageStart + index,
      expectedCount: independentCount ?? reportedCount,
      extractedCount,
      pageType,
      status: isPageSlice ? 'COMPLETE' as const
        : (nonTransactionPage && extractedCount === 0) ? 'COMPLETE' as const
        : independentCount !== undefined
          ? (independentCount !== extractedCount ? 'NEEDS_REVIEW' as const : 'COMPLETE' as const)
          : (reportedCount !== extractedCount ? 'NEEDS_REVIEW' as const : 'COMPLETE' as const)
    };
  });
  const independentlyNonTransaction = options.independentPageType === 'ACCOUNT_INFO'
    || options.independentPageType === 'DOCUMENT' || options.independentPageType === 'BLANK';
  if (!isPageSlice && options.independentCount === undefined && !independentlyNonTransaction) warnings.push(`第 ${options.pageStart} 页未完成独立行数复核，需对照原件确认`);
  else if (!isPageSlice && !independentlyNonTransaction && options.independentCount !== transactions.length) warnings.push(`第 ${options.pageStart} 页独立清点为 ${options.independentCount} 笔，逐笔明细为 ${transactions.length} 笔，需对照原件确认`);
  const hasInvalidStructuredRow = transactions.some(transaction => transaction.dataQualityIssues.length > 0
    || transaction.extractionConfidence < 0.8);
  if (!isPageSlice && options.independentReadability === 'UNCERTAIN'
    && (options.independentCount !== transactions.length || hasInvalidStructuredRow)) {
    warnings.push(`第 ${options.pageStart} 页原件清晰度不足且存在字段或笔数异常，需对照原件核对`);
  }
  if (!isPageSlice && options.independentReadability === 'BLANK' && transactions.length) warnings.push(`第 ${options.pageStart} 页空白判定与逐笔明细矛盾，需对照原件确认`);
  const independentConfirmsExtracted = expectedPages === 1
    && options.independentCount === transactions.length;
  if (!isPageSlice && !independentConfirmsExtracted && pageCheckTotal > transactions.length) {
    warnings.push(`第 ${options.pageStart}${options.pageEnd > options.pageStart ? `–${options.pageEnd}` : ''} 页页面汇总为 ${pageCheckTotal} 笔，当前逐笔明细为 ${transactions.length} 笔，少 ${pageCheckTotal - transactions.length} 笔；需对照原件复核`);
  }

  if (!isPageSlice && !independentConfirmsExtracted && pageCheckTotal < transactions.length) {
    warnings.push(`第 ${options.pageStart}${options.pageEnd > options.pageStart ? `–${options.pageEnd}` : ''} 页页面汇总为 ${pageCheckTotal} 笔，逐笔明细实际为 ${transactions.length} 笔；系统已保留全部明细并按页码重新计数`);
  }

  const dates = transactions.map(item => item.transactionDate).sort();
  const totalIn = transactions.filter(item => item.direction === 'IN').reduce((sum, item) => sum + item.amount, 0);
  const totalOut = transactions.filter(item => item.direction === 'OUT').reduce((sum, item) => sum + item.amount, 0);
  const balances = transactions.filter(item => item.balanceAvailable).map(item => item.balance);
  const coveredPages = Array.from({ length: expectedPages }, (_, index) => options.pageStart + index);
  return {
    model,
    pageCount: expectedPages,
    coveredPages,
    pageStart: options.pageStart,
    pageEnd: options.pageEnd,
    totalPages: options.totalPages,
    expectedTransactionCount: isPageSlice ? transactions.length : Math.max(pageCheckTotal, options.independentCount ?? 0, transactions.length),
    countComplete: isPageSlice || pageQuality.every(page => page.status === 'COMPLETE'),
    usageTokens: options.usageTokens,
    pageQuality,
    warnings,
    account: {
      accountNumber, accountName, bankName, ownerType: 'DEBTOR_MAIN', fileName: options.sourceFileName, fileType: 'pdf',
      totalIn, totalOut, transactionCount: transactions.length, startDate: dates[0] || '', endDate: dates[dates.length - 1] || '',
      startBalance: signedMoney(document.startBalance), endBalance: signedMoney(document.endBalance ?? balances[balances.length - 1]),
      isBalanced: false, balanceDiff: 0, balanceAvailable: balances.length > 0
    },
    transactions
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
async function fileDataUrl(file: File): Promise<string> {
  const mimeType = file.type || 'image/jpeg';
  return `data:${mimeType};base64,${arrayBufferToBase64(await file.arrayBuffer())}`;
}
function cleanText(value: unknown): string { return value == null ? '' : String(value).trim(); }
function money(value: unknown): number { return Math.abs(signedMoney(value)); }
function signedMoney(value: unknown): number {
  if (value == null || value === '') return 0;
  const original = String(value).trim();
  const negative = /^[-−]/.test(original) || /^[（(].*[）)]$/.test(original);
  const parsed = Number(original.replace(/[,，￥¥\s()（）−]/g, '').replace(/^\+/, ''));
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -Math.abs(parsed) : parsed;
}
function positiveInteger(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
function nonNegativeInteger(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
function confidence(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.75;
}
function isValidMoney(value: unknown): boolean {
  if (value == null || value === '') return false;
  const parsed = Number(String(value).trim().replace(/[,，￥¥\s()（）−]/g, '').replace(/^\+/, ''));
  return Number.isFinite(parsed);
}
function normalizeDirection(value: unknown): 'IN' | 'OUT' | 'UNKNOWN' {
  const normalized = cleanText(value).toUpperCase();
  if (/^(IN|收入|转入|贷方|贷)$/.test(normalized)) return 'IN';
  if (/^(OUT|支出|转出|借方|借)$/.test(normalized)) return 'OUT';
  return 'UNKNOWN';
}
function normalizePageType(value: unknown): PageType {
  const normalized = cleanText(value).toUpperCase();
  if (/^(TRANSACTIONS|交易明细|流水)$/.test(normalized)) return 'TRANSACTIONS';
  if (/^(ACCOUNT_INFO|账户信息|开户信息|账户清单|余额查询)$/.test(normalized)) return 'ACCOUNT_INFO';
  if (/^(DOCUMENT|文书|法院文书|银行文书)$/.test(normalized)) return 'DOCUMENT';
  if (/^(BLANK|空白)$/.test(normalized)) return 'BLANK';
  return 'UNKNOWN';
}
function normalizeDateTime(value: unknown): string {
  const text = cleanText(value).replace(/[年/.]/g, '-').replace('月', '-').replace('日', ' ');
  const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!match) return '';
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  return match[4] ? `${date} ${match[4].padStart(2, '0')}:${match[5].padStart(2, '0')}:${(match[6] || '00').padStart(2, '0')}` : date;
}
function normalizeDate(value: unknown): string { return normalizeDateTime(value).slice(0, 10); }
