import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { mergeQwenChunkResults, QwenChunkResult } from '../src/parsers/qwenResultMerger';
import { StandardTransaction } from '../src/types/transaction';

const execFileAsync = promisify(execFile);
const sourcePdf = resolve(process.argv[2] || '/Users/happy/Downloads/胡艳红流水合并.pdf');
const outputDir = resolve(process.argv[3] || 'test-data/private/hu-yanhong');
const endpoint = process.env.BENCHMARK_PARSE_URL || 'https://lawtool.cocoaiagent.com/api/parse-bank-statement-stream';
const concurrency = positiveInteger(process.env.BENCHMARK_CONCURRENCY, 10);
const pageDpi = positiveInteger(process.env.BENCHMARK_PAGE_DPI, 180);
const pagesDir = join(outputDir, 'pages');
const rawDir = join(outputDir, 'raw-pages');

interface PageRecord {
  page: number;
  result?: QwenChunkResult;
  attempts: number;
  recognitionStatus: 'COMPLETE' | 'FAILED';
  lastError?: string;
  auditedWithContext?: boolean;
  savedAt: string;
}

interface ReviewPage {
  page: number;
  reasons: string[];
  transactionCount: number;
  pageType: string;
  status: 'PENDING' | 'SOURCE_CHECKED';
}

async function main() {
  await mkdir(pagesDir, { recursive: true });
  await mkdir(rawDir, { recursive: true });
  const [sourceStats, sourceBytes, pageCount] = await Promise.all([
    stat(sourcePdf), readFile(sourcePdf), getPdfPageCount(sourcePdf)
  ]);
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const manifest = {
    datasetVersion: 1,
    datasetKind: 'REAL_CASE_PRIVATE_BENCHMARK',
    sourceFileName: basename(sourcePdf),
    sourceSha256,
    sourceSize: sourceStats.size,
    totalPages: pageCount,
    pageDpi,
    generatedAt: new Date().toISOString(),
    groundTruthStatus: 'DRAFT_REQUIRES_SOURCE_REVIEW',
    privacy: 'LOCAL_PRIVATE_DO_NOT_COMMIT'
  };
  await writeJson(join(outputDir, 'manifest.json'), manifest);

  await ensureRenderedPages(sourcePdf, pagesDir, pageCount, pageDpi);
  console.log(`Rendered page snapshots: ${pageCount}`);

  const records = new Map<number, PageRecord>();
  await runPool(Array.from({ length: pageCount }, (_, index) => index + 1), 32, async page => {
    const restored = await readPageRecord(page);
    if (restored?.result) records.set(page, restored);
  });
  console.log(`Restored completed pages: ${records.size}/${pageCount}`);

  const missing = Array.from({ length: pageCount }, (_, index) => index + 1).filter(page => !records.has(page));
  let completed = records.size;
  await runPool(missing, concurrency, async page => {
    const record = await recognizePageWithRetries(page, pageCount, false);
    records.set(page, record);
    await writePageRecord(record);
    completed += 1;
    console.log(`Initial ${completed}/${pageCount}: page ${page}, ${record.result?.transactions.length || 0} transactions, ${record.recognitionStatus}`);
  });

  const initialResults = sortedResults(records);
  const auditPages = pagesNeedingContextAudit(initialResults)
    .filter(page => !records.get(page)?.auditedWithContext);
  console.log(`Context audit pages: ${auditPages.length}`);
  let audited = 0;
  await runPool(auditPages, Math.min(16, concurrency), async page => {
    const existing = records.get(page);
    const candidate = await recognizePageWithRetries(page, pageCount, true);
    if (candidate.result && (!existing?.result || resultPenalty(candidate.result) <= resultPenalty(existing.result))) {
      records.set(page, candidate);
      await writePageRecord(candidate);
    } else if (existing) {
      existing.auditedWithContext = true;
      existing.savedAt = new Date().toISOString();
      await writePageRecord(existing);
    }
    audited += 1;
    console.log(`Audit ${audited}/${auditPages.length}: page ${page}`);
  });

  const finalResults = sortedResults(records);
  const missingPages = Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter(page => !finalResults.some(result => result.pageStart === page));
  if (missingPages.length) throw new Error(`Recognition did not complete pages: ${missingPages.join(', ')}`);

  const merged = mergeQwenChunkResults(finalResults, basename(sourcePdf), pageCount);
  const reviewQueue = buildReviewQueue(finalResults, merged.transactions);
  const pageIndex = finalResults.map(result => ({
    page: result.pageStart,
    pageType: result.pageQuality?.[0]?.pageType || 'UNKNOWN',
    transactionCount: result.transactions.length,
    status: result.pageQuality?.[0]?.status || (result.countComplete ? 'COMPLETE' : 'NEEDS_REVIEW'),
    auditedWithContext: records.get(result.pageStart)?.auditedWithContext || false,
    image: `pages/page-${String(result.pageStart).padStart(3, '0')}.jpg`,
    rawResult: `raw-pages/page-${String(result.pageStart).padStart(3, '0')}.json`
  }));
  const benchmark = {
    manifest,
    generatedAt: new Date().toISOString(),
    pageIndex,
    accounts: merged.accounts,
    transactions: merged.transactions,
    reviewQueue,
    verification: {
      status: reviewQueue.length ? 'DRAFT_REQUIRES_SOURCE_REVIEW' : 'SOURCE_CHECKED',
      sourceCheckedPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
      knownFacts: [
        {
          id: 'HYH-PAGE-TYPE-001-006',
          pages: [1, 2, 3, 4, 5, 6],
          expected: 'ACCOUNT_INFO_WITH_ZERO_TRANSACTIONS',
          source: 'source-image review'
        },
        {
          id: 'HYH-TRANSACTION-COUNT-007-020',
          pages: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
          expectedTransactionCount: 140,
          source: 'source-image review'
        },
        {
          id: 'HYH-CROSS-PAGE-020-021',
          page: 20,
          row: 9,
          expected: {
            transactionDate: '2023-05-24', direction: 'OUT', amount: 14, balance: 3821.64,
            counterpartyName: '财付通支付科技有限公司', counterpartyAccount: '105584000000016', summary: '消费'
          },
          source: 'source-image review; transaction begins on page 20 and continues at the top of page 21'
        },
        {
          id: 'HYH-DENSE-PAGE-282',
          page: 282,
          expectedMinimumTransactionCount: 42,
          source: 'independent source-image count; sliced-image extraction experiment',
          requiredStrategy: 'horizontal_slices_or_equivalent'
        }
      ],
      note: 'Recognition output is not legal ground truth until each queued page is checked against the source image.'
    }
  };
  await writeJson(join(outputDir, 'benchmark.json'), benchmark);
  await writeJson(join(outputDir, 'review-queue.json'), reviewQueue);
  await writeJson(join(outputDir, 'summary.json'), {
    sourceSha256,
    totalPages: pageCount,
    recognizedPages: finalResults.length,
    transactionPages: pageIndex.filter(page => page.pageType === 'TRANSACTIONS').length,
    nonTransactionPages: pageIndex.filter(page => page.pageType !== 'TRANSACTIONS').length,
    transactionCount: merged.transactions.length,
    accountCount: merged.accounts.length,
    pendingReviewPages: reviewQueue.length,
    failedPages: [...records.values()].filter(record => record.recognitionStatus === 'FAILED').map(record => record.page),
    generatedAt: benchmark.generatedAt
  });
  console.log(`Dataset complete: ${merged.transactions.length} transactions, ${merged.accounts.length} accounts, ${reviewQueue.length} review pages`);
}

async function getPdfPageCount(path: string): Promise<number> {
  const { stdout } = await execFileAsync('pdfinfo', [path], { maxBuffer: 1024 * 1024 });
  const match = stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) throw new Error('Unable to read PDF page count');
  return Number(match[1]);
}

async function ensureRenderedPages(path: string, directory: string, totalPages: number, dpi: number): Promise<void> {
  const existing = new Set(await readdir(directory).catch(() => []));
  const complete = Array.from({ length: totalPages }, (_, index) => `page-${String(index + 1).padStart(3, '0')}.jpg`)
    .every(name => existing.has(name));
  if (complete) return;
  await execFileAsync('pdftoppm', ['-jpeg', '-r', String(dpi), path, join(directory, 'page')], { maxBuffer: 10 * 1024 * 1024 });
}

async function recognizePageWithRetries(page: number, totalPages: number, withContext: boolean): Promise<PageRecord> {
  let lastError = '';
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const result = await requestPage(page, totalPages, withContext || attempt > 1);
      return { page, result, attempts: attempt, recognitionStatus: 'COMPLETE', auditedWithContext: withContext || attempt > 1, savedAt: new Date().toISOString() };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await delay(Math.min(12_000, attempt * attempt * 750));
    }
  }
  return { page, attempts: 5, recognitionStatus: 'FAILED', lastError, auditedWithContext: withContext, savedAt: new Date().toISOString() };
}

async function requestPage(page: number, totalPages: number, withContext: boolean): Promise<QwenChunkResult> {
  const form = new FormData();
  form.append('file', await pageBlob(page), `page-${page}.jpg`);
  form.append('sourceFileName', basename(sourcePdf));
  form.append('pageStart', String(page));
  form.append('pageEnd', String(page));
  form.append('totalPages', String(totalPages));
  form.append('chunkId', `P${page}-${page}`);
  if (withContext) {
    if (page > 1) form.append('contextBefore', await pageBlob(page - 1), `page-${page - 1}.jpg`);
    if (page < totalPages) form.append('contextAfter', await pageBlob(page + 1), `page-${page + 1}.jpg`);
    form.append('auditHint', '真实回归数据集页面复核：检查跨页续行、余额连续性、收支方向和金额/余额列错位。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(endpoint, { method: 'POST', body: form, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(-300)}`);
    let complete: QwenChunkResult | undefined;
    let serviceError = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = JSON.parse(line.slice(5).trim());
      if (payload.type === 'complete') complete = payload;
      if (payload.type === 'error') serviceError = payload.message || 'Page recognition failed';
    }
    if (serviceError) throw new Error(serviceError);
    if (!complete?.account || !Array.isArray(complete.transactions)) throw new Error('Incomplete page response');
    return complete;
  } finally {
    clearTimeout(timer);
  }
}

async function pageBlob(page: number): Promise<Blob> {
  const bytes = await readFile(join(pagesDir, `page-${String(page).padStart(3, '0')}.jpg`));
  return new Blob([bytes], { type: 'image/jpeg' });
}

function pagesNeedingContextAudit(results: QwenChunkResult[]): number[] {
  const pages = new Set<number>();
  const categories = {
    countOrQuality: new Set<number>(),
    invalidFields: new Set<number>(),
    warnings: new Set<number>(),
    columnShift: new Set<number>(),
    reversedDirections: new Set<number>(),
    isolatedEmpty: new Set<number>()
  };
  const mark = (category: keyof typeof categories, page: number) => {
    categories[category].add(page);
    pages.add(page);
  };
  for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
    const result = results[resultIndex];
    const quality = result.pageQuality?.[0];
    const invalid = result.transactions.some(transaction => transaction.direction === 'UNKNOWN'
      || transaction.amount <= 0 || !transaction.transactionDate || (transaction.extractionConfidence ?? 1) < 0.8);
    if (quality?.status === 'NEEDS_REVIEW' || result.countComplete === false) mark('countOrQuality', result.pageStart);
    if (invalid) mark('invalidFields', result.pageStart);
    if ((result.warnings?.length || 0) > 0) categories.warnings.add(result.pageStart);
    if (looksLikeColumnShift(result.transactions)) mark('columnShift', result.pageStart);
    if (looksLikeReversedDirections(result.transactions)) mark('reversedDirections', result.pageStart);
    const previousHasTransactions = (results[resultIndex - 1]?.transactions.length || 0) > 0;
    const nextHasTransactions = (results[resultIndex + 1]?.transactions.length || 0) > 0;
    if (!result.transactions.length && (quality?.pageType === 'TRANSACTIONS' || result.pageStart === 16)) {
      mark('isolatedEmpty', result.pageStart);
    } else if (!result.transactions.length && previousHasTransactions && nextHasTransactions) {
      categories.isolatedEmpty.add(result.pageStart);
    }
  }
  console.log('Audit reason counts:', Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, value.size])));
  return [...pages].sort((a, b) => a - b);
}

function buildReviewQueue(results: QwenChunkResult[], transactions: StandardTransaction[]): ReviewPage[] {
  const reasonsByPage = new Map<number, Set<string>>();
  const add = (page: number, reason: string) => {
    if (!reasonsByPage.has(page)) reasonsByPage.set(page, new Set());
    reasonsByPage.get(page)?.add(reason);
  };
  for (const result of results) {
    const page = result.pageStart;
    if (result.pageQuality?.some(item => item.status === 'NEEDS_REVIEW')) add(page, '页面清点与逐笔明细仍不一致');
    for (const warning of result.warnings || []) add(page, warning);
    if (result.transactions.some(transaction => transaction.direction === 'UNKNOWN')) add(page, '存在未确认的收支方向');
    if (result.transactions.some(transaction => transaction.amount <= 0)) add(page, '存在未确认的交易金额');
    if (result.transactions.some(transaction => !transaction.transactionDate)) add(page, '存在未确认的交易日期');
  }
  for (const transaction of transactions) {
    if (transaction.reviewStatus !== 'PENDING') continue;
    add(transaction.rawPageNumber || 1, '全局校验后仍需核对交易字段或余额连续性');
  }
  return [...reasonsByPage.entries()].sort(([a], [b]) => a - b).map(([page, reasons]) => {
    const result = results.find(item => item.pageStart === page);
    return {
      page,
      reasons: [...reasons],
      transactionCount: result?.transactions.length || 0,
      pageType: result?.pageQuality?.[0]?.pageType || 'UNKNOWN',
      status: 'PENDING'
    };
  });
}

function resultPenalty(result: QwenChunkResult): number {
  const invalid = result.transactions.filter(transaction => transaction.direction === 'UNKNOWN'
    || transaction.amount <= 0 || !transaction.transactionDate).length;
  const countGap = Math.abs((result.pageQuality?.[0]?.expectedCount ?? result.transactions.length) - result.transactions.length);
  return invalid * 10_000 + countGap * 1_000 + (result.warnings?.length || 0) * 100
    + (looksLikeColumnShift(result.transactions) ? 50_000 : 0)
    + (looksLikeReversedDirections(result.transactions) ? 20_000 : 0);
}

function looksLikeColumnShift(transactions: StandardTransaction[]): boolean {
  if (transactions.length < 3) return false;
  const zeroBalances = transactions.filter(transaction => hasBalance(transaction) && Math.abs(transaction.balance) < 0.005).length;
  return zeroBalances / transactions.length >= 0.8 && transactions.filter(transaction => transaction.amount > 10).length / transactions.length >= 0.8;
}

function looksLikeReversedDirections(transactions: StandardTransaction[]): boolean {
  let comparisons = 0;
  let direct = 0;
  let flipped = 0;
  const ordered = [...transactions].sort(compareSourceOrder);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (!hasBalance(previous) || !hasBalance(current) || current.direction === 'UNKNOWN') continue;
    comparisons += 1;
    if (sequenceBalanceError(previous, current, false) < 1) direct += 1;
    if (sequenceBalanceError(previous, current, true) < 1) flipped += 1;
  }
  return comparisons >= 2 && flipped / comparisons >= 0.65 && direct / comparisons <= 0.25;
}

function balanceError(previousBalance: number, amount: number, currentBalance: number, direction: string): number {
  return Math.abs(previousBalance + (direction === 'IN' ? amount : -amount) - currentBalance);
}

function sequenceBalanceError(previous: StandardTransaction, current: StandardTransaction, flip: boolean): number {
  const descending = Boolean(previous.transactionTime && current.transactionTime
    && current.transactionTime.localeCompare(previous.transactionTime) < 0);
  if (!descending) {
    const direction = flip ? oppositeDirection(current.direction) : current.direction;
    return balanceError(previous.balance, current.amount, current.balance, direction);
  }
  const previousDirection = flip ? oppositeDirection(previous.direction) : previous.direction;
  return balanceError(current.balance, previous.amount, previous.balance, previousDirection);
}

function oppositeDirection(direction: StandardTransaction['direction']): StandardTransaction['direction'] {
  return direction === 'IN' ? 'OUT' : direction === 'OUT' ? 'IN' : 'UNKNOWN';
}

function hasBalance(transaction: StandardTransaction): boolean {
  return transaction.balanceAvailable !== false && Number.isFinite(transaction.balance);
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}

function sortedResults(records: Map<number, PageRecord>): QwenChunkResult[] {
  return [...records.values()].filter(record => record.result).sort((a, b) => a.page - b.page).map(record => record.result!);
}

async function readPageRecord(page: number): Promise<PageRecord | undefined> {
  try { return JSON.parse(await readFile(pageRecordPath(page), 'utf8')); } catch { return undefined; }
}

async function writePageRecord(record: PageRecord): Promise<void> {
  await writeJson(pageRecordPath(record.page), record);
}

function pageRecordPath(page: number): string {
  return join(rawDir, `page-${String(page).padStart(3, '0')}.json`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
