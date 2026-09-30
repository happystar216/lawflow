import { moneyFromSource, type AssembledRow, type SourceRegistry } from './sourceAssembly';
import type { TableMappingPlan } from './tableMapping';

/** Read the occupied side of explicit deposit debit/credit columns, never a numeric direction code. */
export function recoverPairedAmountDirections(rows: AssembledRow[], mapping: TableMappingPlan, registry: SourceRegistry) {
  const repairs: Array<{ index: number; direction: string; sources: number[] }> = [];
  for (const table of mapping.tables) {
    if (table.kind !== 'transactions' || table.accountKind !== 'deposit') continue;
    const headers = table.ignored.filter(x => x.kind === 'header').flatMap(x => x.r)
      .map(id => registry.rows[id]).filter(r => r?.page === table.page && r.table === table.table);
    const find = (pattern: RegExp) => headers.flatMap(r => r.cells.flatMap((id, col) =>
      pattern.test(registry.cells[id].text.replace(/\s/g, '')) ? [{ id, col, width: r.cells.length }] : []));
    const debit = find(/^(?:借方发生额|借方金额|支出金额)$/), credit = find(/^(?:贷方发生额|贷方金额|收入金额)$/);
    if (debit.length !== 1 || credit.length !== 1 || debit[0].col === credit[0].col || debit[0].width !== credit[0].width) continue;
    rows.forEach((row, index) => {
      if (row.values[5] || row.sourceRows.length !== 1) return;
      const source = registry.rows[row.sourceRows[0]];
      if (!source || source.page !== table.page || source.table !== table.table || source.cells.length !== debit[0].width) return;
      const ids = [source.cells[debit[0].col], source.cells[credit[0].col]];
      const amounts = ids.map(id => moneyFromSource(registry.cells[id].text));
      // Both cells must be readable, exactly one positive and the other explicitly zero.
      // A blank can mean lost OCR, so it cannot establish the opposite side.
      const side = amounts[0] && !amounts[0].startsWith('-') && amounts[0] !== '0.00' && amounts[1] === '0.00' ? 0
        : amounts[1] && !amounts[1].startsWith('-') && amounts[1] !== '0.00' && amounts[0] === '0.00' ? 1 : -1;
      if (side < 0 || row.values[6] !== amounts[side]) return;
      repairs.push({ index, direction: side === 0 ? 'OUT' : 'IN', sources: [debit[0].id, credit[0].id, ...ids] });
    });
  }
  return repairs;
}
