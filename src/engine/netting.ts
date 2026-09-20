import { BankAccount, StandardTransaction } from '../types/transaction';
import { normalizeAccountIdentityPart } from '../utils/accountIdentity';

export interface InternalTransferCandidate {
  transactionIds: [string, string];
  amount: number;
  confidence: 'MEDIUM';
  reason: string;
}

interface PairCandidate {
  otherIndex: number;
  score: number;
  reason: string;
  confidence: 'HIGH' | 'MEDIUM';
}

/**
 * Eliminates transfers between the debtor's own accounts only when both sides
 * exist and account-number evidence links them. Name-only matches are exposed
 * for review, but never silently removed from totals.
 */
export function calculateInternalNetting(
  transactions: StandardTransaction[],
  accounts: BankAccount[]
): {
  processedTransactions: StandardTransaction[];
  internalCount: number;
  internalTotalAmount: number;
  candidates: InternalTransferCandidate[];
} {
  const ownedAccountNumbers = new Set<string>();
  const ownedAccountNames = new Set<string>();
  accounts.filter(account => account.ownerType === 'DEBTOR_MAIN').forEach(account => {
    const number = normalizeAccountIdentityPart(account.accountNumber || '');
    const name = normalizedName(account.accountName);
    if (number) ownedAccountNumbers.add(number);
    if (name) ownedAccountNames.add(name);
  });

  const txList = transactions.map(transaction => {
    const clone = { ...transaction };
    delete clone.isInternalTransfer;
    delete clone.internalTransferPairId;
    delete clone.internalTransferMatchConfidence;
    delete clone.internalTransferMatchReason;
    return clone;
  });
  let internalCount = 0;
  let internalTotalAmount = 0;
  const candidates: InternalTransferCandidate[] = [];
  const candidateKeys = new Set<string>();

  for (let index = 0; index < txList.length; index += 1) {
    const transaction = txList[index];
    if (transaction.isInternalTransfer || transaction.direction === 'UNKNOWN') continue;
    const possiblePairs: PairCandidate[] = [];

    for (let otherIndex = index + 1; otherIndex < txList.length; otherIndex += 1) {
      const other = txList[otherIndex];
      if (other.isInternalTransfer || other.direction === 'UNKNOWN' || other.direction === transaction.direction) continue;
      if (Math.abs(other.amount - transaction.amount) >= 0.01) continue;
      const dayDifference = Math.abs(new Date(transaction.transactionDate).getTime() - new Date(other.transactionDate).getTime()) / 86_400_000;
      if (!Number.isFinite(dayDifference) || dayDifference > 2) continue;

      const sourceAccount = normalizeAccountIdentityPart(transaction.accountNumber || '');
      const otherAccount = normalizeAccountIdentityPart(other.accountNumber || '');
      if (!ownedAccountNumbers.has(sourceAccount) || !ownedAccountNumbers.has(otherAccount) || sourceAccount === otherAccount) continue;

      const transactionCounterparty = normalizeAccountIdentityPart(transaction.counterpartyAccount || '');
      const otherCounterparty = normalizeAccountIdentityPart(other.counterpartyAccount || '');
      const forwardAccountMatch = Boolean(transactionCounterparty && transactionCounterparty === otherAccount);
      const reverseAccountMatch = Boolean(otherCounterparty && otherCounterparty === sourceAccount);
      const hasConflictingAccount = Boolean(
        (transactionCounterparty && transactionCounterparty !== otherAccount)
        || (otherCounterparty && otherCounterparty !== sourceAccount)
      );
      if (hasConflictingAccount) continue;

      if (forwardAccountMatch || reverseAccountMatch) {
        const reciprocal = forwardAccountMatch && reverseAccountMatch;
        possiblePairs.push({
          otherIndex,
          confidence: 'HIGH',
          score: (reciprocal ? 100 : 80) - dayDifference,
          reason: reciprocal ? '两侧流水的本方账号与对手账号互相对应' : '一侧对手账号明确指向另一本人账户，且存在等额反向流水'
        });
        continue;
      }

      const transactionName = normalizedName(transaction.counterpartyName);
      const otherName = normalizedName(other.counterpartyName);
      const nameEvidence = (transactionName && ownedAccountNames.has(transactionName))
        || (otherName && ownedAccountNames.has(otherName));
      if (nameEvidence && dayDifference === 0) {
        possiblePairs.push({
          otherIndex,
          confidence: 'MEDIUM',
          score: 10,
          reason: '同日等额反向流水且对手户名像本人，但缺少对手账号，未自动核销'
        });
      }
    }

    const highConfidencePair = possiblePairs
      .filter(pair => pair.confidence === 'HIGH')
      .sort((left, right) => right.score - left.score || left.otherIndex - right.otherIndex)[0];
    if (highConfidencePair) {
      const other = txList[highConfidencePair.otherIndex];
      transaction.isInternalTransfer = true;
      transaction.internalTransferPairId = other.id;
      transaction.internalTransferMatchConfidence = 'HIGH';
      transaction.internalTransferMatchReason = highConfidencePair.reason;
      other.isInternalTransfer = true;
      other.internalTransferPairId = transaction.id;
      other.internalTransferMatchConfidence = 'HIGH';
      other.internalTransferMatchReason = highConfidencePair.reason;
      internalCount += 2;
      internalTotalAmount += transaction.amount;
      continue;
    }

    for (const pair of possiblePairs.filter(item => item.confidence === 'MEDIUM')) {
      const other = txList[pair.otherIndex];
      const key = [transaction.id, other.id].sort().join('|');
      if (candidateKeys.has(key)) continue;
      candidateKeys.add(key);
      candidates.push({ transactionIds: [transaction.id, other.id], amount: transaction.amount, confidence: 'MEDIUM', reason: pair.reason });
    }
  }

  return { processedTransactions: txList, internalCount, internalTotalAmount, candidates };
}

function normalizedName(value?: string): string {
  return (value || '').replace(/[\s·•]/g, '').toLocaleLowerCase();
}
