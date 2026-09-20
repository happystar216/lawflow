import { BankAccount, StandardTransaction } from '../types/transaction';
import { createPdfPageImageRenderer, getPdfPageCount, PdfPageImage } from './pdfPageImageRenderer';
import { mergeQwenChunkResults as mergeVerifiedChunks } from './qwenResultMerger';
export { mergeQwenChunkResults } from './qwenResultMerger';

// The production worker starts returning 503s when several long PDF segments
// reach the model at once. Start serially, and only grow to two requests after
// a sustained clean run. A retry storm is slower than conservative dispatch.
const MAX_CONCURRENCY = 2;
const INITIAL_CONCURRENCY = 1;
const MIN_CONCURRENCY = 1;
const REQUEST_TIMEOUT_MS = 150_000;
const CACHE_VERSION = 'segment-pdf-v14-single-page-recovery';
const PAGE_MAP_BATCH_SIZE = 8;
const THUMBNAIL_SCALE = 0.42;
const SEGMENT_PDF_MAX_PAGES = 4;

type PageMapType = 'TRANSACTIONS' | 'ACCOUNT_INFO' | 'DOCUMENT' | 'BLANK' | 'UNKNOWN';
export interface PageMapItem {
  page: number;
  pageType: PageMapType;
  rotation: 0 | 90 | 180 | 270;
  bankName: string;
  accountName: string;
  accountNumbers: string[];
  density: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
  locallyBlank?: boolean;
  segmentId?: string;
  segmentStart?: number;
  segmentEnd?: number;
  segmentBankName?: string;
  segmentAccountNumbers?: string[];
}

export interface QwenProgressInfo {
  currentPage: number;
  totalPages: number;
  percent: number;
  totalTransactions: number;
  statusText?: string;
}

export interface ChunkParseResult {
  account: BankAccount;
  accounts?: BankAccount[];
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

export async function parsePdfWithQwen(
  file: File,
  onProgress?: (info: QwenProgressInfo) => void,
  signal?: AbortSignal,
  options?: { cacheIdentity?: string }
): Promise<{ account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] }> {
  const pageCount = await getPdfPageCount(file);
  // Small documents can use the low-latency direct path. Long documents must
  // be page-audited so one output limit or timeout cannot discard the volume.
  if (pageCount <= 20) {
    try {
      const directResult = await parsePdfDirectStream(file, pageCount, onProgress, signal);
      if (directResult && directResult.transactions.length > 0) return directResult;
    } catch (err: any) {
      console.warn('整份直传未完成，切换至逐页识别:', err.message);
    }
  }

  // 2. Long documents are mapped with tiny navigation thumbnails, then the
  // original PDF pages are copied into small in-memory PDFs. Transaction
  // extraction never uses rendered or rotated page images.
  onProgress?.({ currentPage: 0, totalPages: 0, percent: 0, totalTransactions: 0,
    statusText: '正在扫描 PDF 页面并建立银行、账户分段…' });
  const renderer = await createPdfPageImageRenderer(file);
  const totalPages = renderer.totalPages;
  const cacheKey = `${CACHE_VERSION}|${options?.cacheIdentity || `${file.name}|${file.size}|${file.lastModified}`}|${totalPages}`;
  const results: ChunkParseResult[] = [];
  const cachedResults = await readCachedResults(cacheKey);
  const cachedByPage = new Map(cachedResults.map(result => [result.pageStart, result]));
  const uncachedPages = Array.from({ length: totalPages }, (_, index) => index + 1)
    .filter(page => !cachedByPage.has(page));
  const rawPageMap = uncachedPages.length
    ? await buildPageMap(uncachedPages, totalPages, renderer.renderPage, signal, statusText => onProgress?.({
        currentPage: 0, totalPages, percent: 1, totalTransactions: 0, statusText
      }))
    : new Map<number, PageMapItem>();
  const pageMap = buildSegmentedPageMap(rawPageMap, cachedByPage, totalPages);
  const segmentCount = new Set([...pageMap.values()].map(item => item.segmentId).filter(Boolean)).size;

  const requestGate = new AdaptiveRequestGate(totalPages);
  let completedPages = 0;
  let totalTransactions = 0;
  let recoveryActive = false;
  let recoveryCompleted = 0;
  let recoveryTotal = 0;

  const report = (statusText: string) => onProgress?.({
    currentPage: completedPages,
    totalPages,
    percent: recoveryActive
      ? Math.min(98, 90 + Math.round((recoveryCompleted / Math.max(1, recoveryTotal)) * 8))
      : Math.min(88, Math.round(completedPages / totalPages * 88)),
    totalTransactions,
    statusText
  });
  report(`共 ${totalPages} 页，已按银行和账户划分 ${segmentCount || 1} 个页段，正在分别识别…`);

  try {
    const completed = new Set<number>();
    const acceptPage = async (result: ChunkParseResult, label: string) => {
      if (completed.has(result.pageStart)) return;
      completed.add(result.pageStart);
      results.push(result);
      completedPages += 1;
      totalTransactions += result.transactions.length;
      if (!cachedByPage.has(result.pageStart) && !isHardFailedPage(result)) await writeCachedResults(cacheKey, [result]);
      report(`${label}第 ${result.pageStart} 页，累计提取 ${totalTransactions} 笔交易`);
    };

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const cached = cachedByPage.get(pageNumber);
      if (cached) await acceptPage(cached, '已恢复');
      else if (pageMap.get(pageNumber)?.locallyBlank) {
        await acceptPage(blankPageResult(pageNumber, totalPages, file.name), '已跳过空白');
      }
    }

    const pendingPages = Array.from({ length: totalPages }, (_, index) => index + 1)
      .filter(page => !completed.has(page));
    const segmentChunks = await createSegmentPdfChunks(file, pageMap, pendingPages, totalPages).catch(error => {
      console.warn('无法建立内存分段 PDF:', error);
      return [];
    });
    report(`已生成 ${segmentChunks.length} 个银行/账户识别分段，正在逐段调用识别接口…`);

    await runWithConcurrency(segmentChunks, MAX_CONCURRENCY, async chunk => {
      assertNotAborted(signal);
      let segmentPages: ChunkParseResult[] = [];
      try {
        const segmentResult = await parseSegmentPdfWithRetry(
          chunk, pageMap, file.name, requestGate, signal, report, 3
        );
        segmentPages = splitSegmentResultByPage(segmentResult, chunk, pageMap, file.name);
      } catch (error) {
        segmentPages = chunkPages(chunk).map(page => failedPageResult(
          page, totalPages, file.name, error instanceof Error ? error.message : String(error)
        ));
      }

      for (const result of segmentPages) {
        if (!completed.has(result.pageStart)) await acceptPage(result, '已完成');
      }
    }, signal);

    // A defensive fallback keeps a malformed segment response from silently
    // dropping pages from the final document.
    for (const pageNumber of pendingPages.filter(page => !completed.has(page))) {
      const result = failedPageResult(pageNumber, totalPages, file.name, '未找到对应的 PDF 分段');
      await acceptPage(result, '已补识别');
    }

    const recoveryCandidates = results.filter(result => needsFinalPageRecovery(result, pageMap.get(result.pageStart)));
    if (recoveryCandidates.length) {
      recoveryActive = true;
      recoveryTotal = recoveryCandidates.length;
      const recoveryChunks = await createSinglePageRecoveryChunks(
        file,
        pageMap,
        recoveryCandidates.map(result => result.pageStart),
        totalPages
      ).catch(error => {
        console.warn('无法建立单页补偿 PDF:', error);
        return [];
      });
      report(`首次识别已完成，正在逐页补偿 ${recoveryCandidates.length} 个疑似漏页或服务失败页（0/${recoveryCandidates.length}）…`);
      if (recoveryChunks.length) await abortableDelay(10_000, signal);
      const recoveryGate = new AdaptiveRequestGate(totalPages);
      await runWithConcurrency(recoveryChunks, 1, async chunk => {
        let recoveredSegment: ChunkParseResult;
        try {
          recoveredSegment = await parseSegmentPdfWithRetry(
            chunk, pageMap, file.name, recoveryGate, signal, report, 4
          );
        } catch {
          recoveryCompleted += 1;
          report(`失败页补偿进度 ${recoveryCompleted}/${recoveryTotal}；未恢复页面会保留为阻断性核对事项…`);
          return;
        }
        for (const recovered of splitSegmentResultByPage(recoveredSegment, chunk, pageMap, file.name)) {
          const index = results.findIndex(item => item.pageStart === recovered.pageStart);
          if (index < 0) continue;
          const existing = results[index];
          if (!isHardFailedPage(existing) && qualityScore(recovered) <= qualityScore(existing)) continue;
          results[index] = recovered;
          totalTransactions += recovered.transactions.length - existing.transactions.length;
          if (!isHardFailedPage(recovered)) await writeCachedResults(cacheKey, [recovered]);
        }
        recoveryCompleted += 1;
        report(`失败页补偿进度 ${recoveryCompleted}/${recoveryTotal}，累计提取 ${totalTransactions} 笔交易`);
      }, signal);
    }
    const finalResults = [...results].sort((a, b) => a.pageStart - b.pageStart);
    await writeCachedResults(cacheKey, finalResults.filter(result => !isHardFailedPage(result)));
    const merged = mergeVerifiedChunks(finalResults, file.name, totalPages);
    const failedPages = finalResults.filter(isHardFailedPage).map(result => result.pageStart);
    onProgress?.({
      currentPage: totalPages,
      totalPages,
      percent: 100,
      totalTransactions,
      statusText: failedPages.length
        ? `已读取 ${totalTransactions} 笔流水；仍有 ${failedPages.length} 页未能可靠识别，必须重新识别或人工补录后才能分析`
        : `识别与完整性检查完成，共读取 ${totalTransactions} 笔流水`
    });
    return merged;
  } finally {
    await renderer.destroy();
  }
}

function needsFinalPageRecovery(result: ChunkParseResult, mapped?: PageMapItem): boolean {
  if (result.warnings?.some(warning => warning.includes('连续识别失败'))) return true;
  const expected = result.expectedTransactionCount ?? result.pageQuality?.[0]?.expectedCount;
  if (expected !== undefined && expected > result.transactions.length) return true;
  if (result.pageQuality?.[0]?.status === 'NEEDS_REVIEW'
    && (mapped?.pageType === 'TRANSACTIONS' || mapped?.density === 'HIGH')) return true;
  if (result.transactions.length > 0) return false;
  if (!mapped) return false;
  return mapped.pageType === 'TRANSACTIONS' || mapped.density === 'HIGH';
}

async function buildPageMap(
  pages: number[],
  totalPages: number,
  renderPage: (pageNumber: number, rotation?: number, scale?: number) => Promise<PdfPageImage>,
  signal: AbortSignal | undefined,
  report: (status: string) => void
): Promise<Map<number, PageMapItem>> {
  report(`正在快速扫描 ${pages.length} 个未缓存页面，过滤空白页并建立文档地图…`);
  const thumbnails = new Map<number, PdfPageImage>();
  const likelyBlank = new Set<number>();
  await runWithConcurrency(pages, 4, async page => {
    assertNotAborted(signal);
    const thumbnail = await renderPage(page, 0, THUMBNAIL_SCALE);
    thumbnails.set(page, thumbnail);
    const blankness = await analyzeThumbnailBlankness(thumbnail.file);
    if (blankness !== 'CONTENT') likelyBlank.add(page);
  }, signal);

  const result = new Map<number, PageMapItem>();
  // Even a locally white-looking page goes through the thumbnail classifier.
  // Faint dot-matrix rows and sparse account lists must not be silently skipped.
  const visiblePages = pages;
  const batches: number[][] = [];
  for (let index = 0; index < visiblePages.length; index += PAGE_MAP_BATCH_SIZE) {
    batches.push(visiblePages.slice(index, index + PAGE_MAP_BATCH_SIZE));
  }
  let completed = 0;
  await runWithConcurrency(batches, 2, async batch => {
    assertNotAborted(signal);
    try {
      const sheet = await createThumbnailSheet(batch.map(page => thumbnails.get(page)!));
      const mapped = await requestPageMap(sheet, batch, signal);
      for (const item of mapped) {
        result.set(item.page, {
          ...item,
          locallyBlank: item.pageType === 'BLANK' && item.confidence >= 0.97 && likelyBlank.has(item.page)
        });
      }
    } catch {
      for (const page of batch) result.set(page, unknownPageMap(page));
    }
    completed += batch.length;
    report(`文档地图已分析 ${completed}/${visiblePages.length} 个非空白页面…`);
  }, signal);
  for (const page of pages) if (!result.has(page)) result.set(page, unknownPageMap(page));
  return result;
}

export interface VirtualDocumentSegment {
  id: string;
  pageStart: number;
  pageEnd: number;
  pages: number[];
  bankName: string;
  accountNumbers: string[];
  rotation: 0 | 90 | 180 | 270;
}

export interface SegmentPdfChunk extends PdfPageImage {
  segmentId: string;
  bankName: string;
  accountNumbers: string[];
  pages: number[];
}

export function buildSegmentedPageMap(
  rawPageMap: Map<number, PageMapItem>,
  cachedByPage: Map<number, ChunkParseResult>,
  totalPages: number
): Map<number, PageMapItem> {
  const mappedPages = new Set(rawPageMap.keys());
  const combined = new Map<number, PageMapItem>();
  for (let page = 1; page <= totalPages; page += 1) {
    const mapped = rawPageMap.get(page);
    if (mapped) {
      combined.set(page, { ...mapped });
      continue;
    }
    const cached = cachedByPage.get(page);
    combined.set(page, cached ? pageMapFromCachedResult(cached, page) : unknownPageMap(page));
  }

  const segments = buildVirtualDocumentSegments(combined);
  for (const segment of segments) {
    const rotationVotes = new Map<0 | 90 | 180 | 270, number>();
    for (const page of segment.pages) {
      if (!mappedPages.has(page)) continue;
      const item = combined.get(page);
      if (!item || item.pageType === 'BLANK' || item.confidence < 0.55) continue;
      rotationVotes.set(item.rotation, (rotationVotes.get(item.rotation) || 0) + 1);
    }
    const dominantRotation = [...rotationVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? segment.rotation;
    for (const page of segment.pages) {
      const item = combined.get(page)!;
      combined.set(page, {
        ...item,
        rotation: item.confidence >= 0.55 && mappedPages.has(page) ? item.rotation : dominantRotation,
        segmentId: segment.id,
        segmentStart: segment.pageStart,
        segmentEnd: segment.pageEnd,
        segmentBankName: segment.bankName,
        segmentAccountNumbers: segment.accountNumbers
      });
    }
  }
  return combined;
}

export function buildVirtualDocumentSegments(pageMap: Map<number, PageMapItem>): VirtualDocumentSegment[] {
  const items = [...pageMap.values()].sort((a, b) => a.page - b.page);
  const segments: VirtualDocumentSegment[] = [];
  let current: VirtualDocumentSegment | undefined;
  let currentIdentity = '';

  const startSegment = (item: PageMapItem, identity: string) => {
    const accounts = reliableMapAccounts(item);
    const bankName = cleanMapIdentity(item.bankName);
    current = {
      id: `SEG_${item.page}_${stableSegmentHash(`${identity || 'unassigned'}|${item.page}`)}`,
      pageStart: item.page,
      pageEnd: item.page,
      pages: [item.page],
      bankName,
      accountNumbers: accounts,
      rotation: item.rotation
    };
    currentIdentity = identity;
    segments.push(current);
  };

  for (const item of items) {
    const identity = pageMapIdentity(item);
    if (!current) {
      startSegment(item, identity);
      continue;
    }
    const shouldSplit = Boolean(identity && currentIdentity && identity !== currentIdentity);
    if (shouldSplit) {
      startSegment(item, identity);
      continue;
    }
    current.pages.push(item.page);
    current.pageEnd = item.page;
    if (!currentIdentity && identity) {
      currentIdentity = identity;
      current.bankName = cleanMapIdentity(item.bankName);
      current.accountNumbers = reliableMapAccounts(item);
    }
  }
  return segments;
}

async function createSegmentPdfChunks(
  sourceFile: File,
  pageMap: Map<number, PageMapItem>,
  pendingPages: number[],
  totalPages: number
): Promise<SegmentPdfChunk[]> {
  if (!pendingPages.length) return [];
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(await sourceFile.arrayBuffer());
  const pending = new Set(pendingPages);
  const chunks: SegmentPdfChunk[] = [];

  for (const segment of buildVirtualDocumentSegments(pageMap)) {
    const runs = buildSegmentPageRuns(segment.pages, pending, SEGMENT_PDF_MAX_PAGES);
    for (const [partIndex, run] of runs.entries()) {
      const document = await PDFDocument.create();
      const copiedPages = await document.copyPages(source, run.map(page => page - 1));
      copiedPages.forEach(page => document.addPage(page));
      const bytes = await document.save({ useObjectStreams: true });
      const fileBytes = Uint8Array.from(bytes).buffer;
      const bankLabel = safeSegmentFileLabel(segment.bankName || '待确认银行');
      const accountLabel = safeSegmentFileLabel(segment.accountNumbers.join('-') || '待确认账号');
      const pageStart = run[0];
      const pageEnd = run.at(-1)!;
      chunks.push({
        id: `${segment.id}-PART${partIndex + 1}-P${pageStart}-${pageEnd}`,
        segmentId: segment.id,
        bankName: segment.bankName,
        accountNumbers: segment.accountNumbers,
        pages: run,
        file: new File([fileBytes], `${bankLabel}_${accountLabel}_原第${pageStart}-${pageEnd}页.pdf`, { type: 'application/pdf' }),
        pageStart,
        pageEnd,
        totalPages,
        rotation: segment.rotation,
        scale: 1
      });
    }
  }
  return chunks;
}

async function createSinglePageRecoveryChunks(
  sourceFile: File,
  pageMap: Map<number, PageMapItem>,
  pages: number[],
  totalPages: number
): Promise<SegmentPdfChunk[]> {
  if (!pages.length) return [];
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(await sourceFile.arrayBuffer());
  const chunks: SegmentPdfChunk[] = [];
  for (const pageNumber of [...new Set(pages)].sort((left, right) => left - right)) {
    const mapped = pageMap.get(pageNumber);
    const document = await PDFDocument.create();
    const [copiedPage] = await document.copyPages(source, [pageNumber - 1]);
    document.addPage(copiedPage);
    const bytes = await document.save({ useObjectStreams: true });
    const fileBytes = Uint8Array.from(bytes).buffer;
    chunks.push({
      id: `RECOVERY-P${pageNumber}`,
      segmentId: mapped?.segmentId || `RECOVERY-P${pageNumber}`,
      bankName: mapped?.segmentBankName || mapped?.bankName || '',
      accountNumbers: mapped?.segmentAccountNumbers || mapped?.accountNumbers || [],
      pages: [pageNumber],
      file: new File([fileBytes], `原第${pageNumber}页_补偿识别.pdf`, { type: 'application/pdf' }),
      pageStart: pageNumber,
      pageEnd: pageNumber,
      totalPages,
      rotation: mapped?.rotation || 0,
      scale: 1
    });
  }
  return chunks;
}

export function buildSegmentPageRuns(pages: number[], pending: Set<number>, maxPages = SEGMENT_PDF_MAX_PAGES): number[][] {
  const firstPendingIndex = pages.findIndex(page => pending.has(page));
  if (firstPendingIndex < 0) return [];
  const runs: number[][] = [];
  // Keep blank backs and already-cached neighbours inside the in-memory PDF.
  // They preserve the original page sequence and prevent a duplex statement
  // from degenerating back into one request per printed front page.
  for (let index = firstPendingIndex; index < pages.length; index += maxPages) {
    const run = pages.slice(index, index + maxPages);
    if (run.some(page => pending.has(page))) runs.push(run);
  }
  return runs;
}

function safeSegmentFileLabel(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48) || '未确认';
}

function segmentChunkAuditHint(chunk: SegmentPdfChunk, pageMap: Map<number, PageMapItem>): string {
  const pageDetails = chunk.pages.map(page => {
    const item = pageMap.get(page);
    return `原第${page}页:${item?.pageType || 'UNKNOWN'}/${item?.density || 'LOW'}`;
  }).join('；');
  return `这是已按银行和本方账户隔离的独立分段。银行：${chunk.bankName || '未确认'}；本方账号：${chunk.accountNumbers.join('、') || '未确认'}；原文件页码 ${chunk.pageStart}-${chunk.pageEnd}。当前 PDF 内第1页对应原文件第${chunk.pageStart}页。不得引入其他分段的银行或账号。页面导航：${pageDetails}`;
}

async function parseSegmentPdfWithRetry(
  chunk: SegmentPdfChunk,
  pageMap: Map<number, PageMapItem>,
  sourceFileName: string,
  requestGate: AdaptiveRequestGate,
  signal: AbortSignal | undefined,
  report: (status: string) => void,
  maxAttempts: number
): Promise<ChunkParseResult> {
  let best: ChunkParseResult | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0 && !requestGate.takeRetry()) break;
    let permit: AdaptivePermit | undefined;
    try {
      assertNotAborted(signal);
      if (attempt > 0) {
        report(`原第 ${chunk.pageStart}-${chunk.pageEnd} 页 PDF 分段正在进行第 ${attempt + 1} 次识别…`);
      }
      permit = await requestGate.acquire(signal);
      const candidate = await requestChunkWithContext(chunk, sourceFileName, signal, {
        auditHint: segmentChunkAuditHint(chunk, pageMap),
        isPageSlice: true,
        verificationMode: attempt === 0 ? 'skip' : 'always'
      });
      permit.success(candidate.usageTokens || 0);
      permit = undefined;
      if (!best || qualityScore(candidate) > qualityScore(best)) best = candidate;

      const pages = splitSegmentResultByPage(candidate, chunk, pageMap, sourceFileName);
      if (!pages.some(page => shouldRetrySegmentPdfPage(page, pageMap.get(page.pageStart)))) return candidate;
      if (attempt < maxAttempts - 1) await abortableDelay(1_200 * (attempt + 1), signal);
    } catch (error) {
      lastError = error;
      const transient = isTransientWorkerError(error);
      permit?.failure(transient);
      permit = undefined;
      assertNotAborted(signal);
      if (attempt < maxAttempts - 1) {
        const delay = transient ? Math.min(60_000, 10_000 * 2 ** attempt) : 1_500 * (attempt + 1);
        await abortableDelay(delay, signal);
      }
    }
  }

  if (best) return best;
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'PDF 分段识别失败'));
}

function shouldRetrySegmentPdfPage(result: ChunkParseResult, mapped?: PageMapItem): boolean {
  if (isHardFailedPage(result)) return true;
  if (mapped?.pageType === 'TRANSACTIONS' && result.transactions.length === 0) return true;
  const expected = result.expectedTransactionCount ?? result.pageQuality?.[0]?.expectedCount;
  return expected !== undefined && expected > result.transactions.length;
}

function chunkPages(chunk: SegmentPdfChunk): number[] {
  return chunk.pages.length ? chunk.pages : Array.from(
    { length: chunk.pageEnd - chunk.pageStart + 1 }, (_, index) => chunk.pageStart + index
  );
}

export function splitSegmentResultByPage(
  segmentResult: ChunkParseResult,
  chunk: SegmentPdfChunk,
  pageMap: Map<number, PageMapItem>,
  sourceFileName: string
): ChunkParseResult[] {
  const normalizedTransactions = segmentResult.transactions.map(transaction => ({
    ...transaction,
    rawPageNumber: transaction.rawPageNumber,
    rawSourceFile: sourceFileName,
    sourceFileName
  }));
  return chunkPages(chunk).map(page => {
    const transactions = normalizedTransactions.filter(transaction => transaction.rawPageNumber === page)
      .sort(compareSourceOrder);
    const quality = segmentResult.pageQuality?.find(item => item.page === page);
    const expected = quality?.expectedCount ?? transactions.length;
    const dates = transactions.map(transaction => transaction.transactionDate).filter(Boolean).sort();
    const balances = transactions.filter(transaction => transaction.balanceAvailable !== false).map(transaction => transaction.balance);
    const first = transactions[0];
    const mapped = pageMap.get(page);
    const pageWarnings = (segmentResult.warnings || [])
      .filter(warning => warning.includes(`第 ${page} 页`) || !/第\s*\d+\s*页/.test(warning));
    const account: BankAccount = {
      ...segmentResult.account,
      fileName: sourceFileName,
      accountNumber: first?.accountNumber || mapped?.accountNumbers[0] || segmentResult.account.accountNumber,
      accountName: first?.accountName || mapped?.accountName || segmentResult.account.accountName,
      bankName: first?.bankName || mapped?.bankName || segmentResult.account.bankName,
      totalIn: transactions.filter(item => item.direction === 'IN').reduce((sum, item) => sum + item.amount, 0),
      totalOut: transactions.filter(item => item.direction === 'OUT').reduce((sum, item) => sum + item.amount, 0),
      transactionCount: transactions.length,
      startDate: dates[0] || '',
      endDate: dates.at(-1) || '',
      startBalance: balances[0] ?? 0,
      endBalance: balances.at(-1) ?? 0,
      balanceAvailable: balances.length > 0,
      coveredPages: [page],
      totalPages: chunk.totalPages,
      parseWarnings: pageWarnings
    };
    return {
      account,
      accounts: segmentResult.accounts?.map(listedAccount => ({
        ...listedAccount,
        fileName: sourceFileName,
        totalPages: chunk.totalPages
      })),
      transactions,
      warnings: pageWarnings,
      coveredPages: [page],
      pageStart: page,
      pageEnd: page,
      totalPages: chunk.totalPages,
      expectedTransactionCount: expected,
      countComplete: quality ? quality.status === 'COMPLETE' : true,
      usageTokens: page === chunk.pageStart ? segmentResult.usageTokens : 0,
      pageQuality: [{
        page,
        expectedCount: expected,
        extractedCount: transactions.length,
        status: quality?.status || 'COMPLETE',
        pageType: quality?.pageType || mapped?.pageType || (transactions.length ? 'TRANSACTIONS' : 'UNKNOWN')
      }]
    };
  });
}

function shouldRefineSegmentPage(result: ChunkParseResult, mapped?: PageMapItem): boolean {
  const quality = result.pageQuality?.[0];
  if (isHardFailedPage(result) || quality?.status === 'NEEDS_REVIEW') return true;
  if (result.transactions.some(transaction => transaction.dataQualityIssues?.length
    || transaction.direction === 'UNKNOWN' || transaction.amount <= 0 || !transaction.transactionDate)) return true;
  if (mapped?.pageType === 'TRANSACTIONS' && result.transactions.length === 0) return true;
  return false;
}

function pageMapFromCachedResult(result: ChunkParseResult, page: number): PageMapItem {
  const transactionIdentities = new Map<string, { count: number; bankName: string; accountName: string }>();
  for (const transaction of result.transactions) {
    const account = cleanMapIdentity(transaction.accountNumber);
    if (!account || account.startsWith('待核验')) continue;
    const current = transactionIdentities.get(account) || { count: 0, bankName: '', accountName: '' };
    current.count += 1;
    current.bankName ||= cleanMapIdentity(transaction.bankName);
    current.accountName ||= cleanMapIdentity(transaction.accountName);
    transactionIdentities.set(account, current);
  }
  const dominant = [...transactionIdentities.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  const fallbackAccount = cleanMapIdentity(result.account.accountNumber);
  const accountNumbers = dominant ? [dominant[0]] : fallbackAccount && !fallbackAccount.startsWith('待核验') ? [fallbackAccount] : [];
  return {
    page,
    pageType: result.pageQuality?.[0]?.pageType || (result.transactions.length ? 'TRANSACTIONS' : 'UNKNOWN'),
    rotation: 0,
    bankName: dominant?.[1].bankName || cleanMapIdentity(result.account.bankName),
    accountName: dominant?.[1].accountName || cleanMapIdentity(result.account.accountName),
    accountNumbers,
    density: result.transactions.length >= 20 ? 'HIGH' : result.transactions.length >= 8 ? 'MEDIUM' : 'LOW',
    confidence: accountNumbers.length ? 0.8 : 0.2,
    locallyBlank: result.pageQuality?.[0]?.pageType === 'BLANK' && result.countComplete === true
  };
}

function pageMapIdentity(item: PageMapItem): string {
  if (item.pageType === 'BLANK') return '';
  const bank = cleanMapIdentity(item.bankName).toLocaleLowerCase();
  const accounts = reliableMapAccounts(item);
  if (accounts.length > 1) return `meta|${bank}|${accounts.sort().join(',')}`;
  if (accounts.length === 1) return `account|${bank}|${accounts[0]}`;
  return bank ? `bank|${bank}` : '';
}

function reliableMapAccounts(item: PageMapItem): string[] {
  return [...new Set((item.accountNumbers || []).map(cleanMapIdentity)
    .filter(value => value && !value.startsWith('待核验')))];
}

function cleanMapIdentity(value: string | undefined): string {
  return String(value || '').replace(/[\s\-_—–·•]/g, '').trim();
}

function stableSegmentHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase();
}

async function analyzeThumbnailBlankness(file: File): Promise<'DEFINITE' | 'LIKELY' | 'CONTENT'> {
  const bitmap = await createImageBitmap(file);
  try {
    const width = 96;
    const height = Math.max(96, Math.round(width * bitmap.height / Math.max(1, bitmap.width)));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return 'CONTENT';
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let ink = 0;
    let dark = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      const luminance = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
      if (luminance < 242) ink += 1;
      if (luminance < 205) dark += 1;
    }
    const samples = pixels.length / 16;
    const inkRatio = ink / samples;
    const darkRatio = dark / samples;
    if (inkRatio < 0.0015 && darkRatio < 0.00025) return 'DEFINITE';
    if (inkRatio < 0.02 && darkRatio < 0.004) return 'LIKELY';
    return 'CONTENT';
  } finally {
    bitmap.close();
  }
}

async function createThumbnailSheet(images: PdfPageImage[]): Promise<File> {
  const columns = Math.min(4, images.length);
  const rows = Math.ceil(images.length / columns);
  const tileWidth = 300;
  const tileHeight = 390;
  const headerHeight = 30;
  const canvas = document.createElement('canvas');
  canvas.width = columns * tileWidth;
  canvas.height = rows * tileHeight;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法生成页面地图缩略图');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = 'bold 18px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const bitmap = await createImageBitmap(image.file);
    try {
      const x = (index % columns) * tileWidth;
      const y = Math.floor(index / columns) * tileHeight;
      context.fillStyle = '#111827';
      context.fillText(`原PDF第 ${image.pageStart} 页`, x + tileWidth / 2, y + headerHeight / 2);
      const availableHeight = tileHeight - headerHeight - 8;
      const scale = Math.min((tileWidth - 8) / bitmap.width, availableHeight / bitmap.height);
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;
      context.drawImage(bitmap, x + (tileWidth - width) / 2, y + headerHeight + (availableHeight - height) / 2, width, height);
      context.strokeStyle = '#94a3b8';
      context.strokeRect(x + 1, y + 1, tileWidth - 2, tileHeight - 2);
    } finally {
      bitmap.close();
    }
  }
  const blob = await canvasBlob(canvas, 'image/jpeg', 0.82);
  canvas.width = 1;
  canvas.height = 1;
  return new File([blob], `page-map-${images[0]?.pageStart || 1}.jpg`, { type: 'image/jpeg' });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('无法生成页面导航缩略图')),
    type,
    quality
  ));
}

async function requestPageMap(file: File, pages: number[], signal?: AbortSignal): Promise<PageMapItem[]> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('pageNumbers', pages.join(','));
  const response = await fetch('/api/classify-bank-pages', { method: 'POST', body: formData, signal });
  if (!response.ok) throw new Error(`页面地图服务暂时不可用（${response.status}）`);
  const payload = await response.json() as { pages?: PageMapItem[] };
  return Array.isArray(payload.pages) ? payload.pages : [];
}

function unknownPageMap(page: number): PageMapItem {
  return { page, pageType: 'UNKNOWN', rotation: 0, bankName: '', accountName: '', accountNumbers: [], density: 'LOW', confidence: 0 };
}

function blankPageResult(pageNumber: number, totalPages: number, sourceFileName: string): ChunkParseResult {
  return {
    account: {
      accountNumber: `待核验-${sourceFileName.replace(/\.[^.]+$/, '')}`, accountName: sourceFileName.replace(/\.[^.]+$/, ''),
      bankName: '待核验银行', ownerType: 'DEBTOR_MAIN', fileName: sourceFileName, fileType: 'pdf', totalIn: 0, totalOut: 0,
      transactionCount: 0, startDate: '', endDate: '', startBalance: 0, endBalance: 0, isBalanced: false, balanceDiff: 0,
      balanceAvailable: false, parseStatus: 'COMPLETE'
    },
    transactions: [], warnings: [], coveredPages: [pageNumber], pageStart: pageNumber, pageEnd: pageNumber, totalPages,
    expectedTransactionCount: 0, countComplete: true,
    pageQuality: [{ page: pageNumber, expectedCount: 0, extractedCount: 0, status: 'COMPLETE', pageType: 'BLANK' }]
  };
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
  private transientFailures: number[] = [];
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
    this.successes += 1;
    if (usageTokens > 0) this.tokenSamples.push({ at: Date.now(), tokens: usageTokens });
    this.trimTokenSamples();
    this.trimTransientFailures();
    const recentTokens = this.tokenSamples.reduce((sum, sample) => sum + sample.tokens, 0);
    if (recentTokens > 1_500_000) this.limit = Math.max(MIN_CONCURRENCY, Math.floor(this.limit * 0.75));
    else if (this.successes >= 24 && this.limit < MAX_CONCURRENCY && this.transientFailures.length === 0) {
      this.limit = Math.min(MAX_CONCURRENCY, this.limit + 1);
      this.successes = 0;
    }
  }

  private noteFailure(transient: boolean): void {
    this.successes = 0;
    if (!transient) return;
    const now = Date.now();
    this.transientFailures.push(now);
    this.trimTransientFailures();
    this.limit = Math.max(MIN_CONCURRENCY, this.limit - 1);
    const burstSize = this.transientFailures.length;
    const cooldown = burstSize >= 6 ? 60_000 : burstSize >= 3 ? 30_000 : 10_000;
    this.cooldownUntil = Math.max(this.cooldownUntil, now + cooldown);
  }

  private trimTokenSamples(): void {
    const cutoff = Date.now() - 60_000;
    this.tokenSamples = this.tokenSamples.filter(sample => sample.at >= cutoff);
  }

  private trimTransientFailures(): void {
    const cutoff = Date.now() - 60_000;
    this.transientFailures = this.transientFailures.filter(at => at >= cutoff);
  }

}

function failedPageResult(pageNumber: number, totalPages: number, sourceFileName: string, message: string): ChunkParseResult {
  const accountNumber = `待核验-${sourceFileName.replace(/\.[^.]+$/, '')}`;
  const finalMessage = message
    .replace(/[，；]?\s*系统将自动重试/g, '')
    .replace(/[；;，,]\s*$/g, '')
    .trim();
  return {
    account: {
      accountNumber, accountName: sourceFileName.replace(/\.[^.]+$/, ''), bankName: '待核验银行', ownerType: 'DEBTOR_MAIN',
      fileName: sourceFileName, fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0,
      startDate: '', endDate: '', startBalance: 0, endBalance: 0, isBalanced: false, balanceDiff: 0,
      balanceAvailable: false, parseStatus: 'INCOMPLETE'
    },
    transactions: [],
    warnings: [`第 ${pageNumber} 页连续识别失败：${finalMessage || '未取得有效结构化结果'}；自动重试后仍未恢复，已继续处理后续页面，请重新识别本页或对照原件补录`],
    coveredPages: [pageNumber], pageStart: pageNumber, pageEnd: pageNumber, totalPages,
    expectedTransactionCount: 0, countComplete: false
  };
}

function isHardFailedPage(result: ChunkParseResult): boolean {
  if (result.transactions.length) return false;
  const expected = result.expectedTransactionCount ?? result.pageQuality?.[0]?.expectedCount ?? 0;
  const pageType = result.pageQuality?.[0]?.pageType;
  return expected > 0
    || pageType === 'TRANSACTIONS'
    || Boolean(result.warnings?.some(warning => warning.includes('连续识别失败')));
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}

async function requestChunkWithContext(
  chunk: PdfPageImage,
  sourceFileName: string,
  signal?: AbortSignal,
  context?: {
    before?: PdfPageImage;
    after?: PdfPageImage;
    auditHint?: string;
    isPageSlice?: boolean;
    verificationMode?: 'always' | 'auto' | 'skip';
  }
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
  formData.append('verificationMode', context?.verificationMode || (context?.isPageSlice ? 'skip' : 'auto'));

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

async function parsePdfDirectStream(
  file: File,
  totalPages: number,
  onProgress?: (info: QwenProgressInfo) => void,
  signal?: AbortSignal
): Promise<{ account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] } | null> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) return null;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('sourceFileName', file.name);
  formData.append('pageStart', '1');
  formData.append('pageEnd', String(totalPages));
  formData.append('totalPages', String(totalPages));

  onProgress?.({
    currentPage: 0,
    totalPages,
    percent: 5,
    totalTransactions: 0,
    statusText: '正在连接识别服务，准备读取流水…'
  });

  const response = await fetch('/api/parse-bank-statement-stream', {
    method: 'POST',
    body: formData,
    signal
  });

  if (!response.ok) {
    throw new Error(`直接流式接口响应异常 (${response.status})`);
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completeResult: any = null;
  let serverError = '';

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
        if (payload.type === 'progress') {
          onProgress?.({
            currentPage: payload.currentPage || 0,
            totalPages: payload.totalPages || totalPages,
            percent: payload.percent || 0,
            totalTransactions: payload.totalTransactions || 0,
            statusText: payload.statusText
          });
        } else if (payload.type === 'heartbeat') {
          onProgress?.({
            currentPage: 0,
            totalPages,
            percent: Math.min(88, 15 + Math.floor(((payload.secondsElapsed || 0) / 160) * 73)),
            totalTransactions: 0,
            statusText: payload.statusText
          });
        } else if (payload.type === 'complete') {
          completeResult = payload;
        } else if (payload.type === 'error') {
          serverError = payload.message || '解析服务返回错误';
        }
      } catch {}
    }
  }

  if (buffer.trim()) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('data:')) {
      try {
        const payload = JSON.parse(trimmed.slice(5).trim());
        if (payload.type === 'complete') completeResult = payload;
        if (payload.type === 'error') serverError = payload.message || '解析服务返回错误';
      } catch {}
    }
  }

  if (serverError) throw new Error(serverError);
  if (!completeResult || !Array.isArray(completeResult.transactions) || completeResult.transactions.length === 0) {
    return null;
  }

  return {
    account: completeResult.account,
    accounts: completeResult.accounts || [completeResult.account],
    transactions: completeResult.transactions
  };
}

const CACHE_DB = 'lawflow-pdf-recovery';

const CACHE_STORE = 'ranges';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
