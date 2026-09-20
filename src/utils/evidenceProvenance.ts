import { BankAccount, StandardTransaction } from '../types/transaction';

export interface SourceDocumentRef {
  documentId: string;
  contentHash: string;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
}

export interface ExtractionRunRef {
  id: string;
  documentId: string;
  startedAt: string;
}

export async function identifySourceDocument(file: File): Promise<SourceDocumentRef> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const contentHash = Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    documentId: `DOC_${contentHash}`,
    contentHash,
    fileName: file.name,
    mimeType: file.type,
    size: file.size,
    lastModified: file.lastModified
  };
}

export function createExtractionRun(documentId: string): ExtractionRunRef {
  const startedAt = new Date().toISOString();
  const nonce = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  return {
    id: `RUN_${documentId.slice(4, 20)}_${nonce}`,
    documentId,
    startedAt
  };
}

export function attachSourceProvenance(
  accounts: BankAccount[],
  transactions: StandardTransaction[],
  source: SourceDocumentRef,
  run: ExtractionRunRef
): { accounts: BankAccount[]; transactions: StandardTransaction[] } {
  const annotatedAccounts = accounts.map(account => ({
    ...account,
    fileName: source.fileName,
    sourceDocumentId: source.documentId,
    sourceContentHash: source.contentHash,
    extractionRunId: run.id
  }));
  const annotatedTransactions = transactions.map((transaction, index) => {
    const observationId = sourceObservationId(source.documentId, transaction, index);
    return {
      ...transaction,
      id: observationId,
      rawSourceFile: source.fileName,
      sourceDocumentId: source.documentId,
      sourceContentHash: source.contentHash,
      extractionRunId: run.id,
      sourceObservationId: observationId,
      fieldEvidence: transaction.fieldEvidence || createFieldEvidenceSnapshot(transaction)
    };
  });
  return { accounts: annotatedAccounts, transactions: annotatedTransactions };
}

export function createFieldEvidenceSnapshot(
  transaction: StandardTransaction,
  origin: 'EXTRACTION' | 'AUTO_NORMALIZATION' | 'LAWYER_REVIEW' = 'EXTRACTION',
  forcedDecision?: 'ACCEPTED' | 'SUGGESTED' | 'CONFIRMED' | 'REJECTED' | 'UNRESOLVED'
): NonNullable<StandardTransaction['fieldEvidence']> {
  const confidence = transaction.extractionConfidence;
  const decision = forcedDecision || (transaction.reviewStatus === 'PENDING' ? 'UNRESOLVED' as const : 'ACCEPTED' as const);
  return {
    accountNumber: field(transaction.accountNumber),
    transactionTime: field(transaction.transactionTime),
    direction: field(transaction.direction),
    amount: field(transaction.amount),
    balance: field(transaction.balance),
    counterpartyName: field(transaction.counterpartyName),
    counterpartyAccount: field(transaction.counterpartyAccount || ''),
    summary: field(transaction.summary)
  };

  function field(value: string | number | null) {
    return { originalValue: value, currentValue: value, confidence, origin, decision };
  }
}

export function sourceIdentity(value: Pick<BankAccount, 'fileName' | 'sourceDocumentId'> | Pick<StandardTransaction, 'rawSourceFile' | 'sourceDocumentId'>): string {
  if (value.sourceDocumentId) return value.sourceDocumentId;
  return 'fileName' in value ? `LEGACY_${value.fileName}` : `LEGACY_${value.rawSourceFile}`;
}

function sourceObservationId(documentId: string, transaction: StandardTransaction, index: number): string {
  const page = transaction.rawPageNumber || 0;
  const row = transaction.rawRowIndex || index + 1;
  const originalId = transaction.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-32);
  return `TX_${documentId.slice(4, 20)}_P${page}_R${row}_${originalId}`;
}
