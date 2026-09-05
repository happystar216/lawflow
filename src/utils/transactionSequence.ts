import { StandardTransaction } from '../types/transaction';

export function chronologicalTransactions(transactions: StandardTransaction[]): StandardTransaction[] {
  const sourceOrdered = [...transactions].sort(compareSourceOrder);
  if (sourceOrdered.length < 2) return sourceOrdered;

  const forwardScore = continuityErrorScore(sourceOrdered);
  const reversed = [...sourceOrdered].reverse();
  const reverseScore = continuityErrorScore(reversed);
  if (reverseScore + 0.01 < forwardScore) return reversed;
  if (forwardScore + 0.01 < reverseScore) return sourceOrdered;

  const dated = sourceOrdered.filter(item => item.transactionTime || item.transactionDate);
  for (let index = 1; index < dated.length; index += 1) {
    const previous = dated[index - 1].transactionTime || dated[index - 1].transactionDate;
    const current = dated[index].transactionTime || dated[index].transactionDate;
    if (previous !== current) return previous > current ? reversed : sourceOrdered;
  }
  return sourceOrdered;
}

export function balanceContinuityIssues(transactions: StandardTransaction[]): Array<{ previous: StandardTransaction; transaction: StandardTransaction; expected: number }> {
  const ordered = chronologicalTransactions(transactions);
  const issues: Array<{ previous: StandardTransaction; transaction: StandardTransaction; expected: number }> = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.balanceAvailable === false || current.balanceAvailable === false || current.direction === 'UNKNOWN') continue;
    const expected = previous.balance + (current.direction === 'IN' ? current.amount : -current.amount);
    if (Math.abs(expected - current.balance) >= 1) issues.push({ previous, transaction: current, expected });
  }
  return issues;
}

function continuityErrorScore(ordered: StandardTransaction[]): number {
  let score = 0;
  let comparisons = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.balanceAvailable === false || current.balanceAvailable === false || current.direction === 'UNKNOWN') continue;
    const expected = previous.balance + (current.direction === 'IN' ? current.amount : -current.amount);
    score += Math.min(Math.abs(expected - current.balance), 1_000_000);
    comparisons += 1;
  }
  return comparisons ? score / comparisons : Number.POSITIVE_INFINITY;
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}
