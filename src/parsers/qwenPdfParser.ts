import { BankAccount, StandardTransaction } from '../types/transaction';
import { createPdfPageImageRenderer, PdfPageImage } from './pdfPageImageRenderer';
import { mergeQwenChunkResults as mergeVerifiedChunks } from './qwenResultMerger';
export { mergeQwenChunkResults } from './qwenResultMerger';

const MAX_CONCURRENCY = 10;
const INITIAL_CONCURRENCY = 5;
const MIN_CONCURRENCY = 2;
const SINGLE_PAGE_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 150_000;
const CACHE_VERSION = 'page-image-v4-dense-page-slices';
const NORMAL_IMAGE_SCALE = 2.35;
const HIGH_DETAIL_IMAGE_SCALE = 3;
const DENSE_PAGE_BAND_SCALE = 3;
const DENSE_PAGE_BAND_COUNT = 4;

export interface QwenProgressInfo {
  currentPage: number;
  totalPages: number;
  percent: number;
  totalTransactions: number;
  statusText?: string;
}

export interface ChunkParseResult {
  account: BankAccount;
  transactions: StandardTransaction[];
  warnings?: string[];
  coveredPages: number[];
  pageStart: number;
  pageEnd: number;
  totalPages: number;
  expectedTransactionCount?: number;
  countComplete?: boolean;
  usageTokens?: number;
  pageQuality?: Array<{ page: number; expectedCount: number; extractedCount: number; status: 'COMPLETE' | 'NEEDS_REVIEW'; pageType?: PageType }>;
}

type PageType = 'TRANSACTIONS' | 'ACCOUNT_INFO' | 'DOCUMENT' | 'BLANK' | 'UNKNOWN';

class IncompleteCountError extends Error {
  constructor(public candidate: ChunkParseResult) {
    super('该页不同读取结果不一致');
  }
}

export async function parsePdfWithQwen(
  file: File,
  onProgress?: (info: QwenProgressInfo) => void,
  signal?: AbortSignal
): Promise<{ account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] }> {
  onProgress?.({ currentPage: 0, totalPages: 0, percent: 0, totalTransactions: 0,
    statusText: '正在本地逐页生成识别图片，原始 PDF 保持不变…' });
  const renderer = await createPdfPageImageRenderer(file);
  const totalPages = renderer.totalPages;
  const cacheKey = `${CACHE_VERSION}|${file.name}|${file.size}|${file.lastModified}|${totalPages}`;
  const results: ChunkParseResult[] = [];
  const cachedResults = await readCachedResults(cacheKey);
  const cachedByPage = new Map(cachedResults.map(result => [result.pageStart, result]));
  const requestGate = new AdaptiveRequestGate(totalPages);
  let completedPages = 0;
  let totalTransactions = 0;

  const report = (statusText: string) => onProgress?.({
    currentPage: completedPages,
    totalPages,
    percent: Math.round(completedPages / totalPages * 100),
    totalTransactions,
    statusText
  });
  report(`共 ${totalPages} 页，正在建立高速逐页识别队列…`);

  try {
    const pages = Array.from({ length: totalPages }, (_, index) => index + 1);
    await runWithConcurrency(pages, MAX_CONCURRENCY, async pageNumber => {
      assertNotAborted(signal);
      const cached = cachedByPage.get(pageNumber);
      const result = cached || await parsePageWithFallback(
        pageNumber, totalPages, file.name, renderer.renderPage, requestGate, signal, report
      );
      if (!cached && !isHardFailedPage(result)) await writeCachedResults(cacheKey, [result]);
      results.push(result);
      completedPages += 1;
      totalTransactions += result.transactions.length;
      report(`${cached ? '已恢复' : '已完成'}第 ${pageNumber} 页，累计提取 ${totalTransactions} 笔交易`);
    }, signal);
    const globallyAudited = await auditSuspiciousPages(
      results, totalPages, file.name, renderer.renderPage, requestGate, signal, report
    );
    return mergeVerifiedChunks(globallyAudited, file.name, totalPages);
  } finally {
    await renderer.destroy();
  }
}

async function parsePageWithFallback(
  pageNumber: number,
  totalPages: number,
  sourceFileName: string,
  renderPage: (pageNumber: number, rotation?: number, scale?: number) => Promise<PdfPageImage>,
  requestGate: AdaptiveRequestGate,
  signal: AbortSignal | undefined,
  report: (status: string) => void
): Promise<ChunkParseResult> {
  let lastError: unknown;
  let bestCandidate: ChunkParseResult | undefined;
  const variants = [
    { rotation: 0, scale: NORMAL_IMAGE_SCALE },
    { rotation: 0, scale: HIGH_DETAIL_IMAGE_SCALE },
    { rotation: 90, scale: NORMAL_IMAGE_SCALE },
    { rotation: 270, scale: NORMAL_IMAGE_SCALE },
    { rotation: 180, scale: NORMAL_IMAGE_SCALE }
  ].slice(0, SINGLE_PAGE_ATTEMPTS);

  for (let attempt = 0; attempt < variants.length; attempt += 1) {
    if (attempt > 0 && !requestGate.takeRetry()) break;
    const variant = variants[attempt];
    let permit: AdaptivePermit | undefined;
    try {
      assertNotAborted(signal);
      if (attempt) report(`第 ${pageNumber} 页正在进行第 ${attempt + 1} 次页面复核…`);
      permit = await requestGate.acquire(signal);
      const image = await renderPage(pageNumber, variant.rotation, variant.scale);
      const candidate = await requestChunk(image, sourceFileName, signal);
      if (!bestCandidate || qualityScore(candidate) > qualityScore(bestCandidate)) bestCandidate = candidate;
      if (attempt < 2 && shouldUsePageBands(candidate)) {
        report(`第 ${pageNumber} 页交易行较密或疑似漏行，正在分段读取…`);
        const detailedImage = variant.scale >= DENSE_PAGE_BAND_SCALE
          ? image : await renderPage(pageNumber, 0, DENSE_PAGE_BAND_SCALE);
        const bandCandidate = await parsePageBands(detailedImage, candidate, sourceFileName, signal);
        if (bandCandidate && (!bestCandidate || qualityScore(bandCandidate) > qualityScore(bestCandidate))) {
          bestCandidate = bandCandidate;
        }
        if (bandCandidate?.countComplete) {
          permit.success(bandCandidate.usageTokens || 0);
          permit = undefined;
          return bandCandidate;
        }
      }
      const complete = requireCompleteCount(candidate);
      permit.success(candidate.usageTokens || 0);
      permit = undefined;
      return complete;
    } catch (error) {
      permit?.failure(isTransientWorkerError(error));
      permit = undefined;
      assertNotAborted(signal);
      if (attempt < variants.length - 1) {
        const delay = isTransientWorkerError(error) ? Math.min(10000, (attempt + 1) * 2500) : Math.min(4000, (attempt + 1) * 1000);
        await abortableDelay(delay, signal);
      }
    }
  }

  if (bestCandidate) {
    const checkedCount = bestCandidate.pageQuality?.[0]?.expectedCount;
    const countText = checkedCount === undefined
      ? `已保留 ${bestCandidate.transactions.length} 笔现有明细`
      : `独立清点为 ${checkedCount} 笔，逐笔明细为 ${bestCandidate.transactions.length} 笔`;
    const warning = `第 ${pageNumber} 页${countText}，多次复核后仍不一致；已保留现有明细并继续解析，律师需对照原件核验`;
    bestCandidate.warnings = [...new Set([...(bestCandidate.warnings || []), warning])];
    bestCandidate.transactions = bestCandidate.transactions.map(transaction => ({ ...transaction, reviewStatus: 'PENDING' }));
    return bestCandidate;
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError || '页面无法识别');
  return failedPageResult(pageNumber, totalPages, sourceFileName, message);
}

function shouldUsePageBands(result: ChunkParseResult): boolean {
  const expected = result.expectedTransactionCount ?? result.pageQuality?.[0]?.expectedCount ?? 0;
  const type = result.pageQuality?.[0]?.pageType;
  return (expected >= 20 && result.transactions.length < Math.ceil(expected * 0.75))
    // The first pass can misclassify a transaction page as UNKNOWN when it has
    // read no rows at all.  An independent positive count is stronger evidence
    // than that classification, except for pages positively identified as a
    // cover/account-information page.
    || (expected > 0 && result.transactions.length === 0
      && type !== 'ACCOUNT_INFO' && type !== 'DOCUMENT' && type !== 'BLANK');
}

async function parsePageBands(
  image: PdfPageImage, baseline: ChunkParseResult, sourceFileName: string, signal?: AbortSignal
): Promise<ChunkParseResult | undefined> {
  const expected = baseline.expectedTransactionCount ?? baseline.pageQuality?.[0]?.expectedCount ?? 0;
  const bands = await createHorizontalBands(image, expected >= 30 ? DENSE_PAGE_BAND_COUNT : 3);
  const partials: Array<{ index: number; result: ChunkParseResult }> = [];
  for (let index = 0; index < bands.length; index += 1) {
    try {
      const result = await requestChunkWithContext(bands[index], sourceFileName, signal, {
        isPageSlice: true,
        auditHint: `这是原第 ${image.pageStart} 页从上到下的第 ${index + 1}/${bands.length} 段。仅提取本段可见的交易行；不得补造图外字段。账户抬头可能只出现在首段，已知本方账户为 ${baseline.account.bankName} ${baseline.account.accountNumber}。`
      });
      partials.push({ index, result });
    } catch {
      // A single unreadable band must not discard other successfully read portions.
    }
  }
  if (!partials.length) return undefined;

  const knownAccount = baseline.account.accountNumber && !baseline.account.accountNumber.startsWith('待核验')
    ? baseline.account : undefined;
  // Only neighbouring bands overlap.  Do not globally collapse equal-looking
  // transactions: two genuine same-day transfers can legitimately have every
  // visible field in common.
  const seen = new Map<string, { transaction: StandardTransaction; bandIndex: number }>();
  const merged: StandardTransaction[] = [];
  for (const { index, result } of partials) {
    for (const transaction of result.transactions) {
      const repaired = knownAccount && (transaction.accountNumber.startsWith('待核验') || !transaction.accountNumber)
        ? { ...transaction, accountNumber: knownAccount.accountNumber, accountName: knownAccount.accountName, bankName: knownAccount.bankName }
        : transaction;
      const key = bandTransactionKey(repaired);
      const existing = seen.get(key);
      const normalized = { ...repaired, rawRowIndex: index * 10_000 + (repaired.rawRowIndex || 0) };
      if (existing && existing.bandIndex !== index && Math.abs(existing.bandIndex - index) <= 1) {
        if ((normalized.extractionConfidence ?? 0) > (existing.transaction.extractionConfidence ?? 0)) {
          const existingIndex = merged.indexOf(existing.transaction);
          if (existingIndex >= 0) merged[existingIndex] = normalized;
          seen.set(key, { transaction: normalized, bandIndex: index });
        }
      } else {
        merged.push(normalized);
        // Keep the latest occurrence so that an overlap with the next band is
        // still removed while a later, genuine duplicate is preserved.
        seen.set(key, { transaction: normalized, bandIndex: index });
      }
    }
  }
  const transactions = merged.sort(compareSourceOrder).map((transaction, index) => ({
    ...transaction, rawPageNumber: image.pageStart, rawRowIndex: index + 1,
    extractionChunkId: `${image.id}-bands`, reviewStatus: 'PENDING' as const
  }));
  const extractedCount = transactions.length;
  const countComplete = expected > 0 && extractedCount === expected;
  return {
    ...baseline,
    account: knownAccount || partials.find(item => item.result.account.accountNumber && !item.result.account.accountNumber.startsWith('待核验'))?.result.account || baseline.account,
    transactions,
    expectedTransactionCount: expected || extractedCount,
    countComplete,
    usageTokens: partials.reduce((sum, item) => sum + (item.result.usageTokens || 0), 0),
    pageQuality: [{ page: image.pageStart, expectedCount: expected || extractedCount, extractedCount, pageType: 'TRANSACTIONS', status: countComplete ? 'COMPLETE' : 'NEEDS_REVIEW' }],
    warnings: countComplete ? [] : [`第 ${image.pageStart} 页已分段读取 ${extractedCount} 笔，原页独立清点为 ${expected} 笔，仍需对照原件确认`]
  };
}

function bandTransactionKey(transaction: StandardTransaction): string {
  return [transaction.transactionTime || transaction.transactionDate, transaction.direction, transaction.amount.toFixed(2),
    transaction.balanceAvailable === false ? '' : transaction.balance.toFixed(2), transaction.counterpartyAccount || transaction.counterpartyName,
    transaction.summary].join('|');
}

async function createHorizontalBands(image: PdfPageImage, count: number): Promise<PdfPageImage[]> {
  const bitmap = await createImageBitmap(image.file);
  try {
    const overlap = Math.min(48, Math.max(16, Math.round(bitmap.height * 0.025)));
    const baseHeight = Math.ceil(bitmap.height / count);
    const baseName = image.file.name.replace(/\.[^.]+$/, '');
    const bands: PdfPageImage[] = [];
    for (let index = 0; index < count; index += 1) {
      const start = Math.max(0, index * baseHeight - (index ? overlap : 0));
      const end = Math.min(bitmap.height, (index + 1) * baseHeight + (index < count - 1 ? overlap : 0));
      const height = Math.max(1, end - start);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('无法创建分段图像');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, start, bitmap.width, height, 0, 0, bitmap.width, height);
      const blob = await canvasBlob(canvas, 'image/jpeg', 0.92);
      canvas.width = 1;
      canvas.height = 1;
      bands.push({ ...image, id: `${image.id}-B${index + 1}`,
        file: new File([blob], `${baseName}_band_${index + 1}.jpg`, { type: 'image/jpeg' }) });
    }
    return bands;
  } finally {
    bitmap.close();
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法生成分段图像')), type, quality));
}

function requireCompleteCount(result: ChunkParseResult): ChunkParseResult {
  if (result.countComplete === false || result.pageQuality?.some(page => page.status === 'NEEDS_REVIEW')) {
    throw new IncompleteCountError(result);
  }
  return result;
}

function qualityScore(result: ChunkParseResult): number {
  const expected = result.expectedTransactionCount || result.transactions.length;
  const gap = Math.abs(expected - result.transactions.length);
  const confidence = result.transactions.reduce((sum, item) => sum + (item.extractionConfidence ?? 0.75), 0);
  return (gap === 0 ? 1_000_000 : 0) - gap * 10_000 + result.transactions.length * 100 + confidence;
}

function isTransientWorkerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|502|503|504|1102)\b|resource limits|temporar|timeout|超时|限流/i.test(message);
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已停止 PDF 解析', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface AdaptivePermit {
  success(usageTokens: number): void;
  failure(transient: boolean): void;
}

class AdaptiveRequestGate {
  private active = 0;
  private limit = INITIAL_CONCURRENCY;
  private successes = 0;
  private consecutiveTransientFailures = 0;
  private cooldownUntil = 0;
  private retriesUsed = 0;
  private readonly retryBudget: number;
  private tokenSamples: Array<{ at: number; tokens: number }> = [];

  constructor(totalPages: number) {
    this.retryBudget = Math.max(20, Math.ceil(totalPages * 1.25));
  }

  takeRetry(): boolean {
    if (this.retriesUsed >= this.retryBudget) return false;
    this.retriesUsed += 1;
    return true;
  }

  async acquire(signal?: AbortSignal): Promise<AdaptivePermit> {
    while (this.active >= this.limit || Date.now() < this.cooldownUntil) {
      const cooldownDelay = Math.max(0, this.cooldownUntil - Date.now());
      await abortableDelay(Math.min(250, Math.max(50, cooldownDelay)), signal);
      assertNotAborted(signal);
    }
    this.active += 1;
    let released = false;
    const finish = (success: boolean, transient: boolean, usageTokens = 0) => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      if (success) this.noteSuccess(usageTokens);
      else this.noteFailure(transient);
    };
    return {
      success: usageTokens => finish(true, false, usageTokens),
      failure: transient => finish(false, transient)
    };
  }

  private noteSuccess(usageTokens: number): void {
    this.consecutiveTransientFailures = 0;
    this.successes += 1;
    if (usageTokens > 0) this.tokenSamples.push({ at: Date.now(), tokens: usageTokens });
    this.trimTokenSamples();
    const recentTokens = this.tokenSamples.reduce((sum, sample) => sum + sample.tokens, 0);
    if (recentTokens > 1_500_000) this.limit = Math.max(MIN_CONCURRENCY, Math.floor(this.limit * 0.75));
    else if (this.successes >= 12 && this.limit < MAX_CONCURRENCY) {
      this.limit = Math.min(MAX_CONCURRENCY, this.limit + 4);
      this.successes = 0;
    }
  }

  private noteFailure(transient: boolean): void {
    this.successes = 0;
    if (!transient) return;
    this.consecutiveTransientFailures += 1;
    this.limit = Math.max(MIN_CONCURRENCY, Math.floor(this.limit / 2));
    if (this.consecutiveTransientFailures >= 6) {
      this.cooldownUntil = Date.now() + 15_000;
      this.consecutiveTransientFailures = 0;
    }
  }

  private trimTokenSamples(): void {
    const cutoff = Date.now() - 60_000;
    this.tokenSamples = this.tokenSamples.filter(sample => sample.at >= cutoff);
  }

}

function failedPageResult(pageNumber: number, totalPages: number, sourceFileName: string, message: string): ChunkParseResult {
  const accountNumber = `待核验-${sourceFileName.replace(/\.[^.]+$/, '')}`;
  return {
    account: {
      accountNumber, accountName: sourceFileName.replace(/\.[^.]+$/, ''), bankName: '待核验银行', ownerType: 'DEBTOR_MAIN',
      fileName: sourceFileName, fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0,
      startDate: '', endDate: '', startBalance: 0, endBalance: 0, isBalanced: false, balanceDiff: 0,
      balanceAvailable: false, parseStatus: 'NEEDS_REVIEW'
    },
    transactions: [],
    warnings: [`第 ${pageNumber} 页连续识别失败：${message}；已继续处理后续页面，请律师对照原件核验`],
    coveredPages: [pageNumber], pageStart: pageNumber, pageEnd: pageNumber, totalPages,
    expectedTransactionCount: 0, countComplete: false
  };
}

function isHardFailedPage(result: ChunkParseResult): boolean {
  return !result.transactions.length && Boolean(result.warnings?.some(warning => warning.includes('连续识别失败')));
}

async function auditSuspiciousPages(
  input: ChunkParseResult[],
  totalPages: number,
  sourceFileName: string,
  renderPage: (pageNumber: number, rotation?: number, scale?: number) => Promise<PdfPageImage>,
  requestGate: AdaptiveRequestGate,
  signal: AbortSignal | undefined,
  report: (status: string) => void
): Promise<ChunkParseResult[]> {
  const sorted = [...input].sort((a, b) => a.pageStart - b.pageStart);
  const scored = suspiciousPageScores(sorted)
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page - b.page)
    .slice(0, Math.min(80, totalPages));
  if (!scored.length) return sorted;

  report(`全局校验发现 ${scored.length} 个异常页面，正在结合相邻页复核…`);
  const resultByPage = new Map(sorted.map(result => [result.pageStart, result]));
  const imageCache = new Map<number, Promise<PdfPageImage>>();
  const getImage = (page: number) => {
    let pending = imageCache.get(page);
    if (!pending) {
      pending = renderPage(page, 0, HIGH_DETAIL_IMAGE_SCALE);
      imageCache.set(page, pending);
    }
    return pending;
  };

  await runWithConcurrency(scored, 4, async item => {
    assertNotAborted(signal);
    let permit: AdaptivePermit | undefined;
    try {
      permit = await requestGate.acquire(signal);
      const [current, before, after] = await Promise.all([
        getImage(item.page),
        item.page > 1 ? getImage(item.page - 1) : Promise.resolve(undefined),
        item.page < totalPages ? getImage(item.page + 1) : Promise.resolve(undefined)
      ]);
      const existing = resultByPage.get(item.page);
      if (!existing) {
        permit.success(0);
        permit = undefined;
        return;
      }
      const audited = await requestChunkWithContext(current, sourceFileName, signal, {
        before, after,
        auditHint: JSON.stringify({ reasons: item.reasons, transactions: existing.transactions, warnings: existing.warnings || [] })
      });
      if (preferContextAudit(existing, audited)) resultByPage.set(item.page, audited);
      permit.success(audited.usageTokens || 0);
      permit = undefined;
      report(`第 ${item.page} 页已完成跨页与余额复核`);
    } catch (error) {
      permit?.failure(isTransientWorkerError(error));
      const existing = resultByPage.get(item.page);
      if (existing) {
        existing.warnings = [...new Set([...(existing.warnings || []), `第 ${item.page} 页全局复核未能完成，已保留原结果并列入待核对`])];
        existing.transactions = existing.transactions.map(transaction => ({
          ...transaction, reviewStatus: 'PENDING', extractionConfidence: Math.min(transaction.extractionConfidence ?? 0.75, 0.6)
        }));
      }
    }
  }, signal);
  return [...resultByPage.values()].sort((a, b) => a.pageStart - b.pageStart);
}

function suspiciousPageScores(results: ChunkParseResult[]): Array<{ page: number; score: number; reasons: string[] }> {
  const output = new Map<number, { page: number; score: number; reasons: string[] }>();
  const add = (page: number, score: number, reason: string) => {
    const current = output.get(page) || { page, score: 0, reasons: [] };
    current.score += score;
    current.reasons.push(reason);
    output.set(page, current);
  };

  for (const result of results) {
    const page = result.pageStart;
    const type = result.pageQuality?.[0]?.pageType;
    const nonTransaction = type === 'ACCOUNT_INFO' || type === 'DOCUMENT' || type === 'BLANK';
    if (nonTransaction && !result.transactions.length) continue;
    if (result.countComplete === false || result.pageQuality?.some(item => item.status === 'NEEDS_REVIEW')) {
      add(page, 5, '页面清点数量与逐笔结果不一致');
    }
    const invalid = result.transactions.filter(transaction => transaction.direction === 'UNKNOWN'
      || transaction.amount <= 0 || !transaction.transactionDate || (transaction.extractionConfidence ?? 1) < 0.8);
    if (invalid.length) add(page, 8 + invalid.length, `有 ${invalid.length} 笔字段不完整或把握较低`);
    if (looksLikeAmountBalanceColumnShift(result.transactions)) add(page, 30, '疑似把余额列整体识别为发生额');
    const directionStats = pageDirectionStats(result.transactions);
    if (directionStats.comparisons >= 2 && directionStats.flippedExact / directionStats.comparisons >= 0.65
      && directionStats.currentExact / directionStats.comparisons <= 0.25) {
      add(page, 25, '余额方程显示整页收支方向可能相反');
    }
  }

  for (let index = 1; index < results.length; index += 1) {
    const previous = [...results[index - 1].transactions].sort(compareSourceOrder).at(-1);
    const current = [...results[index].transactions].sort(compareSourceOrder)[0];
    if (!previous || !current || normalizedAccount(previous.accountNumber) !== normalizedAccount(current.accountNumber)) continue;
    if (previous.balanceAvailable === false || current.balanceAvailable === false || current.direction === 'UNKNOWN') continue;
    const currentError = balanceError(previous.balance, current.amount, current.balance, current.direction);
    const flippedError = balanceError(previous.balance, current.amount, current.balance, flipDirection(current.direction));
    if (currentError >= 1 && flippedError < 1) add(results[index].pageStart, 20, '与上一页余额衔接后发现方向相反');
    else if (currentError > Math.max(100, current.amount * 0.2)) {
      add(results[index - 1].pageStart, 8, '页面边界余额无法衔接');
      add(results[index].pageStart, 12, '与上一页余额无法衔接，疑似跨页错位或漏行');
    }
  }
  return [...output.values()];
}

function preferContextAudit(existing: ChunkParseResult, audited: ChunkParseResult): boolean {
  if (!audited.transactions.length && existing.transactions.length) {
    const type = audited.pageQuality?.[0]?.pageType;
    return type === 'ACCOUNT_INFO' || type === 'DOCUMENT' || type === 'BLANK';
  }
  const score = (result: ChunkParseResult) => {
    const invalid = result.transactions.filter(transaction => transaction.direction === 'UNKNOWN'
      || transaction.amount <= 0 || !transaction.transactionDate).length;
    const continuity = pageDirectionStats(result.transactions);
    const columnShift = looksLikeAmountBalanceColumnShift(result.transactions) ? 1 : 0;
    const countGap = Math.abs((result.pageQuality?.[0]?.expectedCount ?? result.transactions.length) - result.transactions.length);
    return invalid * 1000 + columnShift * 5000 + countGap * 500 + continuity.currentError - continuity.currentExact * 10;
  };
  return score(audited) < score(existing) || audited.transactions.length > existing.transactions.length;
}

function looksLikeAmountBalanceColumnShift(transactions: StandardTransaction[]): boolean {
  if (transactions.length < 3) return false;
  const zeroBalances = transactions.filter(transaction => transaction.balanceAvailable !== false && Math.abs(transaction.balance) < 0.005).length;
  const positiveAmounts = transactions.filter(transaction => transaction.amount > 10).length;
  return zeroBalances / transactions.length >= 0.8 && positiveAmounts / transactions.length >= 0.8;
}

function pageDirectionStats(transactions: StandardTransaction[]): {
  comparisons: number; currentExact: number; flippedExact: number; currentError: number;
} {
  const ordered = [...transactions].sort(compareSourceOrder);
  let comparisons = 0;
  let currentExact = 0;
  let flippedExact = 0;
  let currentError = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.balanceAvailable === false || current.balanceAvailable === false || current.direction === 'UNKNOWN') continue;
    const direct = balanceError(previous.balance, current.amount, current.balance, current.direction);
    const flipped = balanceError(previous.balance, current.amount, current.balance, flipDirection(current.direction));
    comparisons += 1;
    currentError += Math.min(direct, 1_000_000);
    if (direct < 1) currentExact += 1;
    if (flipped < 1) flippedExact += 1;
  }
  return { comparisons, currentExact, flippedExact, currentError };
}

function balanceError(previousBalance: number, amount: number, currentBalance: number, direction: StandardTransaction['direction']): number {
  if (direction === 'UNKNOWN') return Number.POSITIVE_INFINITY;
  const expected = previousBalance + (direction === 'IN' ? amount : -amount);
  return Math.abs(expected - currentBalance);
}

function flipDirection(direction: StandardTransaction['direction']): StandardTransaction['direction'] {
  return direction === 'IN' ? 'OUT' : direction === 'OUT' ? 'IN' : 'UNKNOWN';
}

function normalizedAccount(value: string): string {
  return value.replace(/[\s\-_—–·•]/g, '').toLocaleLowerCase();
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}

async function requestChunk(chunk: PdfPageImage, sourceFileName: string, signal?: AbortSignal): Promise<ChunkParseResult> {
  return requestChunkWithContext(chunk, sourceFileName, signal);
}

async function requestChunkWithContext(
  chunk: PdfPageImage,
  sourceFileName: string,
  signal?: AbortSignal,
  context?: { before?: PdfPageImage; after?: PdfPageImage; auditHint?: string; isPageSlice?: boolean }
): Promise<ChunkParseResult> {
  const formData = new FormData();
  formData.append('file', chunk.file);
  formData.append('sourceFileName', sourceFileName);
  formData.append('pageStart', String(chunk.pageStart));
  formData.append('pageEnd', String(chunk.pageEnd));
  formData.append('totalPages', String(chunk.totalPages));
  formData.append('chunkId', chunk.id);
  if (context?.before) formData.append('contextBefore', context.before.file);
  if (context?.after) formData.append('contextAfter', context.after.file);
  if (context?.auditHint) formData.append('auditHint', context.auditHint);
  if (context?.isPageSlice) formData.append('isPageSlice', 'true');

  const requestController = new AbortController();
  const timeout = setTimeout(() => requestController.abort(new DOMException('页面解析等待超时', 'TimeoutError')), REQUEST_TIMEOUT_MS);
  const abortFromParent = () => requestController.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromParent, { once: true });
  try {
    const response = await fetch('/api/parse-bank-statement-stream', { method: 'POST', body: formData, signal: requestController.signal });
    if (!response.ok) throw new Error(`解析服务暂时不可用（${response.status}），系统将自动重试`);
    if (!response.body) throw new Error('未收到页面解析结果');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: ChunkParseResult | undefined;
    let serverError = '';
    const processLines = (lines: string[]) => {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        const payload = JSON.parse(data);
        if (payload.type === 'complete') result = payload as ChunkParseResult;
        if (payload.type === 'error') serverError = payload.message || '页面解析失败';
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      processLines(lines);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processLines(buffer.split('\n'));
    if (serverError) throw new Error(serverError);
    if (!result?.account || !Array.isArray(result.transactions)) throw new Error('未能完整获取该页结构化数据');
    return result;
  } catch (error) {
    if (requestController.signal.aborted && !signal?.aborted) throw new Error('页面解析等待超时，系统将自动重试');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

const CACHE_DB = 'lawflow-pdf-recovery';
const CACHE_STORE = 'ranges';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function readCachedResults(cacheKey: string): Promise<ChunkParseResult[]> {
  try {
    const db = await openRecoveryDb();
    const records = await new Promise<any[]>((resolve, reject) => {
      const request = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const fresh = records
      .filter(record => record.cacheKey === cacheKey && Date.now() - record.savedAt < CACHE_TTL_MS)
      .map(record => record.result as ChunkParseResult)
      .sort((a, b) => a.pageStart - b.pageStart);
    return fresh;
  } catch {
    return [];
  }
}

async function writeCachedResults(cacheKey: string, results: ChunkParseResult[]): Promise<void> {
  try {
    const db = await openRecoveryDb();
    const transaction = db.transaction(CACHE_STORE, 'readwrite');
    const store = transaction.objectStore(CACHE_STORE);
    for (const result of results) {
      store.put({
        id: `${cacheKey}|${result.pageStart}-${result.pageEnd}`,
        cacheKey,
        savedAt: Date.now(),
        result
      });
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  } catch {
    // Recovery storage is best-effort and must never block evidence parsing.
  }
}

export async function clearPdfRecoveryCacheForFile(fileName: string): Promise<void> {
  try {
    const db = await openRecoveryDb();
    const transaction = db.transaction(CACHE_STORE, 'readwrite');
    const store = transaction.objectStore(CACHE_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      for (const record of request.result || []) {
        const cachedFileName = record.result?.account?.fileName;
        const belongsToFile = cachedFileName === fileName
          || String(record.cacheKey || '').includes(`|${fileName}|`);
        if (belongsToFile) store.delete(record.id);
      }
    };
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  } catch {
    // Cache removal is best-effort; deleting the case data must still succeed.
  }
}

function openRecoveryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CACHE_STORE)) request.result.createObjectStore(CACHE_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runWithConcurrency<T>(
  items: T[], concurrency: number, worker: (item: T) => Promise<void>, signal?: AbortSignal
): Promise<void> {
  let nextIndex = 0;
  let firstError: unknown;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length && !firstError) {
      try {
        assertNotAborted(signal);
        const item = items[nextIndex];
        nextIndex += 1;
        await worker(item);
      } catch (error) {
        firstError ||= error;
      }
    }
  });
  await Promise.all(runners);
  if (firstError) throw firstError;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已停止 PDF 解析', 'AbortError');
}
