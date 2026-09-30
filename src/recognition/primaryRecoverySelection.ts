import type { VerbatimPage } from './qualityProtocol';
import type { IndependentPage } from './independentComparison';
import { dateFromSource, moneyFromSource } from './sourceAssembly';

/** Coverage evidence only: never changes a cell or invents a transaction. */
function corroboratedRows(page: VerbatimPage, independent: IndependentPage) {
  const raw = page.tables.flatMap(table => table.rows);
  const matches = independent.rows.map(observation => {
    const date = dateFromSource(observation.values[1]);
    const amount = moneyFromSource(observation.values[4], true);
    const balance = moneyFromSource(observation.values[5]);
    if (!date || amount == null || balance == null) return [];
    return raw.flatMap((cells, index) => {
      if (!cells.some(cell => dateFromSource(cell) === date)) return [];
      // Amount and balance must occupy distinct printed cells, even when equal.
      const agrees = cells.some((cell, a) => moneyFromSource(cell, true) === amount
        && cells.some((other, b) => b !== a && moneyFromSource(other) === balance));
      return agrees ? [index] : [];
    });
  });
  return new Set(matches.flatMap((indices, observation) => indices.length === 1
    && matches.filter(other => other.includes(indices[0])).length === 1 ? [observation] : []));
}

/** A reread cannot discard transactions already supported by both readers.
 * Conflicting/partial alternatives stay in the call log; remaining gaps still
 * go through the ordinary independent comparison and manual review queue. */
export function selectPrimaryRecovery(original: VerbatimPage, reread: VerbatimPage, independent: IndependentPage) {
  const before = corroboratedRows(original, independent);
  const after = corroboratedRows(reread, independent);
  const lost = [...before].filter(row => !after.has(row));
  return { selected: lost.length ? original : reread,
    decision: { retainedOriginal: lost.length > 0, corroboratedBefore: before.size,
      corroboratedAfter: after.size, lostIndependentRows: lost.map(index => independent.rows[index].row) } };
}
