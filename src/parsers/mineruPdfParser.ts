import type { PageMapItem } from './qwenPdfParser';
import {
  MinerUStructuredDocument,
  parseMinerUStructuredZip
} from './mineruResultParser';

interface MinerUPageText {
  page: number;
  text: string;
}

export interface MinerUProgress {
  stage: 'SUBMITTING' | 'EXTRACTING' | 'CLASSIFYING' | 'NORMALIZING';
  message: string;
  completed: number;
  total: number;
}

const POLL_INTERVAL_MS = 2_500;
const MAX_WAIT_MS = 20 * 60_000;
const CLASSIFY_BATCH_SIZE = 8;
const MINERU_PAGE_LIMIT = 200;

export async function discoverPdfPageMapWithMinerU(
  file: File,
  totalPages: number,
  onProgress?: (progress: MinerUProgress) => void,
  signal?: AbortSignal
): Promise<Map<number, PageMapItem>> {
  const document = await extractPdfStructureWithMinerU(file, totalPages, onProgress, signal);
  const pages = document.pages;
  const pageMap = new Map<number, PageMapItem>();
  for (let offset = 0; offset < pages.length; offset += CLASSIFY_BATCH_SIZE) {
    assertNotAborted(signal);
    const batch = pages.slice(offset, offset + CLASSIFY_BATCH_SIZE);
    onProgress?.({
      stage: 'CLASSIFYING',
      message: `MinerU 已提取逐页内容，正在判断银行区间 ${Math.min(offset + batch.length, pages.length)}/${pages.length}…`,
      completed: offset,
      total: pages.length
    });
    const response = await fetch('/api/classify-mineru-pages', {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pages: batch })
    });
    const payload = await responseJson(response);
    if (!response.ok) throw apiError(payload, 'MinerU 页面分类失败');
    for (const item of Array.isArray(payload?.pages) ? payload.pages : []) {
      const normalized = normalizePageMapItem(item);
      if (normalized) pageMap.set(normalized.page, normalized);
    }
  }
  onProgress?.({
    stage: 'CLASSIFYING', message: `MinerU 对照方案已完成，共分析 ${pages.length} 页`, completed: pages.length, total: pages.length
  });
  return pageMap;
}

/**
 * Sends the original PDF to MinerU and returns its native page/table structure.
 * Files above the conservative API page limit are split only into consecutive
 * transport chunks; no bank/page classification is performed here.
 */
export async function extractPdfStructureWithMinerU(
  file: File,
  totalPages: number,
  onProgress?: (progress: MinerUProgress) => void,
  signal?: AbortSignal
): Promise<MinerUStructuredDocument> {
  const chunks = await createMinerUChunks(file, totalPages);
  const pages: MinerUPageText[] = [];
  const blocks: MinerUStructuredDocument['blocks'] = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    assertNotAborted(signal);
    const chunkLabel = chunks.length > 1 ? `（第 ${chunkIndex + 1}/${chunks.length} 段）` : '';
    onProgress?.({
      stage: 'SUBMITTING', message: `正在提交 MinerU 结构化解析${chunkLabel}…`, completed: chunk.startPage - 1, total: totalPages
    });
    const offset = chunk.startPage - 1;
    const document = await submitAndWait(chunk.file, chunkLabel, progress => onProgress?.({
      ...progress,
      completed: Math.min(totalPages, offset + progress.completed),
      total: totalPages
    }), signal);
    pages.push(...document.pages.map(item => ({ page: item.page + offset, text: item.text })));
    blocks.push(...document.blocks.map(item => ({ ...item, page: item.page + offset })));
  }
  pages.sort((left, right) => left.page - right.page);
  blocks.sort((left, right) => left.page - right.page);
  return { pages, blocks };
}

async function submitAndWait(
  file: File,
  chunkLabel: string,
  onProgress?: (progress: MinerUProgress) => void,
  signal?: AbortSignal
): Promise<MinerUStructuredDocument> {
  const formData = new FormData();
  formData.append('file', file);
  const submit = await fetch('/api/mineru-submit', { method: 'POST', body: formData, signal });
  const submitPayload = await responseJson(submit);
  if (!submit.ok) throw apiError(submitPayload, 'MinerU 提交失败');
  const batchId = String(submitPayload?.batchId || '');
  if (!batchId) throw new Error('MinerU 未返回任务编号');

  return waitForPages(batchId, chunkLabel, onProgress, signal);
}

async function waitForPages(
  batchId: string,
  chunkLabel: string,
  onProgress?: (progress: MinerUProgress) => void,
  signal?: AbortSignal
): Promise<MinerUStructuredDocument> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    assertNotAborted(signal);
    const response = await fetch(`/api/mineru-result?batchId=${encodeURIComponent(batchId)}`, { signal });
    const payload = await responseJson(response);
    if (!response.ok) throw apiError(payload, 'MinerU 查询失败');
    if (payload?.status === 'failed') throw new Error(String(payload?.error || 'MinerU 解析失败'));
    if (payload?.status === 'done') {
      const downloadUrl = String(payload?.downloadUrl || '');
      if (!downloadUrl.startsWith('/api/mineru-download?')) throw new Error('MinerU 没有返回有效的结果下载地址');
      const archive = await fetch(downloadUrl, { signal });
      if (!archive.ok) throw new Error(`MinerU 结果下载失败（${archive.status}）`);
      const document = await parseMinerUStructuredZip(await archive.arrayBuffer());
      if (!document.pages.length) throw new Error('MinerU 没有返回可用的逐页内容');
      return document;
    }
    const completed = Number(payload?.extractedPages || 0);
    const total = Number(payload?.totalPages || 0);
    onProgress?.({
      stage: 'EXTRACTING',
      message: total > 0
        ? `MinerU 正在解析原 PDF${chunkLabel} ${completed}/${total} 页…`
        : `MinerU 正在排队或解析原 PDF${chunkLabel}…`,
      completed,
      total
    });
    await delay(POLL_INTERVAL_MS, signal);
  }
  throw new Error('MinerU 解析超过 20 分钟，请稍后重新识别');
}

async function createMinerUChunks(
  file: File,
  totalPages: number
): Promise<Array<{ file: File; startPage: number }>> {
  if (totalPages <= MINERU_PAGE_LIMIT) return [{ file, startPage: 1 }];
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(await file.arrayBuffer());
  const chunks: Array<{ file: File; startPage: number }> = [];
  for (let startIndex = 0; startIndex < totalPages; startIndex += MINERU_PAGE_LIMIT) {
    const endIndex = Math.min(totalPages, startIndex + MINERU_PAGE_LIMIT);
    const document = await PDFDocument.create();
    const indexes = Array.from({ length: endIndex - startIndex }, (_, index) => startIndex + index);
    const pages = await document.copyPages(source, indexes);
    pages.forEach(page => document.addPage(page));
    const bytes = await document.save({ useObjectStreams: true });
    const base = file.name.replace(/\.pdf$/i, '');
    chunks.push({
      file: new File(
        [Uint8Array.from(bytes).buffer],
        `${base}__MinerU_${startIndex + 1}-${endIndex}.pdf`,
        { type: 'application/pdf', lastModified: file.lastModified }
      ),
      startPage: startIndex + 1
    });
  }
  return chunks;
}

function normalizePageMapItem(item: any): PageMapItem | null {
  const page = Number(item?.page);
  if (!Number.isInteger(page) || page < 1) return null;
  return {
    page,
    pageType: item.pageType,
    rotation: 0,
    bankName: String(item.bankName || ''),
    accountName: String(item.accountName || ''),
    accountNumbers: Array.isArray(item.accountNumbers) ? item.accountNumbers.map(String) : [],
    density: item.density,
    confidence: Number(item.confidence || 0),
    documentBoundary: item.documentBoundary,
    documentLabel: String(item.documentLabel || ''),
    investigationOrderNo: String(item.investigationOrderNo || '')
  };
}

function apiError(payload: any, fallback: string): Error {
  const error = new Error(String(payload?.error || fallback));
  (error as Error & { code?: string }).code = payload?.code;
  return error;
}

async function responseJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return { error: `服务返回异常（${response.status}）` };
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('已停止', 'AbortError'));
    }, { once: true });
  });
}
