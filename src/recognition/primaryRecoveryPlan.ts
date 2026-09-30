import type { AssemblyIssue, SourceRegistry } from './sourceAssembly';

/** Whole-page source rereads address observed coverage and key-value disagreement. */
export function planPrimaryRecovery(issues: AssemblyIssue[], registry: SourceRegistry, maxPages = 6) {
  const structuralCodes = new Set(['INDEPENDENT_ROW_UNMATCHED', 'INDEPENDENT_EXTRA_OBSERVATION',
    'UNASSIGNED_SOURCE_ROW', 'SOURCE_ROW_REUSED', 'INDEPENDENT_PAGE_INCOMPLETE']);
  const eligible = (issue: AssemblyIssue) => structuralCodes.has(issue.code)
    || issue.code === 'SOURCE_BALANCE_DISCONTINUITY'
    || issue.code === 'INDEPENDENT_VALUE_CONFLICT' && ['accountNumber', 'counterpartyAccount', 'amount', 'balance', 'transactionDate', 'direction'].includes(issue.field || '');
  const selected = new Map<number, Set<string>>();
  for (const issue of issues) {
    if (!eligible(issue) || issue.severity === 'ADVISORY') continue;
    const pages = new Set([...(issue.sourcePages || []), ...issue.sourceRows.map(r => registry.rows[r]?.page),
      ...issue.sourceCells.map(c => registry.cells[c]?.page)].filter((p): p is number => Boolean(p)));
    for (const page of pages) {
      const reasons = selected.get(page) || new Set<string>(); reasons.add(issue.code); selected.set(page, reasons);
    }
  }
  // A disputed transaction must not lose its reread to an earlier page that
  // contains no transaction observations. Keep the same bounded budget.
  const impact = (page: number) => {
    const relevant = issues.filter(i => i.severity !== 'ADVISORY' && eligible(i)
      && (i.sourcePages?.includes(page) || i.sourceRows.some(r => registry.rows[r]?.page === page)
        || i.sourceCells.some(c => registry.cells[c]?.page === page)));
    const structural = relevant.some(i => structuralCodes.has(i.code) && i.code !== 'INDEPENDENT_PAGE_INCOMPLETE');
    const rows = new Set(relevant.flatMap(i => i.outputRows)).size;
    return { structural, rows };
  };
  const pages = [...selected].map(([page, reasons]) => ({ page, reasons: [...reasons], priority: impact(page) }))
    .sort((a, b) => Number(b.priority.structural) - Number(a.priority.structural) || b.priority.rows - a.priority.rows || a.page - b.page);
  return { standardAnswersRead: false, mode: 'FULL_PAGE_PRIMARY_REREAD', selected: pages.slice(0, maxPages),
    deferred: pages.slice(maxPages), complete: pages.length <= maxPages };
}
