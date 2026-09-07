import { BankAccount, StandardTransaction } from '../types/transaction';
import { transactionBelongsToAccount } from '../utils/accountIdentity';
import { chronologicalTransactions, isFeeWaiver } from '../utils/transactionSequence';

export interface AuditReport {
  accountNumber: string;
  isBalanced: boolean;
  isAuditable: boolean;
  calculatedEndBalance: number;
  statedEndBalance: number;
  difference: number;
  totalIncome: number;
  totalExpense: number;
  suspiciousRows: {
    transactionId: string;
    reason: string;
  }[];
}

/**
 * Performs debit/credit balancing audit on parsed statement data.
 */
export function auditAccountBalance(
  account: BankAccount,
  transactions: StandardTransaction[]
): AuditReport {
  let totalIncome = 0;
  let totalExpense = 0;
  const suspiciousRows: { transactionId: string; reason: string }[] = [];

  const accountTx = transactions.filter(t => transactionBelongsToAccount(t, account));

  accountTx.forEach(tx => {
    if (tx.direction === 'IN') {
      totalIncome += tx.amount;
    } else if (tx.direction === 'OUT') {
      totalExpense += tx.amount;
    } else {
      suspiciousRows.push({ transactionId: tx.id, reason: '收支方向待核对' });
    }

    if (tx.amount <= 0 && !isFeeWaiver(tx)) {
      suspiciousRows.push({
        transactionId: tx.id,
        reason: '交易金额为0或负数'
      });
    }
  });

  const isAuditable = account.balanceAvailable !== false;
  let startBalance = account.startBalance;
  let endBalance = account.endBalance;

  if (isAuditable && accountTx.length > 0) {
    const chronological = chronologicalTransactions(accountTx);
    const firstWithBalance = chronological.find(item => item.balanceAvailable !== false && item.balance != null);
    const lastWithBalance = [...chronological].reverse().find(item => item.balanceAvailable !== false && item.balance != null);

    if (firstWithBalance && firstWithBalance.balance != null && firstWithBalance.amount > 0) {
      const inferredStart = firstWithBalance.direction === 'IN'
        ? firstWithBalance.balance - firstWithBalance.amount
        : firstWithBalance.direction === 'OUT'
        ? firstWithBalance.balance + firstWithBalance.amount
        : firstWithBalance.balance;

      if (Math.abs(startBalance - firstWithBalance.balance) < 0.01 && Math.abs(startBalance - inferredStart) >= 0.01) {
        startBalance = inferredStart;
      }
    }

    if (lastWithBalance && lastWithBalance.balance != null) {
      if (endBalance === 0 && lastWithBalance.balance !== 0) {
        endBalance = lastWithBalance.balance;
      }
    }
  }

  const calculatedEndBalance = startBalance + totalIncome - totalExpense;
  const diff = Math.abs(calculatedEndBalance - endBalance);

  // A zero ending balance can be a real statement value and must not bypass
  // reconciliation. Unknown balances should be represented separately by the
  // parser rather than silently treated as balanced.
  const isBalanced = isAuditable && diff < 1.0;

  return {
    accountNumber: account.accountNumber,
    isBalanced,
    isAuditable,
    calculatedEndBalance,
    statedEndBalance: endBalance,
    difference: diff,
    totalIncome,
    totalExpense,
    suspiciousRows
  };
}
