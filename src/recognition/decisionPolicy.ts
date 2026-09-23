import type { StandardTransaction } from '../types/transaction';
import { createFieldEvidenceSnapshot } from '../utils/evidenceProvenance';
import { isReliableAccountNumber, normalizeAccountIdentityPart } from '../utils/accountIdentity';

/** Every stage receives its own copy; original field evidence survives decisions. */
export function preserveExtraction(transaction: StandardTransaction): StandardTransaction {
  const copy = structuredClone(transaction);
  copy.recognitionPolicy = 'EVIDENCE_ONLY_V1';
  copy.fieldEvidence = { ...createFieldEvidenceSnapshot(copy), ...copy.fieldEvidence };
  return copy;
}

export function isEvidenceOnly(transaction: StandardTransaction): boolean {
  return transaction.recognitionPolicy === 'EVIDENCE_ONLY_V1';
}

export function sameSource(left: StandardTransaction, right: StandardTransaction): boolean {
  if (left.sourceDocumentId || right.sourceDocumentId) {
    return Boolean(left.sourceDocumentId && left.sourceDocumentId === right.sourceDocumentId);
  }
  return left.rawSourceFile === right.rawSourceFile;
}

/** Missing institution names never invalidate an explicitly extracted account. */
export function canInheritOwner(transaction: StandardTransaction): boolean {
  return !isEvidenceOnly(transaction) && !isReliableAccountNumber(transaction.accountNumber);
}

export function sameOwner(left: StandardTransaction, right: StandardTransaction): boolean {
  return sameSource(left, right)
    && normalizeAccountIdentityPart(left.accountNumber) === normalizeAccountIdentityPart(right.accountNumber);
}
