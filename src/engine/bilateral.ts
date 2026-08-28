import { StandardTransaction, CounterpartySummary } from '../types/transaction';

/**
 * Aggregates bilateral cash flows per counterparty (total in, total out, net flow)
 * and detects suspected relatives or corporate affiliates.
 */
export function aggregateCounterparties(
  transactions: StandardTransaction[],
  debtorName: string = ''
): Record<string, CounterpartySummary> {
  const map: Record<string, CounterpartySummary> = {};

  const debtorSurname = debtorName ? debtorName.trim().charAt(0) : '';

  transactions.forEach(tx => {
    // Exclude internal transfers from external counterparty analysis
    if (tx.isInternalTransfer) return;

    const rawName = tx.counterpartyName?.trim() || '【无对手方名称/现金】';
    if (!map[rawName]) {
      const isSuspectedRel = (
        debtorSurname !== '' && 
        rawName.startsWith(debtorSurname) && 
        rawName.length <= 4 && 
        rawName !== debtorName
      ) || /生活费|赡养|学费|零用钱|配偶|亲属|儿子|女儿|父母/.test(tx.summary || '');

      map[rawName] = {
        name: rawName,
        account: tx.counterpartyAccount,
        totalIn: 0,
        totalOut: 0,
        netOut: 0,
        transactionCount: 0,
        earliestDate: tx.transactionDate,
        latestDate: tx.transactionDate,
        frequentSummaries: [],
        roleTag: tx.counterpartyRoleTag,
        isSuspectedRelative: isSuspectedRel,
        // A company suffix only identifies an enterprise counterparty; it is
        // not evidence of an affiliation with the debtor.
        isSuspectedAffiliate: false
      };
    }

    const item = map[rawName];
    item.transactionCount += 1;
    if (tx.direction === 'IN') {
      item.totalIn += tx.amount;
    } else {
      item.totalOut += tx.amount;
    }
    item.netOut = item.totalOut - item.totalIn;

    if (tx.transactionDate < item.earliestDate) item.earliestDate = tx.transactionDate;
    if (tx.transactionDate > item.latestDate) item.latestDate = tx.transactionDate;

    if (tx.summary && !item.frequentSummaries.includes(tx.summary) && item.frequentSummaries.length < 5) {
      item.frequentSummaries.push(tx.summary);
    }
  });

  return map;
}
