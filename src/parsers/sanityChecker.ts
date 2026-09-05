import { BankAccount, StandardTransaction } from '../types/transaction';
import { transactionBelongsToAccount } from '../utils/accountIdentity';

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

    if (tx.amount <= 0) {
      suspiciousRows.push({
        transactionId: tx.id,
        reason: '交易金额为0或负数'
      });
    }
  });

  const isAuditable = account.balanceAvailable !== false;
  const calculatedEndBalance = account.startBalance + totalIncome - totalExpense;
  const diff = Math.abs(calculatedEndBalance - account.endBalance);

  // A zero ending balance can be a real statement value and must not bypass
  // reconciliation. Unknown balances should be represented separately by the
  // parser rather than silently treated as balanced.
  const isBalanced = isAuditable && diff < 1.0;

  return {
    accountNumber: account.accountNumber,
    isBalanced,
    isAuditable,
    calculatedEndBalance,
    statedEndBalance: account.endBalance,
    difference: diff,
    totalIncome,
    totalExpense,
    suspiciousRows
  };
}
