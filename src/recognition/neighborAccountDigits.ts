import { alignIndependentRows, independentValues, type IndependentPage } from './independentComparison';
import type { AssembledRow, SourceRegistry } from './sourceAssembly';
import type { TableMappingPlan } from './tableMapping';
import { semanticText } from './semanticText';

/** Recover only an exact, evidenced cross-column concatenation. Account length
 * alone, a repeated payee, or a majority vote never establishes the digits. */
export function recoverNeighborAccountDigits(rows: AssembledRow[], mapping: TableMappingPlan,
  registry: SourceRegistry, input: Record<number, IndependentPage>) {
  const pages = structuredClone(input);
  const applied: Array<{ page: number; independentRow: number; before: string; after: string; accountCell: number; unrelatedCell: number; appendedLine: string }> = [];
  for (const [pageText, page] of Object.entries(pages)) {
    const pageNumber = Number(pageText);
    const located = rows.filter(row => row.sourceRows.length === 1 && registry.rows[row.sourceRows[0]]?.page === pageNumber)
      .sort((a, b) => {
        const x = registry.rows[a.sourceRows[0]], y = registry.rows[b.sourceRows[0]];
        return x.table - y.table || x.row - y.row;
      });
    const values = page.rows.map(independentValues);
    for (const pair of alignIndependentRows(located.map(row => row.values), values).pairs) {
      const row = located[pair.left], observation = page.rows[pair.right], read = values[pair.right];
      const account = row.values[10], longer = read[10];
      if (!/^\d{8,32}$/.test(account) || !/^\d+$/.test(longer) || !longer.startsWith(account) || longer === account
        || observation.issues.some(issue => issue.field === 'counterpartyAccount')) continue;
      if ([0, 4, 5, 6, 7].filter(field => row.values[field] && row.values[field] === read[field]).length < 4) continue;
      const proof = row.fields[10], sourceRow = registry.rows[row.sourceRows[0]];
      if (proof.length !== 1 || proof[0].normalized !== account || !registry.cells[proof[0].id].text.includes(account)) continue;
      const col = sourceRow.cells.indexOf(proof[0].id);
      const table = mapping.tables.find(t => t.page === pageNumber && t.table === sourceRow.table);
      const headers = table?.ignored.filter(i => i.kind === 'header').flatMap(i => i.r)
        .map(id => registry.rows[id]).filter(r => r?.cells.length === sourceRow.cells.length) || [];
      if (col < 0 || !headers.some(h => /^(?:对方户名[\/／]账号|对方账号[\/／]户名|对方账号|对方账户)$/.test(semanticText(registry.cells[h.cells[col]].text)))) continue;
      const appended = longer.slice(account.length);
      const neighbors = [col - 1, col + 1].filter(c => c >= 0 && c < sourceRow.cells.length
        && headers.some(h => /^(?:流水号|交易流水号|业务流水号|交易参考号)$/.test(semanticText(registry.cells[h.cells[c]].text))))
        .filter(c => registry.cells[sourceRow.cells[c]].text.split(/\r?\n|\\n/).slice(1).some(line => /^\d{6,32}$/.test(line.trim()) && line.trim() === appended));
      if (neighbors.length !== 1) continue;
      applied.push({ page: pageNumber, independentRow: observation.row, before: observation.values[7], after: account,
        accountCell: proof[0].id, unrelatedCell: sourceRow.cells[neighbors[0]], appendedLine: appended });
      observation.values[7] = account;
    }
  }
  return { pages, applied };
}
