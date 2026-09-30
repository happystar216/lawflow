import { STATEMENT_COLUMNS, type AssembledRow, type AssemblyIssue, type SourceRegistry } from './sourceAssembly';

type Location = { page: number; table: number; order: number; accountKind: string };
const cents = (s: string): bigint | null => /^-?\d+\.\d{2}$/.test(s) ? BigInt(s.replace('.', '')) : null;

/** Check adjacent printed deposit rows. Never infer a value from the equation. */
export function sourceBalanceChecks(rows: AssembledRow[], metadata: Location[], registry: SourceRegistry): AssemblyIssue[] {
  const issues: AssemblyIssue[] = [];
  const groups = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const meta = metadata[index];
    if (meta.accountKind !== 'deposit' || !row.values[0]) return;
    const key = JSON.stringify([meta.page, meta.table, row.values[0]]);
    groups.set(key, [...(groups.get(key) || []), index]);
  });
  for (const indices of groups.values()) {
    indices.sort((a, b) => metadata[a].order - metadata[b].order);
    const dates = indices.map(i => rows[i].values[3] || rows[i].values[4]);
    if (dates.some(d => !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(d))) continue;
    const signs = new Set(dates.slice(1).map((d, i) => d > dates[i] ? 1 : d < dates[i] ? -1 : 0).filter(Boolean));
    // Do not guess chronology for all-identical timestamps or mixed ordering.
    if (signs.size !== 1) continue;
    if (signs.has(-1)) indices.reverse();
    for (let k = 1; k < indices.length; k++) {
      const beforeIndex = indices[k - 1], afterIndex = indices[k];
      const before = rows[beforeIndex], after = rows[afterIndex];
      const a = before.sourceRows.map(id => registry.rows[id]?.row), b = after.sourceRows.map(id => registry.rows[id]?.row);
      if (a.some(x => x === undefined) || b.some(x => x === undefined)
        || !(Math.max(...a) + 1 === Math.min(...b) || Math.max(...b) + 1 === Math.min(...a))) continue;
      const previous = cents(before.values[7]), amount = cents(after.values[6]), current = cents(after.values[7]);
      if (previous === null || amount === null || current === null || !['IN', 'OUT'].includes(after.values[5])) continue;
      const delta = previous + (after.values[5] === 'IN' ? amount : -amount) - current;
      if (delta === 0n) continue;
      const absolute = delta < 0n ? -delta : delta;
      const formatted = `${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
      const location = metadata[afterIndex];
      const message = `第${location.page}页第${location.table}张表相邻原行${Math.min(...a)}、${Math.min(...b)}的余额衔接相差${formatted}元。请核对前笔余额、本笔金额、方向及余额，可能存在误读、漏行或原件不连续；未按差额改数。`;
      for (const [index, field] of [[beforeIndex, 7], [afterIndex, 6], [afterIndex, 5], [afterIndex, 7]]) {
        issues.push({ id: `BALANCE_${beforeIndex + 1}_${afterIndex + 1}_${index + 1}_${field}`,
          code: 'SOURCE_BALANCE_DISCONTINUITY', field: STATEMENT_COLUMNS[field], severity: 'REQUIRED',
          outputRows: [index + 1], sourceRows: [...before.sourceRows, ...after.sourceRows],
          sourceCells: rows[index].fields[field].map(s => s.id), message });
      }
    }
  }
  return issues;
}
