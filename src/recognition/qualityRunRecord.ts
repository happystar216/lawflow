import type { ModelReply, QualityStage } from './qualityProtocol';
import type { QualityDeliveryInput } from '../review/qualityDelivery';
import { STATEMENT_COLUMNS, type SourceRegistry } from './sourceAssembly';
import type { BankAccount, StandardTransaction } from '../types/transaction';

export interface QualityCallRecord {
  stage: QualityStage; page: number; inputSHA256: string; fromCache: boolean;
  attempts: number; startedAt: string; completedAt: string; reply: ModelReply;
}
export interface QualityRunManifest {
  schemaVersion: 1; runId: string; endpoint: string; clientEntry: string;
  revision: string; sourceSHA256: string; totalPages: number;
  startedAt: string; completedAt: string; runKind: 'FRESH' | 'RESUMED';
  policySHA256: string; models: Record<string, string>; prompts: Record<string, string>;
  settings: unknown; renderer: unknown; calls: QualityCallRecord[];
}
export interface QualityEvidence {
  result: QualityDeliveryInput; registry: SourceRegistry; run?: QualityRunManifest;
  [key: string]: unknown;
}
export interface QualityRecognitionRecord {
  documentId: string; fileName: string; exportedAt: string; evidence: QualityEvidence;
  transactions: StandardTransaction[]; accounts: BankAccount[];
}

/** One export contract for the download button and the production test client. */
export function createQualityRecognitionRecord(documentId: string, fileName: string, evidence: QualityEvidence,
  accounts: BankAccount[], transactions: StandardTransaction[]): QualityRecognitionRecord {
  return { documentId, fileName, exportedAt: new Date().toISOString(), evidence,
    accounts: accounts.filter(a => a.sourceDocumentId === documentId),
    transactions: transactions.filter(t => t.sourceDocumentId === documentId) };
}

export function transactionStatementValues(t: StandardTransaction): string[] {
  return STATEMENT_COLUMNS.map(field => {
    if (field === 'amount' || field === 'balance') {
      const evidence = t.fieldEvidence?.[field];
      if (field === 'balance' && t.balanceAvailable === false
        || evidence?.originalValue === '' && evidence.origin !== 'LAWYER_REVIEW') return '';
      if (!Number.isFinite(t[field])) throw new Error('流水金额无效，无法冻结评分');
      return t[field].toFixed(2);
    }
    return field === 'direction' && t.direction === 'UNKNOWN' ? '' : String(t[field] ?? '');
  });
}

/** Score the actual imported rows, retaining the original ROW and field alerts.
 * Refuse edited/reordered/missing rows instead of silently scoring another result.
 */
export function freezeQualityRecognitionRecord(record: QualityRecognitionRecord) {
  const result = record.evidence?.result;
  if (!result || !Array.isArray(result.rows) || !Array.isArray(result.pending)) throw new Error('缺少完整的正式识别记录');
  if (result.rows.length !== record.transactions.length) throw new Error('网页流水与识别记录行数不一致');
  result.rows.forEach((row, index) => {
    const transaction = record.transactions[index];
    if (transaction.sourceDocumentId !== record.documentId
      || JSON.stringify(row.values) !== JSON.stringify(transactionStatementValues(transaction))
      || JSON.stringify(row.sourceObservationIds) !== JSON.stringify(transaction.qualitySourceObservationIds || []))
      throw new Error(`第 ${index + 1} 笔网页流水与识别记录不一致，不能当作初始识别结果评分`);
    if (transaction.fieldEvidence && Object.values(transaction.fieldEvidence).some(e => e?.origin === 'LAWYER_REVIEW'))
      throw new Error(`第 ${index + 1} 笔已人工处理，不能当作初始识别结果评分`);
    const issues = result.pending.filter(issue => issue.severity !== 'ADVISORY' && issue.outputRows.includes(index + 1));
    const fields = new Set(issues.flatMap(issue => issue.field ? [issue.field] : [...STATEMENT_COLUMNS]));
    if (fields.size && (!transaction.candidateReview || transaction.candidateReview.status === 'CONFIRMED'
      || [...fields].some(field => !transaction.candidateReview?.requiredFields?.includes(field))))
      throw new Error(`第 ${index + 1} 笔的待确认提示与网页不一致`);
  });
  for (const issue of result.pending.filter(i => i.severity !== 'ADVISORY' && !i.outputRows.length)) {
    if (!record.accounts.some(a => a.reviewIssues?.some(i => i.description === issue.message
      && i.severity === 'REQUIRED' && ['PENDING', 'UNRESOLVED'].includes(i.status))))
      throw new Error('页面待确认提示与网页不一致');
  }
  return structuredClone(result);
}
