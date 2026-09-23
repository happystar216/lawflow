import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { requestOriginalPdfPage, type MinerUPageCheckpoint } from '../src/parsers/mineruBankStatementParser';
import { selectPageCandidate } from '../src/recognition/pageCandidates';
import { resolveDocumentOwners } from '../src/recognition/documentOwners';
import { mergeQwenChunkResults } from '../src/parsers/qwenResultMerger';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';

// Explicit operator command: sends ONLY the requested original pages to the
// existing recognition endpoint. Does not create a case, approve rows or deploy.
const [snapshotPath, pdfPath, pageList, endpoint, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('用法：tsx scripts/recheckRecognitionPages.ts 结果.json 原件.pdf 页码逗号列表 本地服务URL 输出.json');
const target = new URL(endpoint);
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('此诊断命令仅允许本机服务；外部识别由已配置后端完成');
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
type Checkpoint = MinerUPageCheckpoint & { documentId: string; fileName: string; totalPages: number };
const pages = [...new Map<number, Checkpoint>((snapshot.recognitionPages as Checkpoint[]).map(page => [page.page, page])).values()];
if (new Set(pages.map(page => page.documentId)).size !== 1) throw new Error('请一次只提供一份原文件的识别结果');
const pdfBytes = await readFile(pdfPath);
if (pages[0]?.documentId !== `DOC_${createHash('sha256').update(pdfBytes).digest('hex')}`) throw new Error('原 PDF 内容与检查点来源不一致，拒绝混合不同文件');
const document = await PDFDocument.load(pdfBytes);
for (const checkpoint of pages) {
  const primary = checkpoint.candidates.find(candidate => candidate.route === 'MINERU');
  const recovery = checkpoint.candidates.find(candidate => candidate.route === 'ORIGINAL_PDF');
  if (primary && recovery) checkpoint.selected = selectPageCandidate(primary.result, recovery.result, checkpoint.page,
    !checkpoint.sourceValidation && checkpoint.source.blocks.some(block => /colspan\s*=\s*["']?(?:[4-9]|\d{2,})/i.test(block.content)));
}
const requested = [...new Set(pageList.split(',').map(Number))];
if (requested.some(page => !Number.isInteger(page) || page < 1 || page > document.getPageCount() || !pages.some(item => item.page === page))) throw new Error('页码超出原件或检查点范围');
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => originalFetch(typeof input === 'string' && input.startsWith('/') ? new URL(input, target) : input, init);
const attempts: Array<{ page: number; status: string; error?: string }> = [];
let cursor = 0;
try {
  await Promise.all(Array.from({ length: Math.min(2, requested.length) }, async () => {
    while (cursor < requested.length) {
      const number = requested[cursor++];
      const checkpoint = pages.find(page => page.page === number)!;
      const slice = await PDFDocument.create();
      const [copied] = await slice.copyPages(document, [number - 1]); slice.addPage(copied);
      const file = new File([Uint8Array.from(await slice.save()).buffer], checkpoint.fileName, { type: 'application/pdf' });
      try {
        const result = await requestOriginalPdfPage(file, number, document.getPageCount(), checkpoint.fileName,
          snapshot.caseMetadata?.respondentName || checkpoint.selected.account.accountName);
        checkpoint.candidates = checkpoint.candidates.filter(candidate => candidate.route !== 'ORIGINAL_PDF');
        checkpoint.candidates.push({ route: 'ORIGINAL_PDF', result });
        const primary = checkpoint.candidates.find(candidate => candidate.route === 'MINERU');
        checkpoint.selected = primary ? selectPageCandidate(primary.result, result, number) : result;
        checkpoint.sourceValidation = { status: 'COMPARED', reasons: ['指定原页补测，未重新调用 MinerU'] };
        attempts.push({ page: number, status: 'COMPARED' });
      } catch (error) {
        attempts.push({ page: number, status: 'FAILED', error: error instanceof Error ? error.message : String(error) });
      }
      console.log(`原页补测 ${attempts.length}/${requested.length}：第 ${number} 页 ${attempts.at(-1)?.status}`);
    }
  }));
} finally { globalThis.fetch = originalFetch; }
const merged = mergeQwenChunkResults(resolveDocumentOwners(pages), pages[0].fileName, document.getPageCount());
const normalized = normalizeRecognizedData(merged.accounts.map(account => ({ ...account, sourceDocumentId: pages[0].documentId })),
  merged.transactions.map(row => ({ ...row, sourceDocumentId: pages[0].documentId })));
await writeFile(outputPath, JSON.stringify({ mode: 'TARGETED_SOURCE_RECHECK', attempts, recognitionPages: pages, ...normalized }, null, 2));
console.log(JSON.stringify({ pages: requested.length, failures: attempts.filter(attempt => attempt.status === 'FAILED').length,
  observations: normalized.transactions.length, excludedDuplicates: normalized.transactions.filter(row => row.excludedFromAnalysis).length }));
if (attempts.some(attempt => attempt.status === 'FAILED')) process.exitCode = 1;
