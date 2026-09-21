import { BankAccount, StandardTransaction } from '../types/transaction';

export interface GeminiProgressInfo {
  statusText: string;
  totalTransactions: number;
  percent: number;
  currentBank?: string;
  isStreaming?: boolean;
}

export interface GeminiParserClientOptions {
  respondentName?: string;
  totalPages?: number;
  sourceContentHash?: string;
  sourcePageNumbers?: number[];
  sourceTotalPages?: number;
}

/**
 * Kept as a small compatibility seam for diagnostics and tests. Recognition no
 * longer changes strategy at an arbitrary page-count threshold: every PDF uses
 * the same evidence-first segmented pipeline.
 */
export function recognitionModeForPdf(_totalPages: number): 'SEGMENTED' {
  return 'SEGMENTED';
}

export class RecognitionImportError extends Error {
  constructor(
    message: string,
    public diagnosticCode: string,
    public diagnosis: string
  ) {
    super(message);
    this.name = 'RecognitionImportError';
  }
}

export async function parsePdfWithGemini(
  file: File,
  onProgress?: (info: GeminiProgressInfo) => void,
  signal?: AbortSignal,
  options?: GeminiParserClientOptions
): Promise<{ account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] }> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) throw new Error('当前识别方式仅支持 PDF 文件');

  onProgress?.({
    statusText: '正在读取卷宗页面并建立识别目录…',
    totalTransactions: 0,
    percent: 1,
    isStreaming: true
  });

  const { parsePdfWithQwen } = await import('./qwenPdfParser');
  return parsePdfWithQwen(file, info => onProgress?.({
    statusText: info.statusText || `正在识别，已完成 ${info.currentPage}/${info.totalPages} 页…`,
    totalTransactions: info.totalTransactions,
    percent: info.percent,
    isStreaming: info.percent < 100
  }), signal, {
    cacheIdentity: options?.sourceContentHash,
    sourcePageNumbers: options?.sourcePageNumbers,
    sourceTotalPages: options?.sourceTotalPages
  });
}
