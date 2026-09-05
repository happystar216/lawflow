import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sourcePdf = resolve(process.argv[2] || '/Users/happy/Downloads/胡艳红流水合并.pdf');
const outputDir = resolve(process.argv[3] || 'test-data/private/hu-yanhong-codex-source');

interface SourceAnchor {
  serial: number;
  ownerName?: string;
  accountNumber?: string;
  date?: string;
  time?: string;
  direction?: 'IN' | 'OUT';
  amount?: number;
  balance?: number;
  rawText: string;
}

interface SourcePage {
  page: number;
  text: string;
  transactionStartCount: number;
  anchors: SourceAnchor[];
}

async function main() {
  const [pdfBytes, pageTexts] = await Promise.all([readFile(sourcePdf), extractPdfText(sourcePdf)]);
  const pages = pageTexts.map((text, index): SourcePage => {
    const anchors = extractAnchors(text);
    return { page: index + 1, text, transactionStartCount: anchors.length, anchors };
  });
  await mkdir(outputDir, { recursive: true });
  const sourceSha256 = createHash('sha256').update(pdfBytes).digest('hex');
  const index = {
    datasetVersion: 1,
    datasetKind: 'INDEPENDENT_SOURCE_INDEX',
    sourceFileName: basename(sourcePdf),
    sourceSha256,
    totalPages: pages.length,
    totalTransactionStarts: pages.reduce((sum, page) => sum + page.transactionStartCount, 0),
    provenance: [
      'Derived only from the original PDF text layer and source page images.',
      'No product parsing endpoint, cache, or product recognition result is read by this script.',
      'Anchors are source references, not a claim that every split or continuation row is final ground truth.'
    ],
    pages
  };
  await writeFile(join(outputDir, 'source-index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  await writeFile(join(outputDir, 'summary.json'), `${JSON.stringify({
    sourceSha256,
    totalPages: pages.length,
    totalTransactionStarts: index.totalTransactionStarts,
    pagesWithTransactionStarts: pages.filter(page => page.transactionStartCount > 0).length,
    pagesWithoutText: pages.filter(page => !page.text.trim()).map(page => page.page)
  }, null, 2)}\n`, 'utf8');
  const visualReviewQueue = pages.flatMap(page => {
    if (!page.text.trim()) return [{ page: page.page, reason: '原件没有可提取文字层，需直接查看页图', priority: 'HIGH' }];
    if (!page.transactionStartCount && /\d{4}[-/]\d{2}[-/]\d{2}/.test(page.text)) {
      return [{ page: page.page, reason: '原件含日期/表格内容但没有可稳定识别的交易行号，需直接查看页图', priority: 'HIGH' }];
    }
    return [];
  });
  await writeFile(join(outputDir, 'visual-review-queue.json'), `${JSON.stringify(visualReviewQueue, null, 2)}\n`, 'utf8');
  console.log(`Source index complete: ${pages.length} pages, ${index.totalTransactionStarts} transaction starts.`);
}

async function extractPdfText(path: string): Promise<string[]> {
  const code = [
    'import json, sys',
    'from pypdf import PdfReader',
    'reader = PdfReader(sys.argv[1])',
    'print(json.dumps([page.extract_text() or "" for page in reader.pages], ensure_ascii=False))'
  ].join('; ');
  const { stdout } = await execFileAsync('python3', ['-c', code, path], { maxBuffer: 128 * 1024 * 1024 });
  return JSON.parse(stdout) as string[];
}

function extractAnchors(text: string): SourceAnchor[] {
  const starts = [...text.matchAll(/^\s*(\d{1,5})\s+([^\s]+)\s+(\d{10,30})\s+[^\n]*?(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})[\s\S]*?(借|贷)\s+([\d,.]+)\s+([\d,.]+)/gm)];
  return starts.map(match => ({
    serial: Number(match[1]),
    ownerName: match[2],
    accountNumber: match[3],
    date: match[4],
    time: match[5],
    direction: match[6] === '贷' ? 'IN' : 'OUT',
    amount: numberOrUndefined(match[7]),
    balance: numberOrUndefined(match[8]),
    rawText: match[0].trim()
  }));
}

function numberOrUndefined(value: string): number | undefined {
  const parsed = Number(value.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
