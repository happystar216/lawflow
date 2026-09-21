import type { PageMapItem } from './qwenPdfParser';

export interface PdfBankGroup {
  id: string;
  bankName: string;
  suggestedBankName: string;
  pages: number[];
  pageSelection: string;
  confidence: number;
  pageTypes: PageMapItem['pageType'][];
}

export interface PdfPageClassification {
  page: number;
  pageType: PageMapItem['pageType'];
  detectedBankName: string;
  assignedBankName: string;
  confidence: number;
  thumbnailUrl: string;
  suggestedForRecognition: boolean;
  selectedForRecognition: boolean;
  selectionModifiedByUser: boolean;
}

export interface PdfBankSplitPlan {
  id: string;
  sourceFile: File;
  sourcePdfUrl: string;
  totalPages: number;
  groups: PdfBankGroup[];
  pages: PdfPageClassification[];
}

export interface RecognitionSplitMetadata {
  sourceFileName: string;
  sourceTotalPages: number;
  sourcePageNumbers: number[];
}

const recognitionSplitMetadata = new WeakMap<File, RecognitionSplitMetadata>();

export async function preparePdfBankSplitPlan(
  file: File,
  onProgress?: (message: string, completedPages: number, totalPages: number) => void,
  signal?: AbortSignal
): Promise<PdfBankSplitPlan> {
  const { discoverPdfPageMap } = await import('./qwenPdfParser');
  const { totalPages, pageMap, previewFiles } = await discoverPdfPageMap(file, onProgress, signal);
  const groups = buildBankGroups(pageMap, totalPages);
  const assignedBankByPage = new Map(groups.flatMap(group => group.pages.map(page => [page, group.bankName] as const)));
  const pages = Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    const item = pageMap.get(page) || unknownPage(page);
    const suggestedForRecognition = isPageRecommendedForRecognition(item.pageType);
    return {
      page,
      pageType: item.pageType,
      detectedBankName: cleanBankName(item.bankName),
      assignedBankName: assignedBankByPage.get(page) || '待确认银行',
      confidence: item.confidence,
      thumbnailUrl: previewFiles.get(page) ? URL.createObjectURL(previewFiles.get(page)!) : '',
      suggestedForRecognition,
      selectedForRecognition: suggestedForRecognition,
      selectionModifiedByUser: false
    };
  });
  const fileNameBank = bankNameFromFileName(file.name);
  if (fileNameBank && groups.length === 1 && isPlaceholderBank(groups[0].bankName)) {
    groups[0] = {
      ...groups[0],
      bankName: fileNameBank,
      suggestedBankName: fileNameBank,
      // A filename is useful as a proposal but is not page evidence. Court
      // bundles are sometimes mislabeled, so keep this visibly low-confidence
      // and require the user's confirmation before recognition starts.
      confidence: Math.max(groups[0].confidence, 0.45)
    };
    pages.forEach(page => { page.assignedBankName = fileNameBank; });
  }
  return {
    id: splitPlanId(file),
    sourceFile: file,
    sourcePdfUrl: URL.createObjectURL(file),
    totalPages,
    groups,
    pages
  };
}

export function buildBankGroups(pageMap: Map<number, PageMapItem>, totalPages: number): PdfBankGroup[] {
  const reliableBankByPage = new Map<number, string>();
  for (let page = 1; page <= totalPages; page += 1) {
    const item = pageMap.get(page);
    const bank = cleanBankName(item?.bankName);
    if (bank && !isPlaceholderBank(bank) && (item?.confidence ?? 0) >= 0.5) reliableBankByPage.set(page, bank);
  }

  const assigned: Array<{ bankName: string; item: PageMapItem }> = [];
  for (let page = 1; page <= totalPages; page += 1) {
    const item = pageMap.get(page) || unknownPage(page);
    const explicit = reliableBankByPage.get(page);
    const bankName = explicit || inferNeighbourBank(page, totalPages, item, reliableBankByPage) || '待确认银行';
    assigned.push({ bankName, item });
  }

  const runs: Array<{ bankName: string; pages: number[]; evidence: PageMapItem[] }> = [];
  for (const [index, entry] of assigned.entries()) {
    const page = index + 1;
    const previous = runs.at(-1);
    if (previous && sameBank(previous.bankName, entry.bankName)) {
      previous.pages.push(page);
      previous.evidence.push(entry.item);
      continue;
    }
    runs.push({ bankName: entry.bankName, pages: [page], evidence: [entry.item] });
  }

  return runs.map(({ bankName, pages, evidence }, index) => {
    const confidenceValues = evidence.map(item => item.confidence).filter(value => Number.isFinite(value));
    return {
      id: `SEGMENT_${index + 1}_${stableHash(`${bankName}|${pages.join(',')}`)}`,
      bankName,
      suggestedBankName: bankName,
      pages,
      pageSelection: formatPageSelection(pages),
      confidence: confidenceValues.length
        ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
        : 0,
      pageTypes: [...new Set(evidence.map(item => item.pageType))]
    };
  });
}

export function validateBankGroups(
  groups: PdfBankGroup[],
  totalPages: number,
  pageClassifications: PdfPageClassification[] = []
): string[] {
  const errors: string[] = [];
  const assigned = new Map<number, number>();
  for (const [index, group] of groups.entries()) {
    const label = `第 ${index + 1} 个分组`;
    if (!cleanBankName(group.bankName) || isPlaceholderBank(group.bankName)) {
      errors.push(`${label}尚未确认银行名称`);
    }
    let pages: number[];
    try {
      pages = parsePageSelection(group.pageSelection, totalPages);
    } catch (error) {
      errors.push(`${label}${error instanceof Error ? error.message : '页码格式不正确'}`);
      continue;
    }
    if (!pages.length) errors.push(`${label}没有页码`);
    if (pages.some((page, pageIndex) => pageIndex > 0 && page !== pages[pageIndex - 1] + 1)) {
      errors.push(`${label}必须是连续页段，不能使用不连续页码`);
    }
    for (const page of pages) assigned.set(page, (assigned.get(page) || 0) + 1);
  }
  const missing = Array.from({ length: totalPages }, (_, index) => index + 1).filter(page => !assigned.has(page));
  const duplicated = [...assigned.entries()].filter(([, count]) => count > 1).map(([page]) => page);
  if (missing.length) errors.push(`尚未分配第 ${formatPageSelection(missing)} 页`);
  if (duplicated.length) errors.push(`第 ${formatPageSelection(duplicated)} 页被重复分配`);
  const unknownTypes = pageClassifications.filter(page => page.pageType === 'UNKNOWN').map(page => page.page);
  if (unknownTypes.length) errors.push(`第 ${formatPageSelection(unknownTypes)} 页的页面类型尚未确认`);
  if (pageClassifications.length && !pageClassifications.some(page => page.selectedForRecognition)) {
    errors.push('至少选择一页进入流水识别');
  }
  return errors;
}

export async function createBankSplitFiles(plan: PdfBankSplitPlan): Promise<File[]> {
  const errors = validateBankGroups(plan.groups, plan.totalPages, plan.pages);
  if (errors.length) throw new Error(errors.join('；'));
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(await plan.sourceFile.arrayBuffer());
  const baseName = plan.sourceFile.name.replace(/\.pdf$/i, '');
  const files: File[] = [];
  const selectedPages = new Set(plan.pages.filter(page => page.selectedForRecognition).map(page => page.page));
  const confirmedSegments = plan.groups.map(group => ({
    bankName: cleanBankName(group.bankName),
    pages: parsePageSelection(group.pageSelection, plan.totalPages).filter(page => selectedPages.has(page))
  })).filter(segment => segment.pages.length).sort((left, right) => left.pages[0] - right.pages[0]);

  for (const [segmentIndex, { bankName, pages }] of confirmedSegments.entries()) {
    const document = await PDFDocument.create();
    const copiedPages = await document.copyPages(source, pages.map(page => page - 1));
    copiedPages.forEach(page => document.addPage(page));
    const bytes = await document.save({ useObjectStreams: true });
    const bank = safeFilePart(bankName);
    const ranges = safeFilePart(formatPageSelection(pages).replace(/,/g, '_'));
    const segment = String(segmentIndex + 1).padStart(2, '0');
    const splitFile = new File(
      [Uint8Array.from(bytes).buffer],
      `${safeFilePart(baseName)}__段${segment}__${bank}__原第${ranges}页.pdf`,
      { type: 'application/pdf', lastModified: plan.sourceFile.lastModified }
    );
    recognitionSplitMetadata.set(splitFile, {
      sourceFileName: plan.sourceFile.name,
      sourceTotalPages: plan.totalPages,
      sourcePageNumbers: [...pages]
    });
    files.push(splitFile);
  }
  return files;
}

export function getRecognitionSplitMetadata(file: File): RecognitionSplitMetadata | undefined {
  return recognitionSplitMetadata.get(file);
}

export function isPageRecommendedForRecognition(pageType: PageMapItem['pageType']): boolean {
  return pageType === 'TRANSACTIONS'
    || pageType === 'ACCOUNT_LIST'
    || pageType === 'ACCOUNT_INFO'
    || pageType === 'BANK_REPLY'
    || pageType === 'UNKNOWN';
}

export function releasePdfSplitPlanPreviews(plan: PdfBankSplitPlan): void {
  for (const page of plan.pages) {
    if (page.thumbnailUrl) URL.revokeObjectURL(page.thumbnailUrl);
  }
  if (plan.sourcePdfUrl) URL.revokeObjectURL(plan.sourcePdfUrl);
}

export function parsePageSelection(value: string, totalPages: number): number[] {
  const normalized = value.replace(/[，、；;\s]+/g, ',').replace(/－|—|–/g, '-');
  const pages = new Set<number>();
  for (const token of normalized.split(',').filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new Error(`的页码范围“${token}”前后颠倒`);
      if (start < 1 || end > totalPages) throw new Error(`的页码范围“${token}”超出 1-${totalPages}`);
      for (let page = start; page <= end; page += 1) pages.add(page);
      continue;
    }
    if (!/^\d+$/.test(token)) throw new Error(`的页码“${token}”格式不正确`);
    const page = Number(token);
    if (page < 1 || page > totalPages) throw new Error(`的页码“${token}”超出 1-${totalPages}`);
    pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

export function formatPageSelection(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((left, right) => left - right);
  if (!sorted.length) return '';
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const page of sorted.slice(1)) {
    if (page === previous + 1) {
      previous = page;
      continue;
    }
    ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = page;
    previous = page;
  }
  ranges.push(start === previous ? `${start}` : `${start}-${previous}`);
  return ranges.join(',');
}

function inferNeighbourBank(
  page: number,
  totalPages: number,
  item: PageMapItem,
  reliableBankByPage: Map<number, string>
): string {
  const previous = nearestBank(page, -1, totalPages, reliableBankByPage);
  const next = nearestBank(page, 1, totalPages, reliableBankByPage);
  if (previous?.bank && next?.bank && sameBank(previous.bank, next.bank)) return previous.bank;
  if (!previous?.bank && next?.bank) return next.bank;
  if (previous?.bank && !next?.bank) return previous.bank;
  if (item.pageType !== 'TRANSACTIONS') {
    if (previous?.bank && (!next || previous.distance <= next.distance)) return previous.bank;
    if (next?.bank) return next.bank;
  }
  return '';
}

function nearestBank(
  page: number,
  step: -1 | 1,
  totalPages: number,
  reliableBankByPage: Map<number, string>
): { bank: string; distance: number } | undefined {
  for (let candidate = page + step; candidate >= 1 && candidate <= totalPages; candidate += step) {
    const bank = reliableBankByPage.get(candidate);
    if (bank) return { bank, distance: Math.abs(candidate - page) };
  }
  return undefined;
}

function cleanBankName(value: string | undefined): string {
  return String(value || '').replace(/[\s_]+/g, '').trim();
}

function canonicalBankKey(value: string): string {
  return value.replace(/中国|股份有限公司|有限责任公司|银行/g, '').toLocaleLowerCase();
}

function sameBank(left: string, right: string): boolean {
  if (isPlaceholderBank(left) || isPlaceholderBank(right)) return left === right;
  return canonicalBankKey(left) === canonicalBankKey(right);
}

function isPlaceholderBank(value: string): boolean {
  return /待确认|待核验|未知|无法确认/.test(value);
}

function bankNameFromFileName(fileName: string): string {
  const baseName = fileName.replace(/\.pdf$/i, '');
  const tokens = baseName.split(/[_\s-]+/).map(cleanBankName).filter(Boolean);
  return tokens.find(token => token.length >= 4 && token.length <= 20
    && /(?:银行|农信|信用社|农商行)$/.test(token)) || '';
}

function safeFilePart(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 72) || '待确认';
}

function splitPlanId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase();
}

function unknownPage(page: number): PageMapItem {
  return { page, pageType: 'UNKNOWN', rotation: 0, bankName: '', accountName: '', accountNumbers: [], density: 'LOW', confidence: 0 };
}
