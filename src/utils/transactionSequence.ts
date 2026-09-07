import { StandardTransaction } from '../types/transaction';

export interface BalanceContinuityIssue {
  previous: StandardTransaction;
  transaction: StandardTransaction;
  expected: number;
  daysApart?: number;
  isLongInterval?: boolean;
}

/**
 * Normalizes dates and timestamps into ISO-comparable strings YYYY-MM-DD HH:mm:ss.
 */
export function normalizeTransactionTimestamp(tx: StandardTransaction): string {
  const dateStr = (tx.transactionDate || '').trim();
  const timeStr = (tx.transactionTime || '').trim();

  // Normalize date: support 2023-05-08, 2023/05/08, 20230508
  let formattedDate = '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    formattedDate = dateStr;
  } else if (/^\d{4}\/\d{2}\/\d{2}$/.test(dateStr)) {
    formattedDate = dateStr.replace(/\//g, '-');
  } else if (/^\d{8}$/.test(dateStr)) {
    formattedDate = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
  } else {
    formattedDate = dateStr || '9999-99-99';
  }

  // Normalize time: HH:mm:ss or HHmmss
  let formattedTime = '';
  if (timeStr.includes(':')) {
    const parts = timeStr.split(' ');
    formattedTime = parts[parts.length - 1];
  } else if (/^\d{6}$/.test(timeStr)) {
    formattedTime = `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}:${timeStr.slice(4, 6)}`;
  } else if (timeStr) {
    formattedTime = timeStr;
  } else {
    formattedTime = '00:00:00';
  }

  return `${formattedDate} ${formattedTime}`.trim();
}

/**
 * Calculates calendar day distance between two dates.
 */
export function daysBetween(d1?: string, d2?: string): number {
  if (!d1 || !d2) return 0;
  const t1 = new Date(d1).getTime();
  const t2 = new Date(d2).getTime();
  if (isNaN(t1) || isNaN(t2)) return 0;
  return Math.abs(Math.round((t2 - t1) / (1000 * 3600 * 24)));
}

/**
 * Truly orders transactions in chronological time order (oldest to newest).
 * Within the same day/timestamp, uses a greedy balance-chain linker to preserve valid balance math.
 */
export function chronologicalTransactions(transactions: StandardTransaction[]): StandardTransaction[] {
  if (transactions.length < 2) return [...transactions];

  // 1. Group by date
  const dateMap = new Map<string, StandardTransaction[]>();
  for (const tx of transactions) {
    const d = (tx.transactionDate || '').trim() || '9999-99-99';
    const list = dateMap.get(d) || [];
    list.push(tx);
    dateMap.set(d, list);
  }

  // 2. Sort dates in ascending chronological order
  const sortedDates = [...dateMap.keys()].sort((a, b) => a.localeCompare(b));

  // 3. For each date, order transactions
  const result: StandardTransaction[] = [];
  let runningBalance: number | null = null;

  for (const date of sortedDates) {
    const dayTxs = dateMap.get(date)!;
    if (dayTxs.length === 1) {
      result.push(dayTxs[0]);
      if (dayTxs[0].balanceAvailable !== false && dayTxs[0].balance != null) {
        runningBalance = dayTxs[0].balance;
      }
      continue;
    }

    // Check if day transactions have timestamps
    const hasTimestamps = dayTxs.some(t => t.transactionTime && t.transactionTime !== t.transactionDate);
    if (hasTimestamps) {
      dayTxs.sort((a, b) => {
        const timeA = normalizeTransactionTimestamp(a);
        const timeB = normalizeTransactionTimestamp(b);
        if (timeA !== timeB) return timeA.localeCompare(timeB);
        return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
      });
      const fScore = continuityErrorScore(dayTxs, runningBalance);
      const rScore = continuityErrorScore([...dayTxs].reverse(), runningBalance);
      const sortedDayTxs = rScore + 0.01 < fScore ? [...dayTxs].reverse() : dayTxs;

      for (const t of sortedDayTxs) {
        result.push(t);
        if (t.balanceAvailable !== false && t.balance != null) runningBalance = t.balance;
      }
      continue;
    }

    // No granular timestamps: Attempt same-day balance chain solver
    const solved = solveSameDayBalanceChain(dayTxs, runningBalance);
    for (const t of solved) {
      result.push(t);
      if (t.balanceAvailable !== false && t.balance != null) runningBalance = t.balance;
    }
  }

  return result;
}

/**
 * Greedily chains same-day transactions by matching expected balance transition.
 */
function solveSameDayBalanceChain(
  txs: StandardTransaction[],
  startBalance: number | null
): StandardTransaction[] {
  if (txs.length <= 1) return txs;

  const forwardScore = continuityErrorScore(txs, startBalance);
  const reversed = [...txs].reverse();
  const reverseScore = continuityErrorScore(reversed, startBalance);

  if (reverseScore + 0.01 < forwardScore) {
    return reversed;
  }
  return txs;
}

/**
 * Evaluates balance continuity and flags genuine discontinuities.
 * Gracefully identifies long-interval gaps (>30 days, such as credit card interest/fee summary tables).
 */
export function balanceContinuityIssues(
  transactions: StandardTransaction[]
): BalanceContinuityIssue[] {
  const ordered = chronologicalTransactions(transactions);
  const issues: BalanceContinuityIssue[] = [];

  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];

    if (
      previous.balanceAvailable === false ||
      current.balanceAvailable === false ||
      current.direction === 'UNKNOWN' ||
      previous.balance == null ||
      current.balance == null
    ) {
      continue;
    }

    const days = daysBetween(previous.transactionDate, current.transactionDate);
    const isLongInterval = days > 30;

    const delta = current.direction === 'IN' ? current.amount : -current.amount;
    const expected = previous.balance + delta;

    const diff = Math.abs(expected - current.balance);

    if (diff >= 1) {
      issues.push({
        previous,
        transaction: current,
        expected,
        daysApart: days,
        isLongInterval
      });
    }
  }

  return issues;
}

function continuityErrorScore(ordered: StandardTransaction[], initialBalance: number | null): number {
  let score = 0;
  let comparisons = 0;
  let prevBal = initialBalance;

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (current.balanceAvailable === false || current.direction === 'UNKNOWN' || current.balance == null) {
      continue;
    }
    if (prevBal != null) {
      const delta = current.direction === 'IN' ? current.amount : -current.amount;
      const expected = prevBal + delta;
      score += Math.min(Math.abs(expected - current.balance), 1_000_000);
      comparisons += 1;
    }
    prevBal = current.balance;
  }

  return comparisons ? score / comparisons : 0;
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}
