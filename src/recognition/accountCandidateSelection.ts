import { alignIndependentRows, independentValues, type IndependentPage } from './independentComparison';
import type { QualityRow } from './acceptanceEvaluation';
import type { AssemblyIssue, SourceRegistry } from './sourceAssembly';

export interface AccountCandidateSelection {
  outputRow: number; field: 'counterpartyAccount'; before: string; after: string;
  page: number; sources: string[];
}

/** Choose a provisional account without certifying it. The original conflict,
 * source transcript and both image readings remain available for human review.
 * Two prompts on the same model are not independent proof of correctness. */
export function selectAccountCandidates(rows: QualityRow[], pending: AssemblyIssue[], registry: SourceRegistry,
  first: Record<number, IndependentPage>, fresh: Record<number, IndependentPage>) {
  const selected: AccountCandidateSelection[] = [];
  for (const [pageText, reread] of Object.entries(fresh)) {
    const page = Number(pageText), original = first[page];
    if (!original || [original, reread].some(p => p.coverage !== 'complete' || p.pageIssues.length)) continue;
    const located = rows.map((row, index) => ({ row, index, source: row.sourceObservationIds
      .map(s => /^source:\d+$/.test(s) ? registry.rows[s.slice(7)] : undefined).filter(s => !!s) }))
      .filter(x => x.source.length === 1 && x.source[0]!.page === page)
      .sort((a, b) => a.source[0]!.table - b.source[0]!.table || a.source[0]!.row - b.source[0]!.row);
    if (located.length !== original.rows.length || located.length !== reread.rows.length) continue;
    const values = located.map(x => x.row.values);
    const a = original.rows.map(independentValues), b = reread.rows.map(independentValues);
    const oldPairs = new Map(alignIndependentRows(values, a).pairs.map(p => [p.left, p.right]));
    for (const pair of alignIndependentRows(values, b).pairs) {
      const ai = oldPairs.get(pair.left); if (ai === undefined) continue;
      const { row, index } = located[pair.left], before = row.values[10], after = a[ai][10];
      if (!pending.some(i => i.severity !== 'ADVISORY' && i.code === 'INDEPENDENT_VALUE_CONFLICT'
        && i.field === 'counterpartyAccount' && i.outputRows.includes(index + 1))) continue;
      if (!/^\d{8,32}$/.test(before) || !/^\d{8,32}$/.test(after) || before.length !== after.length
        || before === after || b[pair.right][10] !== after) continue;
      const anchors = [0, 4, 5, 6, 7];
      if (!anchors.every(f => row.values[f] && row.values[f] === a[ai][f] && row.values[f] === b[pair.right][f])
        || original.rows[ai].issues.length || reread.rows[pair.right].issues.length) continue;
      selected.push({ outputRow: index + 1, field: 'counterpartyAccount', before, after, page,
        sources: [`independent:p${page}:row${original.rows[ai].row}:counterpartyAccount`,
          `criticalReread:p${page}:row${reread.rows[pair.right].row}:counterpartyAccount`] });
    }
  }
  return selected;
}
