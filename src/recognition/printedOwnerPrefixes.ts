import { accountFromSource, type AssembledRow, type SourceRegistry } from './sourceAssembly';
import type { ObservationContext } from './observationConsolidation';
import type { IndependentPage } from './independentComparison';
import type { FocusedAccounts } from './accountRecovery';

/** Restore only a clipped owner column with its printed full-page header and a separate account inventory. */
export function recoverPrintedOwnerPrefixes(rows: AssembledRow[], context: ObservationContext[], registry: SourceRegistry,
  independent: Record<number, IndependentPage>, focusedAccounts: Record<number, FocusedAccounts> = {}) {
  const output: Array<{ observation: number; value: string; sources: string[] }> = [];
  rows.forEach((row, i) => {
    const prefix = row.values[0], page = context[i].page;
    if (!context[i].directOwner || !/^\d{8,11}$/.test(prefix)) return;
    const headers = Object.values(registry.cells).flatMap(cell => {
      if (cell.page !== page || cell.row !== null) return [];
      // OCR may combine the owner's ID number, card number and date interval
      // into one header cell. Select the literal full number; the independent
      // account inventory and other detailed pages below must still confirm it.
      const literalNumbers = [...cell.text.matchAll(/(?<!\d)\d{12,32}(?!\d)/g)].map(m => m[0]);
      // Prefer a contiguous number actually printed in the header. The OCR
      // normalizer may otherwise join an account to an adjacent date or ID.
      const values = new Set(literalNumbers.some(value => value.startsWith(prefix))
        ? literalNumbers : [accountFromSource(cell.text), ...literalNumbers]);
      return [...values].flatMap(value => value && /^\d{12,32}$/.test(value) && value.startsWith(prefix) ? [{ value, cell }] : []);
    });
    const choices = new Set(headers.map(h => h.value));
    if (choices.size !== 1) return;
    const value = [...choices][0];
    const detailed = rows.flatMap((r, n) => context[n].page !== page && context[n].directOwner && r.values[0] === value ? [n + 1] : []);
    const inventories = Object.entries(independent).flatMap(([p, info]) => Number(p) !== page && ['account_info', 'document'].includes(info.pageType)
      && info.ownerIdentifiers?.some(id => id.value === value && ['account', 'card'].includes(id.role)) ? [p] : []);
    const localReading = independent[page], focused = focusedAccounts[page];
    const samePageCorroboration = localReading?.coverage === 'complete' && !localReading.pageIssues.length
      && localReading.ownerIdentifiers?.some(id => id.value === value && ['account', 'card'].includes(id.role))
      && focused?.identifiers.some(id => id.value === value && id.scope === 'header'
        && ['account', 'card'].includes(id.role) && !id.uncertainPositions.length
        && id.characters.join('') === value);
    if (!(detailed.length && inventories.length) && !samePageCorroboration) return;
    output.push({ observation: i + 1, value, sources: [...headers.map(h => `cell:${h.cell.id}`),
      ...detailed.slice(0, 3).map(n => `observation:${n}:printedOwner`), ...inventories.map(p => `independent:p${p}:ownerIdentifiers`),
      ...(samePageCorroboration ? [`independent:p${page}:ownerIdentifiers`, `focused:p${page}:headerOwnerIdentifier`] : [])] });
  });
  return output;
}
