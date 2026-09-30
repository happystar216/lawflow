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
  return new Map(matches.flatMap((indices, observation) => indices.length === 1
    && matches.filter(other => other.includes(indices[0])).length === 1 ? [[observation, indices[0]] as const] : []));
}

/** A reread cannot discard transactions already supported by both readers.
 * Conflicting/partial alternatives stay in the call log; remaining gaps still
 * go through the ordinary independent comparison and manual review queue. */
export function selectPrimaryRecovery(original: VerbatimPage, reread: VerbatimPage, independent: IndependentPage) {
  const before = corroboratedRows(original, independent);
  const after = corroboratedRows(reread, independent);
  const lost = [...before.keys()].filter(row => !after.has(row));
  const retainedSourceRows: Array<{ table: number; row: number; independentRow: number }> = [];
  let selected = lost.length ? original : reread;
  // If the complete table grid and supported row positions are unchanged, keep
  // the old WHOLE source row for an isolated new error. Do not discard all
  // improved headers/other rows merely because one reread amount went wrong.
  const sameGrid = original.tables.length === reread.tables.length && original.tables.every((table, i) => {
    const other = reread.tables[i];
    return table.rows.length === other.rows.length && table.rows.length >= 5
      && JSON.stringify(table.rows[0]) === JSON.stringify(other.rows[0])
      && !table.rows[0].some(cell => dateFromSource(cell))
      && table.rows.every((row, j) => row.length === table.rows[0].length && other.rows[j].length === row.length);
  });
  if (lost.length && sameGrid && independent.coverage === 'complete' && !independent.pageIssues.length
    && [...before].every(([observation, index]) => !after.has(observation) || after.get(observation) === index)) {
    const positions = original.tables.flatMap((table, t) => table.rows.map((_, r) => ({ t, r })));
    const stable = [...before].filter(([observation, index]) => after.get(observation) === index).map(([, index]) => positions[index]);
    const candidate = structuredClone(reread);
    let safe = true;
    for (const observation of lost) {
      const index = before.get(observation)!, { t, r } = positions[index];
      const fresh = reread.tables[t].rows[r], reference = independent.rows[observation];
      if (!r || stable.filter(p => p.t === t).length < 3 || [...after.values()].includes(index)
        || !fresh.some(cell => dateFromSource(cell) === dateFromSource(reference.values[1]))
        || !fresh.some(cell => moneyFromSource(cell) === moneyFromSource(reference.values[5]))) { safe = false; break; }
      candidate.tables[t].rows[r] = [...original.tables[t].rows[r]];
      retainedSourceRows.push({ table: t + 1, row: r + 1, independentRow: reference.row });
    }
    const combined = corroboratedRows(candidate, independent);
    if (safe && [...before.keys(), ...after.keys()].every(observation => combined.has(observation))) selected = candidate;
    else retainedSourceRows.length = 0;
  }
  return { selected,
    decision: { retainedOriginal: selected === original, corroboratedBefore: before.size,
      corroboratedAfter: after.size, corroboratedSelected: corroboratedRows(selected, independent).size,
      retainedSourceRows, lostIndependentRows: lost.map(index => independent.rows[index].row) } };
}
