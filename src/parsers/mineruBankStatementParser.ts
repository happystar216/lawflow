import { BankAccount, FlowDirection, StandardTransaction } from '../types/transaction';
import { extractPdfStructureWithMinerU, MinerUProgress } from './mineruPdfParser';
import { MinerUStructuredBlock, MinerUStructuredDocument } from './mineruResultParser';
import { mergeQwenChunkResults, QwenChunkResult } from './qwenResultMerger';
import { preserveExtraction } from '../recognition/decisionPolicy';
import { selectPageCandidate } from '../recognition/pageCandidates';
import { resolveDocumentOwners } from '../recognition/documentOwners';
import { buildPageContexts, buildStatementContexts, type PageContext } from '../recognition/pageContext';
import { recognitionInputKey, reusablePage, type RecognitionResumeStore } from '../recognition/resume';
import { buildStatementPlan, type StatementPagePlan } from '../recognition/statementPlan';
import { requestStatementPlan } from '../recognition/statementPlanningClient';
import { requireSourceCheck, sourceValidationRisks } from '../recognition/documentValidation';
import { canonicalBank } from '../recognition/bankEvidence';
import { isReliableAccountNumber } from '../utils/accountIdentity';

export interface MinerUDirectProgressInfo {
  statusText: string;
  totalTransactions: number;
  percent: number;
  currentBank?: string;
  isStreaming?: boolean;
}

export interface MinerUDirectOptions {
  respondentName?: string;
  sourceTotalPages?: number;
  normalizationMode?: 'PAGE' | 'DOCUMENT';
  onPageCheckpoint?: (checkpoint: MinerUPageCheckpoint) => void;
  resumeStore?: RecognitionResumeStore;
  forceFresh?: boolean;
  onResumeWarning?: (message: string) => void;
  statementPlanning?: boolean;
}

export interface MinerUPageCheckpoint {
  version: 1;
  page: number;
  source: MinerUPageContent;
  candidates: Array<{ route: 'MINERU' | 'ORIGINAL_PDF'; result: QwenChunkResult }>;
  selected: QwenChunkResult;
  context?: PageContext;
  reused?: boolean;
  statement?: StatementPagePlan;
  sourceValidation?: { status: 'COMPARED' | 'FAILED'; reasons: string[] };
}

interface MinerUPageContent {
  page: number;
  blocks: Array<{
    order: number;
    type: string;
    content: string;
    bbox?: [number, number, number, number];
  }>;
}

interface MinerUDocumentRequest {
  mode?: 'DOCUMENT' | 'PAGE';
  sourceFileName: string;
  respondentName: string;
  totalPages: number;
  pages: MinerUPageContent[];
  context?: PageContext;
}

interface ParsedTable {
  page: number;
  headers: string[];
  rows: Array<{ cells: string[]; sourceRowIndex: number }>;
  bbox?: [number, number, number, number];
}

interface ListedAccount {
  accountNumber: string;
  accountName: string;
  bankName: string;
  page: number;
  balance?: number;
}

const ACCOUNT_NUMBER_HEADERS = ['账号', '账户号', '账户号码', '本方账号', '交易账号', '客户账号', '账/卡号', '卡号'];
const ACCOUNT_NAME_HEADERS = ['姓名', '户名', '账户名称', '客户名称', '客户姓名'];
const DATE_HEADERS = ['交易日期', '交易日', '记账日期', '入账日期', '发生日期', '账务日期', '日期'];
const TIME_HEADERS = ['交易时间', '记账时间', '发生时间', '时间'];
const AMOUNT_HEADERS = ['交易金额', '发生额', '交易发生额', '金额'];
const CREDIT_HEADERS = ['贷方发生额', '贷方金额', '收入金额', '转入金额', '入账金额', '存入金额'];
const DEBIT_HEADERS = ['借方发生额', '借方金额', '支出金额', '转出金额', '付出金额', '取出金额'];
const BALANCE_HEADERS = ['账户余额', '交易后余额', '可用余额', '余额'];
const DIRECTION_HEADERS = ['借贷标志', '借贷方向', '收支方向', '交易方向', '收付标志', '交易类型'];
const COUNTERPARTY_NAME_HEADERS = ['对方户名', '对手户名', '对方名称', '对手方名称', '交易对手名称', '收款人名称', '付款人名称'];
const COUNTERPARTY_ACCOUNT_HEADERS = ['对方账号', '对手账号', '对方账户', '交易对手账号', '收款人账号', '付款人账号'];
const COUNTERPARTY_BANK_HEADERS = ['对方行名', '对方银行', '对手方银行', '对方开户行'];
const SUMMARY_HEADERS = ['交易摘要', '摘要', '用途', '交易附言', '附言', '备注', '业务摘要', '交易说明'];

export async function parsePdfWithMinerU(
  file: File,
  onProgress?: (info: MinerUDirectProgressInfo) => void,
  signal?: AbortSignal,
  options?: MinerUDirectOptions
): Promise<{ account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] }> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) throw new Error('MinerU 直接识别仅支持 PDF 文件');
  const totalPages = options?.sourceTotalPages || await pdfPageCount(file);
  onProgress?.({
    statusText: '正在把原始 PDF 提交给 MinerU…', totalTransactions: 0, percent: 1, isStreaming: true
  });
  const resume = options?.resumeStore;
  let cachedDocument: MinerUStructuredDocument | undefined;
  if (resume && !options?.forceFresh) {
    try { cachedDocument = await resume.loadDocument(); }
    catch { options?.onResumeWarning?.('无法读取上次进度，本次将从头识别；案件原有数据不受影响。'); }
  }
  assertNotAborted(signal);
  const document = cachedDocument || await extractPdfStructureWithMinerU(file, totalPages, progress => {
    onProgress?.(mineruProgress(progress, totalPages));
  }, signal);
  if (resume && !cachedDocument) {
    try { await resume.saveDocument(document); }
    catch { options?.onResumeWarning?.('浏览器无法保存识别进度。本次仍会继续，但关闭页面后可能需要从头识别。'); }
  }
  const normalizationMode = options?.normalizationMode || 'PAGE';
  onProgress?.({
    statusText: normalizationMode === 'PAGE'
      ? cachedDocument ? '已恢复文档读取结果，正在补齐尚未完成或需要复核的页面…' : '文档读取完成，正在逐页整理文字和表格…'
      : 'MinerU 已返回完整结果，正在一次性交给大模型整理…',
    totalTransactions: 0, percent: 27, isStreaming: true
  });
  const result = normalizationMode === 'DOCUMENT'
    ? await normalizeWholeMinerUDocument(
        document, file.name, options?.respondentName || '', totalPages, onProgress, signal
      )
    : await normalizeMinerUDocumentByPage(
        file, document, file.name, options?.respondentName || '', totalPages, onProgress, signal, options?.onPageCheckpoint,
        { ...options, statementPlanning: options?.statementPlanning !== false }
      );
  onProgress?.({
    statusText: `MinerU 提取及大模型整理完成，共读取 ${result.transactions.length} 笔流水`,
    totalTransactions: result.transactions.length,
    percent: 100,
    currentBank: result.account.bankName,
    isStreaming: false
  });
  return result;
}

export function parseMinerUDocumentToBankStatement(
  document: MinerUStructuredDocument,
  sourceFileName: string,
  respondentName = '',
  totalPages = Math.max(1, ...document.pages.map(page => page.page))
): { account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] } {
  const documentText = document.pages.map(page => page.text).join('\n');
  const fallbackBank = inferBankName(documentText, sourceFileName) || '待核验银行';
  const tables = document.blocks
    .filter(block => block.tableHtml)
    .map(block => parseMinerUTable(block))
    .filter((table): table is ParsedTable => Boolean(table));
  const listedAccounts = new Map<string, ListedAccount>();
  const transactions: StandardTransaction[] = [];

  for (const table of tables) {
    const schema = tableSchema(table.headers);
    if (schema.kind === 'ACCOUNT_LIST') {
      for (const row of table.rows) {
        const accountNumber = normalizeAccountNumber(cell(row.cells, schema.accountNumber));
        if (!isUsefulAccountNumber(accountNumber)) continue;
        const accountName = cleanText(cell(row.cells, schema.accountName)) || respondentName || '待核验户名';
        const rowBank = cleanText(cell(row.cells, schema.bankName));
        const bankName = usefulBankName(rowBank) || fallbackBank;
        const balance = moneyValue(cell(row.cells, schema.accountBalance));
        if (!listedAccounts.has(accountNumber)) {
          listedAccounts.set(accountNumber, {
            accountNumber, accountName, bankName, page: table.page,
            ...(balance.valid ? { balance: balance.value } : {})
          });
        }
      }
      continue;
    }
    if (schema.kind !== 'TRANSACTIONS') continue;
    for (const row of table.rows) {
      const transaction = transactionFromRow(
        table, row, schema, fallbackBank, respondentName, sourceFileName
      );
      if (transaction) transactions.push(transaction);
    }
  }

  canonicalizeListedAccounts(transactions, [...listedAccounts.values()]);
  inferMissingDirections(transactions);
  const accounts = buildAccounts(
    [...listedAccounts.values()], transactions, fallbackBank, respondentName, sourceFileName, totalPages
  );
  if (!accounts.length) {
    accounts.push(emptyDocumentAccount(fallbackBank, respondentName, sourceFileName, totalPages));
  }
  return { account: accounts[0], accounts, transactions };
}

interface ModelNormalizationResult {
  accounts?: any[];
  transactions?: any[];
  pageChecks?: any[];
  warnings?: string[];
}

export function buildMinerUWholeDocumentRequest(
  document: MinerUStructuredDocument,
  sourceFileName: string,
  respondentName: string,
  totalPages: number
): MinerUDocumentRequest {
  const blocksByPage = new Map<number, MinerUStructuredBlock[]>();
  for (const block of document.blocks) {
    blocksByPage.set(block.page, [...(blocksByPage.get(block.page) || []), block]);
  }
  const pageText = new Map(document.pages.map(page => [page.page, page.text]));
  const pages = Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    const blocks = blocksByPage.get(page) || [];
    const orderedBlocks = blocks.flatMap((block, blockIndex) => {
      const content = String(block.tableHtml || block.text || '').trim();
      if (!content) return [];
      return [{
        order: blockIndex + 1,
        type: block.tableHtml ? 'table' : (block.type || 'text'),
        content,
        ...(block.bbox ? { bbox: block.bbox } : {})
      }];
    });
    const fallbackText = String(pageText.get(page) || '').trim();
    return {
      page,
      blocks: orderedBlocks.length ? orderedBlocks : (fallbackText ? [{
        order: 1, type: 'raw_text', content: fallbackText
      }] : [])
    };
  });
  return { sourceFileName, respondentName, totalPages, pages };
}

const MINERU_PAGE_NORMALIZATION_CONCURRENCY = 2;

export async function normalizeMinerUDocumentByPage(
  sourceFile: File,
  document: MinerUStructuredDocument,
  sourceFileName: string,
  respondentName: string,
  totalPages: number,
  onProgress?: (info: MinerUDirectProgressInfo) => void,
  signal?: AbortSignal,
  onPageCheckpoint?: (checkpoint: MinerUPageCheckpoint) => void,
  options?: Pick<MinerUDirectOptions, 'resumeStore' | 'forceFresh' | 'onResumeWarning' | 'statementPlanning'>
): Promise<{ account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] }> {
  const request = buildMinerUWholeDocumentRequest(document, sourceFileName, respondentName, totalPages);
  const contextPages = request.pages.map(page => {
    const firstTable = page.blocks.findIndex(block => block.type === 'table');
    const headerBlocks = page.blocks.slice(0, firstTable < 0 ? page.blocks.length : firstTable)
      .filter(block => block.content.length <= 1000 && !/(?:\d{4}[-/]\d{2}[-/]\d{2}|\b(?:19|20)\d{2}[01]\d[0-3]\d\b)/.test(block.content));
    // Carry only explicit HTML header cells, never neighboring transaction rows.
    const tableHeaders = page.blocks.filter(block => block.type === 'table').flatMap(block => {
      const thead = block.content.match(/<thead\b[^>]*>[\s\S]*?<\/thead>/i)?.[0];
      const thRow = block.content.match(/<tr\b[^>]*>\s*<th\b[\s\S]*?<\/tr>/i)?.[0];
      const content = thead || thRow;
      return content && content.length <= 2000 ? [{ order: block.order, type: 'table_header', content }] : [];
    });
    return {
      page: page.page, ownerAccounts: explicitOwnerAccountsFromMinerUPage(page),
      bank: inferBankName(headerBlocks.map(block => block.content).join('\n'), '') || '',
      headers: [...headerBlocks.slice(0, 4), ...tableHeaders.slice(0, 2)]
    };
  });
  let statements: Map<number, StatementPagePlan> | undefined;
  if (options?.statementPlanning) {
    onProgress?.({ statusText: '正在分析账单边界和续页关系…', percent: 27, totalTransactions: 0, isStreaming: true });
    const descriptors = await requestStatementPlan(request.pages, {
      signal, resumeStore: options.resumeStore, forceFresh: options.forceFresh, onWarning: options.onResumeWarning,
      onProgress: completed => onProgress?.({ statusText: `已分析 ${completed}/${totalPages} 页的账单边界`,
        percent: 27 + Math.floor(Math.min(completed, totalPages) / Math.max(1, totalPages) * 8),
        totalTransactions: 0, isStreaming: true })
    });
    for (const descriptor of descriptors) {
      const printed = contextPages.find(page => page.page === descriptor.page)!;
      const proposed = descriptor.accounts.map(account => account.value.replace(/[\s-]/g, ''));
      const bankKey = canonicalBank;
      if ((printed.ownerAccounts.length && proposed.length && (printed.ownerAccounts.length !== proposed.length
        || printed.ownerAccounts.some(number => !proposed.includes(number))))
        || (printed.bank && descriptor.bank && bankKey(printed.bank) !== bankKey(descriptor.bank.value))) {
        descriptor.relation = 'UNKNOWN';
        descriptor.issues.push('分组判断与本页明确账号或银行抬头冲突，已停止跨页关联');
      }
    }
    statements = buildStatementPlan(descriptors, totalPages);
  }
  const contexts = statements ? buildStatementContexts(statements, contextPages) : buildPageContexts(contextPages);
  const pageTextByNumber = new Map(document.pages.map(page => [page.page, page.text]));
  const plans = await Promise.all(request.pages.map(async page => {
    const context = contexts.get(page.page);
    const statement = statements?.get(page.page);
    const inputKey = options?.resumeStore ? await recognitionInputKey({ page, context, statement,
      sourcePageText: pageTextByNumber.get(page.page) || '', totalPages, sourceFileName, respondentName }) : '';
    let cached: MinerUPageCheckpoint | undefined;
    if (options?.resumeStore && !options.forceFresh) {
      try { cached = await options.resumeStore.loadPage(page.page, inputKey); }
      catch { options.onResumeWarning?.('无法读取部分页面的进度，相关页面会重新识别。'); }
    }
    return { page, context, statement, inputKey, cached: reusablePage(cached, page.page) ? cached : undefined, strategy: mineruPageStrategy(page) };
  }));
  const fallbackPages = plans
    .filter(plan => !plan.cached && (plan.strategy === 'ORIGINAL_PDF' || plan.strategy === 'MODEL_AND_ORIGINAL_PDF'))
    .map(plan => plan.page.page);
  const fallbackFiles = fallbackPages.length
    ? await createOriginalPageFiles(sourceFile, fallbackPages)
    : new Map<number, File>();
  const checkpoints: MinerUPageCheckpoint[] = [];
  let cursor = 0;
  let completed = 0;
  let totalTransactions = 0;

  const report = (page: number, status: string) => onProgress?.({
    statusText: `${status}（${completed}/${totalPages} 页），累计 ${totalTransactions} 笔流水`,
    totalTransactions,
    percent: Math.min(90, 35 + Math.floor(completed / Math.max(1, totalPages) * 55)),
    currentBank: `第 ${page} 页`,
    isStreaming: true
  });

  const worker = async () => {
    while (true) {
      assertNotAborted(signal);
      const index = cursor++;
      if (index >= plans.length) return;
      const plan = plans[index];
      if (plan.cached) {
        const checkpoint = { ...structuredClone(plan.cached), reused: true };
        checkpoints.push(checkpoint);
        onPageCheckpoint?.(checkpoint);
        completed += 1;
        totalTransactions += checkpoint.selected.transactions.length;
        report(plan.page.page, `已恢复第 ${plan.page.page} 页`);
        continue;
      }
      const candidates: MinerUPageCheckpoint['candidates'] = [];
      let result: QwenChunkResult;
      if (plan.strategy === 'BLANK') {
        result = emptyMinerUPageResult(plan.page.page, totalPages, sourceFileName, respondentName);
      } else if (plan.strategy === 'MODEL_AND_ORIGINAL_PDF') {
        const fallback = fallbackFiles.get(plan.page.page);
        const [modelAttempt, originalAttempt] = await Promise.all([
          attemptPageResult(requestMinerUPageWithRetry(
            { ...request, mode: 'PAGE', pages: [plan.page], context: plan.context }, plan.page.page, sourceFileName,
            respondentName, totalPages, signal
          ), signal),
          fallback
            ? attemptPageResult(requestOriginalPdfPage(
                fallback, plan.page.page, totalPages, sourceFileName, respondentName, signal
              ), signal)
            : Promise.resolve<{ result?: QwenChunkResult; error?: unknown }>({
                error: new Error('未能生成原PDF单页补救文件')
              })
        ]);
        if (modelAttempt.result) candidates.push({ route: 'MINERU', result: structuredClone(modelAttempt.result) });
        if (originalAttempt.result) candidates.push({ route: 'ORIGINAL_PDF', result: structuredClone(originalAttempt.result) });
        if (modelAttempt.result && originalAttempt.result) {
          result = selectPageCandidate(modelAttempt.result, originalAttempt.result, plan.page.page, true);
        } else if (modelAttempt.result || originalAttempt.result) {
          result = addPageRecoveryWarning(
            (modelAttempt.result || originalAttempt.result)!, plan.page.page,
            modelAttempt.error || originalAttempt.error
          );
        } else {
          result = failedMinerUPageResult(
            plan.page.page, totalPages, sourceFileName, respondentName,
            originalAttempt.error || modelAttempt.error || new Error('MinerU 与原PDF均未能读取本页')
          );
        }
      } else if (plan.strategy === 'ORIGINAL_PDF') {
        const fallback = fallbackFiles.get(plan.page.page);
        result = fallback
          ? await requestOriginalPdfPage(fallback, plan.page.page, totalPages, sourceFileName, respondentName, signal)
              .catch(error => recoverPageFailure(
                error, signal, plan.page.page, totalPages, sourceFileName, respondentName
              ))
          : failedMinerUPageResult(
              plan.page.page, totalPages, sourceFileName, respondentName, new Error('未能生成原PDF单页补救文件')
            );
      } else {
        result = await requestMinerUPageWithRetry(
          { ...request, mode: 'PAGE', pages: [plan.page], context: plan.context }, plan.page.page, sourceFileName,
          respondentName, totalPages, signal
        ).catch(error => recoverPageFailure(
          error, signal, plan.page.page, totalPages, sourceFileName, respondentName
        ));
      }
      if (!candidates.length) candidates.push({
        route: plan.strategy === 'ORIGINAL_PDF' ? 'ORIGINAL_PDF' : 'MINERU', result: structuredClone(result)
      });
      result = { ...result, transactions: result.transactions.map(preserveExtraction) };
      const sourcePage = {
        ...plan.page,
        blocks: [
          ...plan.page.blocks,
          ...((pageTextByNumber.get(plan.page.page) || '').trim() ? [{
            order: plan.page.blocks.length + 1,
            type: 'source_page_text',
            content: pageTextByNumber.get(plan.page.page) || ''
          }] : [])
        ]
      };
      // OCR text is another observation, not an authority over a PDF reading.
      if (!candidates.some(candidate => candidate.route === 'ORIGINAL_PDF')) result = anchorPageResultToMinerUOwner(result, sourcePage);
      if (plan.context?.basis === 'PROPOSED_CONTINUATION'
        && result.transactions.some(row => !isReliableAccountNumber(row.accountNumber))) {
        const reference = plan.context.references[0];
        result.warnings = [...(result.warnings || []),
          `第 ${plan.page.page} 页未明确列出本方账号，可能续接第 ${reference.page} 页（账号 ${reference.matchedAccountNumbers[0]}）。请对照两页的打印页码和表头确认归属；系统未据此改写流水账号。`];
      }
      if (plan.statement?.descriptor.issues.length) result.warnings = [...(result.warnings || []),
        `第 ${plan.page.page} 页账单分组提示：${plan.statement.descriptor.issues.join('；')}。本页流水仍独立读取。`];
      const checkpoint: MinerUPageCheckpoint = { version: 1, page: plan.page.page, source: sourcePage,
        context: plan.context, statement: plan.statement, candidates, selected: structuredClone(result) };
      checkpoints.push(checkpoint);
      if (options?.resumeStore) {
        try { await options.resumeStore.savePage(checkpoint, plan.inputKey); }
        catch { options.onResumeWarning?.('浏览器无法保存部分页面的进度。本次仍会继续，重试时这些页面可能需要重新识别。'); }
      }
      onPageCheckpoint?.(checkpoint);
      completed += 1;
      totalTransactions += result.transactions.length;
      report(
        plan.page.page,
        plan.strategy === 'ORIGINAL_PDF' || plan.strategy === 'MODEL_AND_ORIGINAL_PDF'
          ? `已补识别第 ${plan.page.page} 页`
          : `已整理第 ${plan.page.page} 页`
      );
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(MINERU_PAGE_NORMALIZATION_CONCURRENCY, plans.length) }, () => worker()
  ));
  assertNotAborted(signal);
  // A structurally complete OCR table can still contain wrong digits. Validate
  // the full document before accepting it and reread only suspect source pages.
  const risks = sourceValidationRisks(checkpoints);
  const resolved = resolveDocumentOwners(checkpoints);
  const identityPages = new Set(checkpoints.filter((_checkpoint, i) => resolved[i].transactions.some(row =>
    row.candidateReview?.kind === 'SOURCE_CHECK' && (row.candidateReview.differences.some(item => item.field === 'accountNumber')
      || row.candidateReview.requiredFields?.includes('accountNumber')))).map(checkpoint => checkpoint.page));
  const suspect = checkpoints.filter(checkpoint => (risks.has(checkpoint.page) || identityPages.has(checkpoint.page))
    && !checkpoint.candidates.some(candidate => candidate.route === 'ORIGINAL_PDF') && !checkpoint.sourceValidation);
  let verificationFiles = new Map<number, File>();
  if (suspect.length) {
    report(0, `正在对照原PDF复核 ${suspect.length} 页的数字或账号`);
    try { verificationFiles = await createOriginalPageFiles(sourceFile, suspect.map(checkpoint => checkpoint.page)); }
    catch (error) { assertNotAborted(signal); options?.onResumeWarning?.('无法准备原页复核，疑点将保留供人工核对。'); }
  }
  let verifyCursor = 0;
  let verified = 0;
  await Promise.all(Array.from({ length: Math.min(MINERU_PAGE_NORMALIZATION_CONCURRENCY, suspect.length) }, async () => {
    while (verifyCursor < suspect.length) {
      assertNotAborted(signal);
      const checkpoint = suspect[verifyCursor++];
      const file = verificationFiles.get(checkpoint.page);
      const attempt = file ? await attemptPageResult(requestOriginalPdfPage(file, checkpoint.page, totalPages,
        sourceFileName, respondentName, signal), signal) : { error: new Error('无法读取原PDF页') };
      const reasons = [...new Set(risks.get(checkpoint.page)?.values() || [])];
      if (identityPages.has(checkpoint.page)) reasons.push('本方账号存在不同读法，直接查看原页确认');
      if (attempt.result) {
        checkpoint.candidates.push({ route: 'ORIGINAL_PDF', result: structuredClone(attempt.result) });
        const previousCount = checkpoint.selected.transactions.length;
        checkpoint.selected = selectPageCandidate(checkpoint.selected, attempt.result, checkpoint.page);
        totalTransactions += checkpoint.selected.transactions.length - previousCount;
      }
      checkpoint.sourceValidation = { status: attempt.result ? 'COMPARED' : 'FAILED', reasons };
      // Agreement between two readings does not explain a remaining arithmetic
      // discontinuity. Keep the precise rows pending; never repair their values.
      const remaining = sourceValidationRisks([checkpoint]).get(checkpoint.page);
      for (const row of checkpoint.selected.transactions) {
        const reason = remaining?.get(row.id);
        if (reason) requireSourceCheck(row, ['amount', 'direction', 'balance'], reason);
      }
      if (!attempt.result) checkpoint.selected.warnings = [...(checkpoint.selected.warnings || []),
        `第 ${checkpoint.page} 页原页复核未完成：${attempt.error instanceof Error ? attempt.error.message.slice(0, 200) : '服务未返回结果'}。已有识别保留，疑点未自动通过。`];
      const plan = plans.find(plan => plan.page.page === checkpoint.page)!;
      if (options?.resumeStore) {
        try { await options.resumeStore.savePage(checkpoint, plan.inputKey); }
        catch { options.onResumeWarning?.('原页复核结果未能保存，下次可能需要重新复核。'); }
      }
      onPageCheckpoint?.(structuredClone(checkpoint));
      verified++;
      onProgress?.({
        statusText: `已复核原页 ${verified}/${suspect.length}（${completed}/${totalPages} 页），累计 ${totalTransactions} 笔流水`,
        totalTransactions,
        percent: 90 + Math.floor(verified / suspect.length * 9),
        currentBank: `第 ${checkpoint.page} 页`,
        isStreaming: true
      });
    }
  }));
  assertNotAborted(signal);
  return mergeQwenChunkResults(resolveDocumentOwners(checkpoints), sourceFileName, totalPages);
}

function mineruPageStrategy(page: MinerUPageContent): 'MODEL' | 'ORIGINAL_PDF' | 'MODEL_AND_ORIGINAL_PDF' | 'BLANK' {
  const text = page.blocks.map(block => block.content).join('\n').trim();
  const tableBlocks = page.blocks.filter(block => block.type === 'table');
  if (!tableBlocks.length && /Ground Truth image|OCR result should be empty|UNDERSCORE\s*&\s*LINE RULES/i.test(text)) {
    return 'BLANK';
  }
  if (!tableBlocks.length && (
    !text
    || /无法识别/.test(text)
    || /^\s*[{}]\s*$/.test(text)
    || /\\therefore|\b1\.\s*2\.\s*3\.\s*4\.\s*5\./i.test(text)
  )) return 'ORIGINAL_PDF';
  if (tableBlocks.some(block => isStructurallyDamagedTransactionTable(block.content))) return 'MODEL_AND_ORIGINAL_PDF';
  return 'MODEL';
}

function isStructurallyDamagedTransactionTable(tableHtml: string): boolean {
  if (!/交易日期|记账日期|交易金额|发生额/.test(tableHtml)) return false;
  // MinerU occasionally collapses the remainder of a dense ledger into one
  // very wide cell. Sending that HTML to the organizer silently loses every
  // following row, so this page must be reread from the original PDF image.
  return [...tableHtml.matchAll(/<td\b[^>]*\bcolspan\s*=\s*["']?(\d+)/gi)]
    .some(match => Number(match[1]) >= 4);
}


async function attemptPageResult(
  promise: Promise<QwenChunkResult>, signal?: AbortSignal
): Promise<{ result?: QwenChunkResult; error?: unknown }> {
  try {
    return { result: await promise };
  } catch (error) {
    assertNotAborted(signal);
    return { error };
  }
}


function addPageRecoveryWarning(result: QwenChunkResult, page: number, error: unknown): QwenChunkResult {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return {
    ...result,
    warnings: [...new Set([...(result.warnings || []), `第 ${page} 页双路读取有一路失败：${message}；已保留可用结果并列为待核对`])],
    countComplete: false,
    pageQuality: [{
      page,
      expectedCount: Number.NaN,
      extractedCount: result.transactions.length,
      status: 'NEEDS_REVIEW',
      pageType: 'TRANSACTIONS'
    }]
  };
}

async function requestMinerUPageWithRetry(
  request: MinerUDocumentRequest,
  page: number,
  sourceFileName: string,
  respondentName: string,
  totalPages: number,
  signal?: AbortSignal
): Promise<QwenChunkResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertNotAborted(signal);
      const response = await fetch('/api/normalize-mineru-result', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request)
      });
      if (!response.ok) throw apiError(await responseJson(response), `第 ${page} 页 MinerU 结果整理失败`);
      const payload = response.headers.get('content-type')?.includes('text/event-stream')
        ? await readMinerUNormalizationStream(response)
        : await responseJson(response);
      return mineruModelPageResult(
        payload, page, sourceFileName, respondentName, totalPages, request.pages[0]
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      lastError = error;
      if (attempt === 0) await delay(1_000, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || `第 ${page} 页整理失败`));
}

function mineruModelPageResult(
  payload: ModelNormalizationResult,
  page: number,
  sourceFileName: string,
  respondentName: string,
  totalPages: number,
  sourcePage?: MinerUPageContent
): QwenChunkResult {
  const normalized: ModelNormalizationResult = {
    ...payload,
    transactions: (payload.transactions || []).map((transaction, index) => ({
      ...transaction, p: page, r: positiveInteger(transaction?.r ?? transaction?.row) || index + 1
    })),
    pageChecks: (payload.pageChecks || []).slice(0, 1).map(check => ({ ...check, p: page }))
  };
  const parsed = parseMinerUWholeModelResult(
    normalized, sourceFileName, respondentName, totalPages, { expectedPages: [page] }
  );
  const check = normalized.pageChecks?.[0];
  const expected = Math.max(0, Number(check?.extracted ?? check?.transactionCount) || parsed.transactions.length);
  const status = cleanText(check?.status).toUpperCase() === 'NEEDS_REVIEW' || expected !== parsed.transactions.length
    ? 'NEEDS_REVIEW' as const : 'COMPLETE' as const;
  const pageType = cleanText(check?.type ?? check?.pageType).toUpperCase() || (parsed.transactions.length ? 'TRANSACTIONS' : 'UNKNOWN');
  const warnings = [...new Set([
    ...(payload.warnings || []).map(cleanText).filter(Boolean),
    ...(status === 'NEEDS_REVIEW' ? [`第 ${page} 页需要核对：${cleanText(check?.note) || 'MinerU 单页结构可能不完整'}`] : [])
  ])];
  return {
    account: parsed.account,
    accounts: parsed.accounts,
    transactions: parsed.transactions,
    warnings,
    coveredPages: [page], pageStart: page, pageEnd: page, totalPages,
    expectedTransactionCount: expected,
    countComplete: status === 'COMPLETE',
    pageQuality: [{
      page, expectedCount: expected, extractedCount: parsed.transactions.length, status,
      pageType: pageType as NonNullable<QwenChunkResult['pageQuality']>[number]['pageType']
    }]
  };
}

function explicitOwnerAccountsFromMinerUPage(page: MinerUPageContent): string[] {
  const accounts = new Set<string>();
  for (const block of page.blocks) {
    if (block.type === 'table') {
      const table = parseMinerUTable({
        page: page.page,
        type: 'table',
        text: '',
        tableHtml: block.content,
        bbox: block.bbox
      });
      if (!table) continue;
      const schema = tableSchema(table.headers);
      if (schema.kind !== 'TRANSACTIONS' || schema.accountNumber < 0) continue;
      for (const row of table.rows) {
        const accountNumber = normalizeAccountNumber(cell(row.cells, schema.accountNumber));
        if (isUsefulAccountNumber(accountNumber)) accounts.add(accountNumber);
      }
      continue;
    }
    const searchableText = block.content
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;|&#160;/gi, ' ');
    for (const match of searchableText.matchAll(
      /(?:^|[\n\r])[ \t]*(?:账\/卡号|本方账号|客户账号|交易账号|账户号(?:码)?|账号)[ \t]*[:：]?[ \t]*([A-Za-z0-9 \t\-_—–·•]{8,40})/g
    )) {
      const accountNumber = normalizeAccountNumber(match[1]);
      if (isUsefulAccountNumber(accountNumber)) accounts.add(accountNumber);
    }
  }
  return [...accounts];
}

function anchorPageResultToMinerUOwner(
  result: QwenChunkResult,
  sourcePage: MinerUPageContent
): QwenChunkResult {
  const sourceAccounts = explicitOwnerAccountsFromMinerUPage(sourcePage);
  if (sourceAccounts.length !== 1) return result;

  const accountNumber = sourceAccounts[0];
  const sourceText = sourcePage.blocks.filter(block => block.type !== 'table' && block.type !== 'source_page_text')
    .map(block => block.content).join('\n');
  const matchingAccount = (result.accounts || [result.account]).find(account => account.accountNumber === accountNumber);
  const bankName = usefulBankName(inferBankName(sourceText, ''))
    || usefulBankName(matchingAccount?.bankName || '')
    || '待核验银行';
  const account: BankAccount = {
    ...result.account,
    accountNumber,
    bankName,
    coveredPages: [sourcePage.page]
  };
  const transactions = result.transactions.map(transaction => ({
    ...transaction,
    accountNumber,
    bankName,
    fieldEvidence: {
      ...(transaction.fieldEvidence || {}),
      accountNumber: {
        originalValue: transaction.fieldEvidence?.accountNumber?.originalValue ?? transaction.accountNumber,
        currentValue: accountNumber,
        confidence: 1,
        origin: transaction.accountNumber === accountNumber ? 'EXTRACTION' as const : 'AUTO_NORMALIZATION' as const,
        decision: transaction.accountNumber === accountNumber ? 'ACCEPTED' as const : 'SUGGESTED' as const,
        reason: transaction.accountNumber === accountNumber
          ? '与 MinerU 页面中的明确本方账号一致'
          : '按 MinerU 页面中的明确本方账号纠正'
      }
    }
  }));
  // A disagreeing printed header may itself be misread. Do not overwrite an
  // already explicit model account; expose the account field for source review.
  for (let index = 0; index < transactions.length; index++) {
    const original = result.transactions[index];
    if (!isReliableAccountNumber(original.accountNumber) || original.accountNumber === accountNumber) continue;
    transactions[index] = preserveExtraction(original) as typeof transactions[number];
    requireSourceCheck(transactions[index], ['accountNumber'],
      `本方账号读取为“${original.accountNumber}”，页面文字读法为“${accountNumber}”。请对照原件账号栏确认，未按文字结果覆盖。`);
  }
  if (transactions.some(transaction => transaction.accountNumber !== accountNumber)) return { ...result, transactions };
  return {
    ...result,
    account,
    accounts: [account],
    transactions
  };
}

async function createOriginalPageFiles(sourceFile: File, pages: number[]): Promise<Map<number, File>> {
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(await sourceFile.arrayBuffer(), { ignoreEncryption: true });
  const files = new Map<number, File>();
  for (const page of pages) {
    if (page < 1 || page > source.getPageCount()) continue;
    const target = await PDFDocument.create();
    const [copied] = await target.copyPages(source, [page - 1]);
    target.addPage(copied);
    const bytes = await target.save({ useObjectStreams: true });
    files.set(page, new File(
      [Uint8Array.from(bytes).buffer],
      `${sourceFile.name.replace(/\.pdf$/i, '')}__补识别_第${page}页.pdf`,
      { type: 'application/pdf', lastModified: sourceFile.lastModified }
    ));
  }
  return files;
}

export async function requestOriginalPdfPage(
  file: File, page: number, totalPages: number, sourceFileName: string, respondentName: string, signal?: AbortSignal
): Promise<QwenChunkResult> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  const timeout = setTimeout(() => controller.abort(new Error(`第 ${page} 页原页复核超时（180秒），请重试或人工核对`)), 180_000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try { return await readOriginalPdfPage(file, page, totalPages, sourceFileName, respondentName, controller.signal); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

async function readOriginalPdfPage(
  file: File,
  page: number,
  totalPages: number,
  sourceFileName: string,
  respondentName: string,
  signal?: AbortSignal
): Promise<QwenChunkResult> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('sourceFileName', sourceFileName);
  formData.append('respondentName', respondentName);
  formData.append('pageStart', String(page));
  formData.append('pageEnd', String(page));
  formData.append('totalPages', String(totalPages));
  formData.append('chunkId', `MINERU_FALLBACK_P${page}`);
  formData.append('isPageSlice', 'true');
  formData.append('verificationMode', 'always');
  const response = await fetch('/api/parse-bank-statement-stream', { method: 'POST', body: formData, signal });
  if (!response.ok) throw new Error(`第 ${page} 页原PDF补识别服务异常（${response.status}）`);
  if (!response.body) throw new Error(`第 ${page} 页原PDF补识别连接不可读`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: QwenChunkResult | undefined;
  let streamError: any;
  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    const event = JSON.parse(data);
    if (event?.type === 'complete') completed = event as QwenChunkResult;
    if (event?.type === 'error') streamError = event;
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : lines.pop() || '';
    lines.forEach(consumeLine);
    if (done) break;
  }
  if (buffer.trim()) consumeLine(buffer);
  if (streamError) {
    const error = new Error(String(streamError.message || `第 ${page} 页原PDF补识别失败`));
    Object.assign(error, {
      diagnosticCode: streamError.diagnosticCode,
      diagnosis: streamError.diagnostics ? JSON.stringify(streamError.diagnostics) : undefined
    });
    throw error;
  }
  if (!completed?.account || !Array.isArray(completed.transactions)) {
    throw new Error(`第 ${page} 页原PDF补识别未返回完整结果`);
  }
  const isGenericReviewWarning = (warning: string) =>
    cleanText(warning) === '智能识别结果须由律师对照原件复核';
  const normalizeAccount = (account: QwenChunkResult['account']) => ({
    ...account,
    fileName: sourceFileName,
    totalPages,
    parseWarnings: (account.parseWarnings || []).filter(warning => !isGenericReviewWarning(warning))
  });
  return {
    ...completed,
    account: normalizeAccount(completed.account),
    warnings: (completed.warnings || []).filter(warning => !isGenericReviewWarning(warning)),
    coveredPages: [page], pageStart: page, pageEnd: page, totalPages,
    accounts: completed.accounts?.map(normalizeAccount),
    transactions: completed.transactions.map(transaction => ({
      ...transaction, rawSourceFile: sourceFileName, sourceFileName, rawPageNumber: page
    }))
  };
}

function emptyMinerUPageResult(
  page: number, totalPages: number, sourceFileName: string, respondentName: string
): QwenChunkResult {
  return {
    account: pagePlaceholderAccount(page, totalPages, sourceFileName, respondentName),
    accounts: [], transactions: [], warnings: [], coveredPages: [page],
    pageStart: page, pageEnd: page, totalPages, expectedTransactionCount: 0, countComplete: true,
    pageQuality: [{ page, expectedCount: 0, extractedCount: 0, status: 'COMPLETE', pageType: 'BLANK' }]
  };
}

function failedMinerUPageResult(
  page: number,
  totalPages: number,
  sourceFileName: string,
  respondentName: string,
  error: unknown
): QwenChunkResult {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return {
    account: pagePlaceholderAccount(page, totalPages, sourceFileName, respondentName),
    accounts: [], transactions: [],
    warnings: [`第 ${page} 页连续识别失败：${message}；已保留为待核对页面，其他页面继续处理`],
    coveredPages: [page], pageStart: page, pageEnd: page, totalPages,
    expectedTransactionCount: 0, countComplete: false,
    pageQuality: [{ page, expectedCount: Number.NaN, extractedCount: 0, status: 'NEEDS_REVIEW', pageType: 'UNKNOWN' }]
  };
}

function recoverPageFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  page: number,
  totalPages: number,
  sourceFileName: string,
  respondentName: string
): QwenChunkResult {
  assertNotAborted(signal);
  return failedMinerUPageResult(page, totalPages, sourceFileName, respondentName, error);
}

function pagePlaceholderAccount(
  page: number, totalPages: number, sourceFileName: string, respondentName: string
): BankAccount {
  return {
    accountNumber: `待核验-第${page}页`, accountName: respondentName || '待核验户名', bankName: '待核验银行',
    ownerType: 'UNKNOWN', fileName: sourceFileName, fileType: 'pdf', totalIn: 0, totalOut: 0,
    transactionCount: 0, startDate: '', endDate: '', startBalance: 0, endBalance: 0,
    balanceAvailable: false, isBalanced: false, balanceDiff: 0, parseStatus: 'NEEDS_REVIEW',
    parseWarnings: [], coveredPages: [page], totalPages
  };
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('已停止', 'AbortError');
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('已停止', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function normalizeWholeMinerUDocument(
  document: MinerUStructuredDocument,
  sourceFileName: string,
  respondentName: string,
  totalPages: number,
  onProgress?: (info: MinerUDirectProgressInfo) => void,
  signal?: AbortSignal
): Promise<{ account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] }> {
  const request = buildMinerUWholeDocumentRequest(document, sourceFileName, respondentName, totalPages);
  onProgress?.({
    statusText: '正在由大模型一次性整理整份 MinerU 结果…',
    totalTransactions: 0,
    percent: 94,
    isStreaming: true
  });
  const response = await fetch('/api/normalize-mineru-result', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  if (!response.ok) {
    const payload = await responseJson(response);
    throw apiError(payload, '整份 MinerU 结果整理失败');
  }
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? await readMinerUNormalizationStream(response, onProgress)
    : await responseJson(response);
  return parseMinerUWholeModelResult(
    payload as ModelNormalizationResult,
    sourceFileName,
    respondentName,
    totalPages
  );
}

export async function readMinerUNormalizationStream(
  response: Response,
  onProgress?: (info: MinerUDirectProgressInfo) => void
): Promise<ModelNormalizationResult> {
  if (!response.body) throw new Error('整份 MinerU 结果整理连接不可读');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: ModelNormalizationResult | undefined;
  let streamError: { message: string; diagnosticCode?: string; diagnosis?: string } | undefined;

  const consumeFrame = (frame: string) => {
    const data = frame.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('');
    if (!data) return;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('整份 MinerU 结果整理进度数据无法读取');
    }
    if (event?.type === 'error') {
      streamError = {
        message: String(event.error || '整份 MinerU 结果整理失败'),
        diagnosticCode: typeof event.diagnosticCode === 'string' ? event.diagnosticCode : undefined,
        diagnosis: typeof event.diagnosis === 'string' ? event.diagnosis : undefined
      };
      return;
    }
    if (event?.type === 'complete') {
      completed = event.result as ModelNormalizationResult;
      return;
    }
    if (event?.type === 'progress') {
      const characters = Math.max(0, Number(event.generatedCharacters) || 0);
      onProgress?.({
        statusText: characters
          ? `正在整理整份识别结果，已生成 ${characters.toLocaleString()} 个字符…`
          : '正在整理整份识别结果…',
        totalTransactions: 0,
        percent: Math.min(99, 95 + Math.floor(characters / 20_000)),
        isStreaming: true
      });
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = done ? '' : frames.pop() || '';
    for (const frame of frames) consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
  if (streamError) {
    const error = new Error(streamError.message);
    Object.assign(error, {
      diagnosticCode: streamError.diagnosticCode,
      diagnosis: streamError.diagnosis
    });
    throw error;
  }
  if (!completed) throw new Error('整份 MinerU 结果整理连接提前结束，未收到完整结果');
  return completed;
}

export function parseMinerUWholeModelResult(
  result: ModelNormalizationResult,
  sourceFileName: string,
  respondentName: string,
  totalPages: number,
  options?: { expectedPages?: number[] }
): { account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] } {
  const rawAccounts = Array.isArray(result.accounts) ? result.accounts : [];
  const listed: ListedAccount[] = [];
  for (const raw of rawAccounts) {
    const accountNumber = normalizeAccountNumber(cleanText(raw?.ac ?? raw?.accountNumber));
    if (!isUsefulAccountNumber(accountNumber) || listed.some(item => item.accountNumber === accountNumber)) continue;
    listed.push({
      accountNumber,
      accountName: cleanText(raw?.holder ?? raw?.accountName) || respondentName || '待核验户名',
      bankName: usefulBankName(raw?.bk ?? raw?.bankName) || '待核验银行',
      page: positiveInteger(raw?.p ?? raw?.page) || 1
    });
  }

  const rawTransactions = Array.isArray(result.transactions) ? result.transactions : [];
  const transactions = rawTransactions.flatMap((raw, index) => {
    const page = positiveInteger(raw?.p ?? raw?.page ?? raw?.rawPageNumber);
    if (!page || page > totalPages) return [];
    const row = positiveInteger(raw?.r ?? raw?.row ?? raw?.rawRowIndex) || index + 1;
    const transactionTime = normalizeDateTime(cleanText(raw?.tm ?? raw?.transactionTime), '');
    const amount = moneyValue(cleanText(raw?.amt ?? raw?.amount));
    const rawBalance = raw?.bal ?? raw?.balance;
    const balance = rawBalance == null || cleanText(rawBalance) === ''
      ? { value: 0, valid: false }
      : moneyValue(cleanText(rawBalance));
    const rawDirection = cleanText(raw?.dir ?? raw?.direction).toUpperCase();
    const direction: FlowDirection = rawDirection === 'IN' || rawDirection === 'OUT' || rawDirection === 'UNKNOWN'
      ? rawDirection : 'UNKNOWN';
    const accountNumber = normalizeAccountNumber(cleanText(raw?.ac ?? raw?.accountNumber));
    const confidenceValue = Number(raw?.cf ?? raw?.confidence);
    const confidence = Number.isFinite(confidenceValue) ? clamp01(confidenceValue) : 0.65;
    const issues: NonNullable<StandardTransaction['dataQualityIssues']> = [];
    if (!transactionTime) issues.push('INVALID_DATE');
    if (!amount.valid) issues.push('INVALID_AMOUNT');
    if (direction === 'UNKNOWN') issues.push('UNKNOWN_DIRECTION');
    const normalizedAccount = isUsefulAccountNumber(accountNumber) ? accountNumber : `待核验账号-第${page}页`;
    const transaction: StandardTransaction = {
      id: `TX_MINERU_LLM_P${page}_R${row}_${transactionsafe(normalizedAccount)}_${index + 1}`,
      accountNumber: normalizedAccount,
      accountName: cleanText(raw?.holder ?? raw?.accountName) || respondentName || '待核验户名',
      bankName: usefulBankName(raw?.bk ?? raw?.bankName) || '待核验银行',
      transactionTime,
      transactionDate: transactionTime.slice(0, 10),
      direction,
      amount: amount.valid ? Math.abs(amount.value) : 0,
      balance: balance.valid ? balance.value : 0,
      balanceAvailable: balance.valid,
      counterpartyName: cleanText(raw?.cp ?? raw?.counterpartyName),
      counterpartyAccount: normalizeAccountNumber(cleanText(raw?.ca ?? raw?.counterpartyAccount)) || undefined,
      counterpartyBank: cleanText(raw?.cb ?? raw?.counterpartyBank) || undefined,
      summary: cleanText(raw?.sm ?? raw?.summary),
      rawSourceFile: sourceFileName,
      rawPageNumber: page,
      rawRowIndex: row,
      rawText: cleanText(raw?.src ?? raw?.rawText) || [transactionTime, direction, amount.valid ? Math.abs(amount.value) : '', cleanText(raw?.sm ?? raw?.summary)]
        .filter(value => value !== '').join(' '),
      extractionMethod: 'MINERU_DIRECT_PDF',
      extractionConfidence: confidence,
      reviewStatus: issues.length || confidence < 0.8 ? 'PENDING' : 'AUTO_PASSED',
      dataQualityIssues: issues
    };
    return [preserveExtraction(transaction)];
  });

  const pageChecks = Array.isArray(result.pageChecks) ? result.pageChecks : [];
  const warnings = [...new Set((result.warnings || []).map(cleanText).filter(Boolean))];
  const checkedPages = new Set<number>();
  const expectedPages = options?.expectedPages?.length
    ? [...new Set(options.expectedPages.filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages))]
    : Array.from({ length: totalPages }, (_, index) => index + 1);
  let declaredTransactions = 0;
  for (const check of pageChecks) {
    const page = positiveInteger(check?.p ?? check?.page);
    if (!page || page > totalPages) continue;
    checkedPages.add(page);
    declaredTransactions += Math.max(0, Number(check?.extracted ?? check?.transactionCount) || 0);
    if (cleanText(check?.status).toUpperCase() === 'NEEDS_REVIEW') {
      warnings.push(`第 ${page} 页需要核对：${cleanText(check?.note) || 'MinerU 结构可能不完整'}`);
    }
  }
  const uncheckedPages = expectedPages.filter(page => !checkedPages.has(page));
  if (uncheckedPages.length) {
    warnings.push(`大模型未返回第 ${uncheckedPages.join('、')} 页完整性检查`);
  }
  if (declaredTransactions !== transactions.length) {
    warnings.push(`逐页清点为 ${declaredTransactions} 笔，但返回了 ${transactions.length} 笔流水`);
  }
  const fallbackBank = listed.map(item => item.bankName).find(usefulBankName)
    || transactions.map(item => item.bankName).find(usefulBankName)
    || '待核验银行';
  const accounts = buildAccounts(listed, transactions, fallbackBank, respondentName, sourceFileName, totalPages);
  if (!accounts.length) accounts.push(emptyDocumentAccount(fallbackBank, respondentName, sourceFileName, totalPages));
  if (warnings.length) {
    accounts[0].parseWarnings = [...new Set([...(accounts[0].parseWarnings || []), ...warnings])];
    accounts[0].parseStatus = 'NEEDS_REVIEW';
  }
  return { account: accounts[0], accounts, transactions };
}

export function applyMinerUModelNormalization(
  draft: { account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] },
  rawAccounts: any[],
  rawTransactions: any[],
  rawWarnings: string[],
  sourceFileName: string,
  respondentName: string,
  totalPages: number
): { account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] } {
  const modelByKey = new Map<string, any>();
  const duplicateKeys = new Set<string>();
  for (const item of rawTransactions) {
    const key = cleanText(item?.sourceKey);
    if (!key || modelByKey.has(key)) {
      if (key) duplicateKeys.add(key);
      continue;
    }
    modelByKey.set(key, item);
  }
  const validKeys = new Set(draft.transactions.map(transaction => transaction.id));
  const transactions = draft.transactions.map(transaction => {
    const model = modelByKey.get(transaction.id);
    if (!model || duplicateKeys.has(transaction.id)) return { ...transaction };
    return applyModelTransaction(transaction, model);
  });
  const listed: ListedAccount[] = draft.accounts.map(account => ({
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    bankName: account.bankName,
    page: account.coveredPages?.[0] || 1,
    ...(account.balanceAvailable ? { balance: account.endBalance } : {})
  }));
  for (const raw of [...rawAccounts].sort((left, right) => modelConfidence(left) - modelConfidence(right))) {
    const accountNumber = normalizeAccountNumber(cleanText(raw?.accountNumber));
    if (!isUsefulAccountNumber(accountNumber)) continue;
    const matching = listed.filter(account => storedAccountAlias(account.accountNumber, accountNumber));
    const target = matching.length === 1 ? matching[0] : undefined;
    const normalized = {
      accountNumber: target?.accountNumber || accountNumber,
      accountName: cleanText(raw?.accountName) || target?.accountName || respondentName || '待核验户名',
      bankName: usefulBankName(raw?.bankName) || target?.bankName || '待核验银行',
      page: target?.page || 1,
      ...(target?.balance != null ? { balance: target.balance } : {})
    };
    if (target) Object.assign(target, normalized);
    else listed.push(normalized);
  }
  canonicalizeListedAccounts(transactions, listed);
  for (const transaction of transactions) {
    const account = listed.find(item => storedAccountAlias(item.accountNumber, transaction.accountNumber));
    if (account && usefulBankName(account.bankName)) transaction.bankName = account.bankName;
    if (account && account.accountName && !/待核验/.test(account.accountName)) transaction.accountName = account.accountName;
  }
  inferMissingDirections(transactions);
  const accounts = buildAccounts(listed, transactions, draft.account.bankName, respondentName, sourceFileName, totalPages);
  const missingCount = draft.transactions.filter(transaction => !modelByKey.has(transaction.id)).length;
  const extraCount = [...modelByKey.keys()].filter(key => !validKeys.has(key)).length;
  const warnings = [...new Set([
    ...rawWarnings.map(cleanText).filter(Boolean),
    ...(missingCount ? [`大模型整理时未返回 ${missingCount} 笔，系统已保留对应的 MinerU 原始结构化行`] : []),
    ...(extraCount ? [`大模型返回 ${extraCount} 个无法对应原始行的结果，系统已忽略`] : []),
    ...(duplicateKeys.size ? [`大模型重复返回 ${duplicateKeys.size} 个原始行编号，系统已保留 MinerU 原始结构化行`] : [])
  ])];
  if (warnings.length && accounts.length) {
    accounts[0].parseWarnings = [...new Set([...(accounts[0].parseWarnings || []), ...warnings])];
    accounts[0].parseStatus = 'NEEDS_REVIEW';
  }
  return { account: accounts[0], accounts, transactions };
}

function applyModelTransaction(draft: StandardTransaction, model: any): StandardTransaction {
  const modelTime = normalizeDateTime(cleanText(model?.transactionTime), '');
  const transactionTime = modelTime || draft.transactionTime;
  const modelAmount = moneyValue(cleanText(model?.amount));
  const amount = modelAmount.valid ? Math.abs(modelAmount.value) : draft.amount;
  const balance = model?.balance == null || cleanText(model?.balance) === ''
    ? { value: 0, valid: false }
    : moneyValue(cleanText(model.balance));
  const directionValue = cleanText(model?.direction).toUpperCase();
  const direction: FlowDirection = directionValue === 'IN' || directionValue === 'OUT' || directionValue === 'UNKNOWN'
    ? directionValue : draft.direction;
  const accountNumber = normalizeAccountNumber(cleanText(model?.accountNumber));
  const confidenceValue = Number(model?.confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : draft.extractionConfidence || 0.75;
  const issues: NonNullable<StandardTransaction['dataQualityIssues']> = [];
  if (!transactionTime) issues.push('INVALID_DATE');
  if (!(amount > 0) && draft.dataQualityIssues?.includes('INVALID_AMOUNT')) issues.push('INVALID_AMOUNT');
  if (direction === 'UNKNOWN') issues.push('UNKNOWN_DIRECTION');
  const next: StandardTransaction = {
    ...draft,
    bankName: usefulBankName(model?.bankName) || draft.bankName,
    accountName: cleanText(model?.accountName) || draft.accountName,
    accountNumber: isUsefulAccountNumber(accountNumber) ? accountNumber : draft.accountNumber,
    transactionTime,
    transactionDate: transactionTime.slice(0, 10),
    direction,
    amount,
    balance: balance.valid ? balance.value : draft.balance,
    balanceAvailable: balance.valid ? true : draft.balanceAvailable,
    counterpartyName: cleanText(model?.counterpartyName),
    counterpartyAccount: normalizeAccountNumber(cleanText(model?.counterpartyAccount)) || undefined,
    counterpartyBank: cleanText(model?.counterpartyBank) || undefined,
    summary: cleanText(model?.summary) || draft.summary,
    extractionConfidence: confidence,
    reviewStatus: issues.length || confidence < 0.8 ? 'PENDING' : 'AUTO_PASSED',
    dataQualityIssues: issues
  };
  if (next.amount !== draft.amount) {
    next.originalAmount = draft.amount;
    next.correctionReason = '大模型依据 MinerU 表格列重新整理交易金额';
  }
  if (next.balance !== draft.balance) {
    next.originalBalance = draft.balance;
    next.correctionReason = next.correctionReason || '大模型依据 MinerU 表格列重新整理交易余额';
  }
  if (next.direction !== draft.direction) {
    next.originalDirection = draft.direction;
    next.correctionReason = next.correctionReason || '大模型依据表头、摘要与余额关系重新整理收支方向';
  }
  return next;
}

function modelConfidence(value: any): number {
  const parsed = Number(value?.confidence);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.5;
}

async function responseJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return { error: `服务返回异常（${response.status}）` };
  }
}

function apiError(payload: any, fallback: string): Error {
  const error = new Error(String(payload?.error || fallback));
  Object.assign(error, {
    code: payload?.code,
    diagnosticCode: payload?.diagnosticCode,
    diagnosis: payload?.diagnosis
  });
  return error;
}

export function parseMinerUTableHtml(html: string): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi)) {
      const attributes = cellMatch[1] || '';
      const value = decodeHtml(cellMatch[2]);
      const colspan = Math.max(1, Math.min(100, Number(/colspan\s*=\s*["']?(\d+)/i.exec(attributes)?.[1] || 1)));
      cells.push(value, ...Array.from({ length: colspan - 1 }, () => ''));
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

function parseMinerUTable(block: MinerUStructuredBlock): ParsedTable | null {
  const grid = parseMinerUTableHtml(block.tableHtml || '');
  if (grid.length < 2) return null;
  const headerIndex = grid.slice(0, Math.min(5, grid.length))
    .map((row, index) => ({ index, score: headerScore(row) }))
    .sort((left, right) => right.score - left.score)[0]?.index ?? 0;
  const width = Math.max(...grid.map(row => row.length));
  const headerRows = grid.slice(0, headerIndex + 1);
  const headers = Array.from({ length: width }, (_, column) => {
    const fragments = headerRows.map(row => cleanText(row[column])).filter(Boolean);
    return [...new Set(fragments)].join('');
  });
  const rows = grid.slice(headerIndex + 1).map((cells, index) => ({
    cells: [...cells, ...Array.from({ length: Math.max(0, width - cells.length) }, () => '')],
    sourceRowIndex: headerIndex + index + 2
  }));
  return { page: block.page, headers, rows, bbox: block.bbox };
}

type TableSchema = ReturnType<typeof tableSchema>;

function tableSchema(headers: string[]) {
  const accountNumber = findColumn(headers, ACCOUNT_NUMBER_HEADERS, /对方|对手|收款人|付款人/);
  const accountName = findColumn(headers, ACCOUNT_NAME_HEADERS, /对方|对手|收款人|付款人/);
  const transactionDate = findDateColumn(headers);
  const transactionTime = findColumn(headers, TIME_HEADERS);
  const amount = findColumn(headers, AMOUNT_HEADERS, /余额|开户|账户状态/);
  const credit = findColumn(headers, CREDIT_HEADERS);
  const debit = findColumn(headers, DEBIT_HEADERS);
  const balance = findColumn(headers, BALANCE_HEADERS);
  const direction = findColumn(headers, DIRECTION_HEADERS);
  const summaryColumns = findColumns(headers, SUMMARY_HEADERS);
  const isTransaction = transactionDate >= 0 && (amount >= 0 || credit >= 0 || debit >= 0);
  const isAccountList = !isTransaction && accountNumber >= 0 && (
    accountName >= 0 || headers.some(header => /开户日期|销户日期|账户状态|产品号|客户号/.test(normalizedHeader(header)))
  );
  return {
    kind: isTransaction ? 'TRANSACTIONS' as const : isAccountList ? 'ACCOUNT_LIST' as const : 'OTHER' as const,
    accountNumber,
    accountName,
    transactionDate,
    transactionTime,
    amount,
    credit,
    debit,
    balance,
    direction,
    counterpartyName: findColumn(headers, COUNTERPARTY_NAME_HEADERS),
    counterpartyAccount: findColumn(headers, COUNTERPARTY_ACCOUNT_HEADERS),
    counterpartyBank: findColumn(headers, COUNTERPARTY_BANK_HEADERS),
    summaryColumns,
    bankName: findColumn(headers, ['银行名称', '开户行名称', '开户行机构名称', '交易银行']),
    accountBalance: findColumn(headers, ['账户余额', '当前余额', '金额', '余额'])
  };
}

function transactionFromRow(
  table: ParsedTable,
  row: ParsedTable['rows'][number],
  schema: TableSchema,
  fallbackBank: string,
  respondentName: string,
  sourceFileName: string
): StandardTransaction | null {
  const rawDate = cell(row.cells, schema.transactionDate);
  const rawTime = cell(row.cells, schema.transactionTime);
  const transactionTime = normalizeDateTime(rawDate, rawTime);
  const genericAmount = moneyValue(cell(row.cells, schema.amount));
  const creditAmount = moneyValue(cell(row.cells, schema.credit));
  const debitAmount = moneyValue(cell(row.cells, schema.debit));
  const balance = moneyValue(cell(row.cells, schema.balance));
  const amountSource = creditAmount.valid && Math.abs(creditAmount.value) > 0
    ? creditAmount
    : debitAmount.valid && Math.abs(debitAmount.value) > 0 ? debitAmount : genericAmount;
  const rawAccount = normalizeAccountNumber(cell(row.cells, schema.accountNumber));
  const summary = schema.summaryColumns.map(index => cleanText(cell(row.cells, index))).filter(Boolean).join('；');
  const hasRowEvidence = Boolean(transactionTime || amountSource.valid || balance.valid || summary);
  if (!hasRowEvidence) return null;
  const direction = explicitDirection(
    cell(row.cells, schema.direction), creditAmount, debitAmount, genericAmount
  );
  const issues: NonNullable<StandardTransaction['dataQualityIssues']> = [];
  if (!transactionTime) issues.push('INVALID_DATE');
  if (!amountSource.valid) issues.push('INVALID_AMOUNT');
  if (direction === 'UNKNOWN') issues.push('UNKNOWN_DIRECTION');
  const accountNumber = isUsefulAccountNumber(rawAccount) ? rawAccount : `待核验账号-第${table.page}页`;
  const confidence = Math.max(0.45, 0.98
    - (!transactionTime ? 0.18 : 0)
    - (!amountSource.valid ? 0.2 : 0)
    - (direction === 'UNKNOWN' ? 0.14 : 0)
    - (!isUsefulAccountNumber(rawAccount) ? 0.12 : 0));
  return {
    id: `TX_MINERU_P${table.page}_R${row.sourceRowIndex}_${transactionsafe(accountNumber)}`,
    accountNumber,
    accountName: cleanText(cell(row.cells, schema.accountName)) || respondentName || '待核验户名',
    bankName: usefulBankName(cell(row.cells, schema.bankName)) || fallbackBank,
    transactionTime,
    transactionDate: transactionTime.slice(0, 10),
    direction,
    amount: amountSource.valid ? Math.abs(amountSource.value) : 0,
    balance: balance.valid ? balance.value : 0,
    balanceAvailable: balance.valid,
    counterpartyName: cleanText(cell(row.cells, schema.counterpartyName)),
    counterpartyAccount: normalizeAccountNumber(cell(row.cells, schema.counterpartyAccount)) || undefined,
    counterpartyBank: cleanText(cell(row.cells, schema.counterpartyBank)) || undefined,
    summary,
    rawSourceFile: sourceFileName,
    rawPageNumber: table.page,
    rawRowIndex: row.sourceRowIndex,
    rawText: row.cells.filter(Boolean).join(' | '),
    sourceRegion: estimatedRowRegion(table, row.sourceRowIndex),
    extractionMethod: 'MINERU_DIRECT_PDF',
    extractionConfidence: confidence,
    reviewStatus: issues.length ? 'PENDING' : 'AUTO_PASSED',
    dataQualityIssues: issues
  };
}

function buildAccounts(
  listed: ListedAccount[],
  transactions: StandardTransaction[],
  fallbackBank: string,
  respondentName: string,
  sourceFileName: string,
  totalPages: number
): BankAccount[] {
  const identities = new Map<string, ListedAccount>();
  for (const account of listed) identities.set(account.accountNumber, account);
  for (const transaction of transactions) {
    if (!identities.has(transaction.accountNumber)) {
      identities.set(transaction.accountNumber, {
        accountNumber: transaction.accountNumber,
        accountName: transaction.accountName,
        bankName: transaction.bankName,
        page: transaction.rawPageNumber || 1
      });
    }
  }
  return [...identities.values()].map(identity => {
    const rows = transactions.filter(transaction => transaction.accountNumber === identity.accountNumber)
      .sort(sourceOrder);
    const dates = rows.map(row => row.transactionDate).filter(Boolean).sort();
    const totalIn = sum(rows.filter(row => row.direction === 'IN').map(row => row.amount));
    const totalOut = sum(rows.filter(row => row.direction === 'OUT').map(row => row.amount));
    const firstBalance = rows.find(row => row.balanceAvailable !== false);
    const lastBalance = [...rows].reverse().find(row => row.balanceAvailable !== false);
    const startBalance = firstBalance
      ? firstBalance.balance + (firstBalance.direction === 'OUT' ? firstBalance.amount : firstBalance.direction === 'IN' ? -firstBalance.amount : 0)
      : identity.balance || 0;
    const endBalance = lastBalance?.balance ?? identity.balance ?? 0;
    const balanceAvailable = Boolean(firstBalance || lastBalance || identity.balance != null);
    const balanceDiff = balanceAvailable ? Math.abs(startBalance + totalIn - totalOut - endBalance) : 0;
    const warnings = fallbackBank === '待核验银行' ? ['原件未明确识别出银行名称，请对照原件确认'] : [];
    return {
      accountNumber: identity.accountNumber,
      accountName: identity.accountName || respondentName || '待核验户名',
      bankName: identity.bankName || fallbackBank,
      ownerType: 'DEBTOR_MAIN',
      fileName: sourceFileName,
      fileType: 'pdf',
      totalIn,
      totalOut,
      transactionCount: rows.length,
      startDate: dates[0] || '',
      endDate: dates.at(-1) || '',
      startBalance,
      endBalance,
      balanceAvailable,
      isBalanced: balanceAvailable && balanceDiff < 0.01,
      balanceDiff,
      parseStatus: rows.some(row => row.reviewStatus === 'PENDING') || warnings.length ? 'NEEDS_REVIEW' : 'COMPLETE',
      parseWarnings: warnings,
      coveredPages: [...new Set([identity.page, ...rows.map(row => row.rawPageNumber || 0)].filter(Boolean))].sort((a, b) => a - b),
      totalPages
    };
  });
}

function emptyDocumentAccount(
  bankName: string,
  respondentName: string,
  sourceFileName: string,
  totalPages: number
): BankAccount {
  return {
    accountNumber: `待归属页面-${sourceFileName}`,
    accountName: respondentName || '待归属页面',
    bankName,
    ownerType: 'UNKNOWN',
    fileName: sourceFileName,
    fileType: 'pdf',
    totalIn: 0,
    totalOut: 0,
    transactionCount: 0,
    startDate: '',
    endDate: '',
    startBalance: 0,
    endBalance: 0,
    balanceAvailable: false,
    isBalanced: false,
    balanceDiff: 0,
    parseStatus: 'NEEDS_REVIEW',
    parseWarnings: ['MinerU 已完成文档解析，但没有找到可导入的账户表或流水表'],
    coveredPages: Array.from({ length: totalPages }, (_, index) => index + 1),
    totalPages
  };
}

function canonicalizeListedAccounts(transactions: StandardTransaction[], listed: ListedAccount[]): void {
  const candidates = listed.map(account => account.accountNumber).filter(isUsefulAccountNumber);
  for (const transaction of transactions) {
    const matches = candidates.filter(candidate => storedAccountAlias(candidate, transaction.accountNumber));
    if (matches.length !== 1) continue;
    transaction.accountNumber = matches[0];
    const account = listed.find(item => item.accountNumber === matches[0]);
    if (account) {
      if (!transaction.accountName || /待核验/.test(transaction.accountName)) transaction.accountName = account.accountName;
      if (!usefulBankName(transaction.bankName)) transaction.bankName = account.bankName;
    }
  }
}

function inferMissingDirections(transactions: StandardTransaction[]): void {
  const groups = new Map<string, StandardTransaction[]>();
  for (const transaction of transactions) {
    groups.set(transaction.accountNumber, [...(groups.get(transaction.accountNumber) || []), transaction]);
  }
  for (const rows of groups.values()) {
    rows.sort(sourceOrder);
    for (let index = 0; index < rows.length; index += 1) {
      const transaction = rows[index];
      if (transaction.direction !== 'UNKNOWN') continue;
      const previous = rows[index - 1];
      if (previous && previous.balanceAvailable !== false && transaction.balanceAvailable !== false && transaction.amount > 0) {
        const delta = transaction.balance - previous.balance;
        const tolerance = Math.max(0.02, transaction.amount * 0.002);
        if (Math.abs(delta - transaction.amount) <= tolerance) transaction.direction = 'IN';
        else if (Math.abs(delta + transaction.amount) <= tolerance) transaction.direction = 'OUT';
      }
      if (transaction.direction === 'UNKNOWN') transaction.direction = directionFromSummary(transaction.summary);
      if (transaction.direction !== 'UNKNOWN') {
        transaction.dataQualityIssues = (transaction.dataQualityIssues || []).filter(issue => issue !== 'UNKNOWN_DIRECTION');
        if (!transaction.dataQualityIssues.length) {
          transaction.reviewStatus = 'AUTO_PASSED';
          transaction.extractionConfidence = Math.max(transaction.extractionConfidence || 0, 0.9);
        }
      }
    }
  }
}

function explicitDirection(
  value: string,
  credit: ReturnType<typeof moneyValue>,
  debit: ReturnType<typeof moneyValue>,
  generic: ReturnType<typeof moneyValue>
): FlowDirection {
  const normalized = cleanText(value).toUpperCase();
  if (/收入|转入|收款|贷方|^C$|^CR$|^IN$/.test(normalized)) return 'IN';
  if (/支出|转出|付款|借方|^D$|^DR$|^OUT$/.test(normalized)) return 'OUT';
  if (credit.valid && Math.abs(credit.value) > 0 && !(debit.valid && Math.abs(debit.value) > 0)) return 'IN';
  if (debit.valid && Math.abs(debit.value) > 0 && !(credit.valid && Math.abs(credit.value) > 0)) return 'OUT';
  if (generic.valid && generic.value < 0) return 'OUT';
  return 'UNKNOWN';
}

function directionFromSummary(value: string): FlowDirection {
  if (/司法划扣|冻结扣划|扣划|消费|支取|取现|手续费|转出|汇款|扣款|代扣|缴费|贷款归还|还贷/.test(value)) return 'OUT';
  if (/结息|利息收入|工资|退款|退汇|存入|入账|收款|转入|还款|年费减免|费用减免/.test(value)) return 'IN';
  return 'UNKNOWN';
}

function findDateColumn(headers: string[]): number {
  const normalized = headers.map(normalizedHeader);
  for (const alias of DATE_HEADERS) {
    const exact = normalized.indexOf(normalizedHeader(alias));
    if (exact >= 0) return exact;
  }
  return normalized.findIndex(header => /交易日期|记账日期|入账日期|发生日期|账务日期/.test(header)
    && !/查询|开户|销户|起始|终止/.test(header));
}

function findColumn(headers: string[], aliases: string[], excluded?: RegExp): number {
  const normalized = headers.map(normalizedHeader);
  for (const alias of aliases.map(normalizedHeader)) {
    const exact = normalized.findIndex(header => header === alias && !(excluded?.test(header)));
    if (exact >= 0) return exact;
  }
  return normalized.findIndex(header => !(excluded?.test(header))
    && aliases.some(alias => header.includes(normalizedHeader(alias))));
}

function findColumns(headers: string[], aliases: string[]): number[] {
  return headers.map(normalizedHeader).flatMap((header, index) =>
    aliases.some(alias => header === normalizedHeader(alias) || header.includes(normalizedHeader(alias))) ? [index] : []
  );
}

function headerScore(row: string[]): number {
  const recognized = [
    ...ACCOUNT_NUMBER_HEADERS, ...ACCOUNT_NAME_HEADERS, ...DATE_HEADERS, ...AMOUNT_HEADERS,
    ...CREDIT_HEADERS, ...DEBIT_HEADERS, ...BALANCE_HEADERS, ...SUMMARY_HEADERS
  ].map(normalizedHeader);
  return row.map(normalizedHeader).filter(header => recognized.some(alias => header === alias || header.includes(alias))).length;
}

function inferBankName(text: string, fileName: string): string {
  const ignored = /开户行|对方银行|银行名称|人民银行|法院|调查令/;
  const matches = text.match(/[\u4e00-\u9fff]{2,18}(?:农村商业银行|商业银行|农业银行|工商银行|建设银行|中国银行|交通银行|邮政储蓄银行|农商行|农信|信用社|信用联社)/g) || [];
  const fromText = matches.map(cleanText).filter(value => !ignored.test(value)).sort((a, b) => a.length - b.length)[0];
  if (fromText) return fromText;
  const tokens = fileName.replace(/\.pdf$/i, '').split(/[_\s-]+/).map(cleanText).filter(Boolean);
  return tokens.find(token => token.length >= 4 && token.length <= 24
    && /(?:银行|农信|信用社|信用联社|农商行)$/.test(token)) || '';
}

function usefulBankName(value: string): string {
  const cleaned = cleanText(value);
  return /银行|农信|信用社|信用联社|农商行/.test(cleaned) ? cleaned : '';
}

function estimatedRowRegion(table: ParsedTable, sourceRowIndex: number): StandardTransaction['sourceRegion'] {
  if (!table.bbox || !table.rows.length) return undefined;
  const [x1, y1, x2, y2] = table.bbox;
  const rowIndex = Math.max(0, table.rows.findIndex(row => row.sourceRowIndex === sourceRowIndex));
  const rowHeight = (y2 - y1) / Math.max(1, table.rows.length + 1);
  return {
    x: clamp01(x1 / 1000),
    y: clamp01((y1 + rowHeight * (rowIndex + 1)) / 1000),
    width: clamp01((x2 - x1) / 1000),
    height: clamp01(rowHeight / 1000),
    origin: 'ESTIMATED',
    confidence: 0.7
  };
}

function moneyValue(value: string): { value: number; valid: boolean } {
  const original = cleanText(value);
  if (!original || /^[-—]+$/.test(original)) return { value: 0, valid: false };
  const negative = /^[-−]/.test(original) || /^[（(].*[）)]$/.test(original);
  const parsed = Number(original.replace(/[,，￥¥\s()（）−]/g, '').replace(/^\+/, ''));
  return Number.isFinite(parsed)
    ? { value: negative ? -Math.abs(parsed) : parsed, valid: true }
    : { value: 0, valid: false };
}

function normalizeDateTime(rawDate: string, rawTime: string): string {
  const dateDigits = cleanText(rawDate).replace(/[^0-9]/g, '');
  if (dateDigits.length < 8) return '';
  const year = Number(dateDigits.slice(0, 4));
  const month = Number(dateDigits.slice(4, 6));
  const day = Number(dateDigits.slice(6, 8));
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const timeDigits = (cleanText(rawTime).replace(/[^0-9]/g, '') || dateDigits.slice(8)).slice(0, 6);
  if (timeDigits.length < 4) return date;
  const hour = Number(timeDigits.slice(0, 2));
  const minute = Number(timeDigits.slice(2, 4));
  const second = timeDigits.length >= 6 ? Number(timeDigits.slice(4, 6)) : 0;
  if (hour > 23 || minute > 59 || second > 59) return date;
  return `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function normalizeAccountNumber(value: string): string {
  const normalized = cleanText(value).replace(/[\s\-_—–·•]/g, '');
  // MinerU occasionally merges the next currency/sub-account cell into a
  // numeric owner account (for example "123937014771CNY0"). This suffix is
  // layout residue, not part of a Chinese bank account number.
  const currencySuffix = normalized.match(/^(\d{8,})(?:CNY|RMB)0?$/i);
  return currencySuffix?.[1] || normalized;
}

function isUsefulAccountNumber(value: string): boolean {
  return value.length >= 8 && value.length <= 32 && /\d{6}/.test(value) && !/待核验|未知/.test(value);
}

function storedAccountAlias(left: string, right: string): boolean {
  const a = normalizeAccountNumber(left);
  const b = normalizeAccountNumber(right);
  if (a === b) return true;
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  const difference = longer.length - shorter.length;
  return shorter.length >= 10 && difference >= 1 && difference <= 4 && longer.endsWith(shorter);
}

function decodeHtml(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .trim();
}

function normalizedHeader(value: string): string {
  return cleanText(value).replace(/[\s\n\r:：()（）/\\_-]/g, '');
}

function cell(row: string[], index: number): string {
  return index >= 0 ? row[index] || '' : '';
}

function cleanText(value: unknown): string {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
}

function transactionsafe(value: string): string {
  return value.replace(/[^0-9A-Za-z\u4e00-\u9fff]/g, '').slice(-20) || 'UNKNOWN';
}

function sourceOrder(left: StandardTransaction, right: StandardTransaction): number {
  return (left.rawPageNumber || 0) - (right.rawPageNumber || 0)
    || (left.rawRowIndex || 0) - (right.rawRowIndex || 0);
}

function sum(values: number[]): number {
  return Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function pdfPageCount(file: File): Promise<number> {
  const { PDFDocument } = await import('pdf-lib');
  const document = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true });
  return document.getPageCount();
}

function mineruProgress(progress: MinerUProgress, totalPages: number): MinerUDirectProgressInfo {
  const completed = Math.max(0, Math.min(totalPages, progress.completed));
  const percent = progress.stage === 'SUBMITTING'
    ? Math.max(2, Math.round(completed / Math.max(1, totalPages) * 15))
    : Math.min(25, 5 + Math.round(completed / Math.max(1, totalPages) * 20));
  return {
    statusText: progress.message,
    totalTransactions: 0,
    percent,
    isStreaming: true
  };
}
