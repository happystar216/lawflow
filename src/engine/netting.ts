import { BankAccount, StandardTransaction } from '../types/transaction';

/**
 * Eliminates internal transfers between owned bank accounts
 * (e.g. debtor transferring funds between their own CCB, ICBC, CMB accounts).
 */
export function calculateInternalNetting(
  transactions: StandardTransaction[],
  accounts: BankAccount[]
): {
  processedTransactions: StandardTransaction[];
  internalCount: number;
  internalTotalAmount: number;
} {
  // Collect all owned account numbers and names
  const ownedAccountNumbers = new Set<string>();
  const ownedAccountNames = new Set<string>();

  accounts.forEach(acc => {
    if (acc.accountNumber) ownedAccountNumbers.add(acc.accountNumber.trim());
    if (acc.accountName) ownedAccountNames.add(acc.accountName.trim());
  });

  const txList = [...transactions];
  let internalCount = 0;
  let internalTotalAmount = 0;

  // Step 1: Match by direct account number / exact name
  for (let i = 0; i < txList.length; i++) {
    const tx = txList[i];
    if (tx.isInternalTransfer) continue;

    // Check if counterparty is explicitly in owned accounts list
    const counterpartyAcc = tx.counterpartyAccount?.trim() || '';
    const counterpartyName = tx.counterpartyName?.trim() || '';

    const isMatchAccount = counterpartyAcc && ownedAccountNumbers.has(counterpartyAcc);
    const isMatchName = counterpartyName && ownedAccountNames.has(counterpartyName) && counterpartyName !== '';

    if (isMatchAccount || isMatchName) {
      // Find matching opposite transaction on the other owned account (same amount, within 2 days)
      const oppositeDir = tx.direction === 'OUT' ? 'IN' : 'OUT';
      const matchPair = txList.find((other, idx) => {
        if (idx === i || other.isInternalTransfer) return false;
        if (other.direction !== oppositeDir) return false;
        if (Math.abs(other.amount - tx.amount) > 0.01) return false;
        
        // Date difference <= 2 days
        const t1 = new Date(tx.transactionDate).getTime();
        const t2 = new Date(other.transactionDate).getTime();
        const diffDays = Math.abs(t1 - t2) / (1000 * 3600 * 24);
        return diffDays <= 2;
      });

      if (matchPair) {
        tx.isInternalTransfer = true;
        tx.internalTransferPairId = matchPair.id;
        matchPair.isInternalTransfer = true;
        matchPair.internalTransferPairId = tx.id;
        internalCount += 2;
        internalTotalAmount += tx.amount;
      } else if (isMatchAccount || isMatchName) {
        // Even without an exact opposite record imported (e.g. only 1 card imported so far), mark as internal
        tx.isInternalTransfer = true;
        internalCount += 1;
        internalTotalAmount += tx.amount;
      }
    }
  }

  return {
    processedTransactions: txList,
    internalCount,
    internalTotalAmount
  };
}
