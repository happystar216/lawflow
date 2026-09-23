import { readFile } from 'node:fs/promises';
import { mergeQwenChunkResults } from '../src/parsers/qwenResultMerger';
import type { MinerUPageCheckpoint } from '../src/parsers/mineruBankStatementParser';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';
import { evaluateRecognition, type RecognitionGroundTruth } from '../src/recognition/evaluation';
import type { StandardTransaction, BankAccount } from '../src/types/transaction';
import { resolveDocumentOwners } from '../src/recognition/documentOwners';
import { selectPageCandidate } from '../src/recognition/pageCandidates';

type Checkpoint = MinerUPageCheckpoint & { documentId: string; runId: string; fileName: string; totalPages: number };

async function main() {
  const reselect = process.argv.includes('--reselect');
  const [resultPath, truthPath] = process.argv.slice(2).filter(arg => arg !== '--reselect');
  if (!resultPath) throw new Error('用法：npm run recognition:replay -- 调试结果.json [人工标准答案.json]');
  const snapshot = JSON.parse(await readFile(resultPath, 'utf8'));
  const pages: Checkpoint[] = snapshot.recognitionPages;
  if (!Array.isArray(pages) || !pages.length) throw new Error('此结果没有逐页检查点，请使用新版自动化测试生成；不能从最终流水反推原始结果');
  if (reselect) for (const page of pages) {
    const primary = page.candidates.find(candidate => candidate.route === 'MINERU');
    const recovery = page.candidates.find(candidate => candidate.route === 'ORIGINAL_PDF');
    if (primary && recovery) page.selected = selectPageCandidate(primary.result, recovery.result, page.page,
      !page.sourceValidation && page.source.blocks.some(block => /colspan\s*=\s*["']?(?:[4-9]|\d{2,})/i.test(block.content)));
  }
  const latestRun = new Map<string, string>();
  for (const page of pages) {
    if (page.version !== 1 || !page.documentId || !page.runId) throw new Error('逐页检查点版本或来源信息不完整');
    latestRun.set(page.documentId, page.runId);
  }
  const byDocument = new Map<string, Map<number, Checkpoint>>();
  for (const page of pages) {
    if (latestRun.get(page.documentId) !== page.runId) continue;
    const group = byDocument.get(page.documentId) || new Map<number, Checkpoint>();
    group.set(page.page, page);
    byDocument.set(page.documentId, group);
  }
  const accounts: BankAccount[] = [];
  const transactions: StandardTransaction[] = [];
  for (const [documentId, group] of byDocument) {
    const checkpoints = [...group.values()].sort((a, b) => a.page - b.page);
    const first = checkpoints[0];
    const merged = mergeQwenChunkResults(resolveDocumentOwners(checkpoints), first.fileName, first.totalPages);
    const normalized = normalizeRecognizedData(
      merged.accounts.map(account => ({ ...account, sourceDocumentId: documentId })),
      merged.transactions.map(row => ({ ...row, sourceDocumentId: documentId }))
    );
    accounts.push(...normalized.accounts);
    transactions.push(...normalized.transactions);
  }
  const evaluation = truthPath
    ? evaluateRecognition(transactions, JSON.parse(await readFile(truthPath, 'utf8')) as RecognitionGroundTruth, accounts)
    : null;
  console.log(JSON.stringify({ mode: reselect ? 'OFFLINE_CANDIDATE_RESELECTION_NO_MODEL_CALLS' : 'OFFLINE_REPLAY_NO_MODEL_CALLS', accountCount: accounts.length,
    transactionCount: transactions.length, evaluation, accounts, transactions }, null, 2));
  if (evaluation && !evaluation.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
