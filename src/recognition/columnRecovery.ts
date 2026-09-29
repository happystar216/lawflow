import type { SourceRegistry } from './sourceAssembly';
import type { MappedTable, ColumnSelector } from './tableMapping';
import { semanticText } from './semanticText';

const descriptionHeader = /^(?:交易摘要|摘要|交易说明|交易描述|用途)$/;

/** Consistent name+four-digit suffix in a column explicitly labelled 对方信息.
 * The suffix remains partial; it is never expanded into a complete account.
 */
export function combinedPartySuffixColumn(table: MappedTable, registry: SourceRegistry): number | null {
  if (table.kind !== 'transactions' || table.groups.length < 3 || table.groups.some(g => g.length !== 1)) return null;
  const cols = new Set(table.ignored.filter(h => h.kind === 'header').flatMap(h => h.r)
    .flatMap(id => registry.rows[id]?.cells.flatMap((c, i) => semanticText(registry.cells[c].text) === '对方信息' ? [i + 1] : []) || []));
  if (cols.size !== 1) return null;
  const col = [...cols][0];
  const values = table.groups.map(g => registry.cells[registry.rows[g[0]].cells[col - 1]]?.text.trim() || '').filter(Boolean);
  return values.length >= 3 && values.every(s => /^[^\d]+\d{4}$/.test(s)) ? col : null;
}

/** Combined party labels identify a column; they do not authorize guessing its contents. */
export function combinedPartyColumn(table: MappedTable, registry: SourceRegistry): number | null {
  if (table.kind !== 'transactions' || !table.groups.length || table.groups.some(g => g.length !== 1)) return null;
  const columns = new Set(table.ignored.filter(i => i.kind === 'header').flatMap(i => i.r)
    .flatMap(id => registry.rows[id]?.cells.flatMap((cell, col) =>
      /^(?:对方|交易对手)(?:账号|帐号)(?:与|及|和|[\/／、])(?:户名|名称|姓名)$/.test(registry.cells[cell].text.replace(/\s/g, '')) ? [col + 1] : []) || []));
  return columns.size === 1 ? [...columns][0] : null;
}

/** An omitted mapping can be recovered from a unique literal label, never from values alone. */
export function recoverDescriptionColumn(table: MappedTable, registry: SourceRegistry): { selector: ColumnSelector; sources: number[]; basis: string } | null {
  if (table.kind !== 'transactions' || !table.groups.length || table.groups.some(g => g.length !== 1)) return null;
  const headers = table.ignored.filter(i => i.kind === 'header').flatMap(i => i.r).map(id => registry.rows[id]).filter(Boolean);
  const direct = headers.flatMap(header => header.cells.flatMap((id, col) =>
    descriptionHeader.test(semanticText(registry.cells[id].text)) ? [{ id, col: col + 1 }] : []));
  const selected = table.fields.description;
  if (new Set(direct.map(d => d.col)).size === 1 && (!selected || headers.length === 1
    && table.groups.every(g => registry.rows[g[0]].cells.length === headers[0].cells.length))) {
    if (selected && 'row' in selected && selected.row === 0 && selected.col === direct[0].col) return null;
    return { selector: { row: 0, col: direct[0].col }, sources: direct.map(d => d.id), basis: 'UNIQUE_LITERAL_DESCRIPTION_HEADER' };
  }
  if (selected) return null;
  const tableNumbers = new Set(Object.values(registry.rows).filter(r => r.page === table.page).map(r => r.table));
  const detached = Object.values(registry.cells).filter(c => c.page === table.page && c.row === null
    && /^(?:交易摘要|摘要|交易说明|用途)$/.test(c.text.trim()));
  if (tableNumbers.size === 1 && headers.length === 1 && detached.length === 1) {
    const width = headers[0].cells.length;
    if (table.groups.every(group => registry.rows[group[0]].cells.length === width + 1)) {
      return { selector: { row: 0, col: width + 1 }, sources: [detached[0].id], basis: 'DETACHED_DESCRIPTION_HEADER_AND_EXACTLY_ONE_EXTRA_COLUMN_IN_EVERY_ROW' };
    }
  }
  return null;
}
