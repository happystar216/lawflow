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

      const isSuspectedAff = /公司|企业|商贸|科技|合伙|商行|中心/.test(rawName);

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
        isSuspectedAffiliate: isSuspectedAffiliate(rawName)
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

function isSuspectedAffiliate(name: string): boolean {
  return /有限|公司|商行|科技|建材|商贸|劳务|投资|贸易|厂|合伙/.test(name);
}
