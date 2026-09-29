import { accountFromSource, type AssembledRow, type AssemblyIssue, type SourceRegistry } from './sourceAssembly';
import type { IndependentPage } from './independentComparison';

/** Bind an owner name only to exact independently read owner identifiers and a
 * matching printed page header. Counterparty text and unnamed neighbouring
 * accounts cannot supply the owner. Conflicting names stay unresolved.
 */
export function recoverOwnerNames(rows: AssembledRow[], registry: SourceRegistry,
  independent: Record<number, IndependentPage>, issues: AssemblyIssue[]) {
  const candidates = new Map<string, Map<string, { id: number; text: string; page: number }>>();
  for (const [p, reading] of Object.entries(independent)) {
    const page = Number(p);
    if (reading.coverage !== 'complete' || reading.pageIssues.length) continue;
    const names = [...new Set(reading.ownerNames || [])].filter(n => n.trim() && !/\d/.test(n));
    if (names.length !== 1) continue;
    const name = names[0];
    const labelled = (text: string) => {
      const prefix = /^(?:户名|客户姓名|账户名称|姓名)\s*[:：]?\s*/.exec(text);
      if (!prefix) return false;
      const value = text.slice(prefix[0].length);
      return value === name || value.startsWith(name) && /^(?:\s|\d)/.test(value.slice(name.length));
    };
    const proof = Object.values(registry.cells).find(c => c.page === page && c.row === null
      && (c.text.trim() === name || labelled(c.text)
        || c.text.startsWith(name) && /^\d{15}(?:\d{2}[\dXx])?(?:\s|$)/.test(c.text.slice(name.length))
          && reading.ownerIdentifiers?.some(i => c.text.includes(i.value)))
      && c.text.includes(name) && c.text.indexOf(name) === c.text.lastIndexOf(name));
    if (!proof) continue;
    for (const identifier of reading.ownerIdentifiers || []) {
      const account = accountFromSource(identifier.value);
      if (!account || !/^\d{8,32}$/.test(account)) continue;
      const values = candidates.get(account) || new Map();
      values.set(name, { id: proof.id, text: name, page }); candidates.set(account, values);
    }
  }
  const repairs: Array<{ observation: number; value: string; proof: { id: number; text: string; page: number } }> = [];
  rows.forEach((row, index) => {
    const choices = candidates.get(row.values[0]);
    if (choices?.size !== 1) return;
    const [name, proof] = [...choices][0];
    const invalid = issues.some(i => i.field === 'accountName' && i.outputRows.includes(index + 1)
      && ['OUTSIDE_TRANSACTION_SOURCES', 'INVALID_SOURCE_FRAGMENT'].includes(i.code));
    const combinedIdentifier = row.values[1].startsWith(name) && /^\d{15,18}[Xx]?$/.test(row.values[1].slice(name.length));
    if (!invalid && row.values[1] && !combinedIdentifier) return;
    repairs.push({ observation: index + 1, value: name, proof });
  });
  return repairs;
}
