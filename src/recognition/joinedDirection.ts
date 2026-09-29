import { alignIndependentRows, independentValues, type IndependentPage } from './independentComparison';
import type { AssembledRow, SourceRegistry } from './sourceAssembly';
import { semanticText } from './semanticText';

/** OCR may join a description and its adjacent one-character direction cell.
 * A literal suffix alone is insufficient: a separate image reading must locate
 * the same transaction and read that exact direction marker without uncertainty.
 */
export function recoverJoinedDirections(rows: AssembledRow[], registry: SourceRegistry, independent: Record<number, IndependentPage>) {
  const recovered: Array<{ observation: number; value: string; cell: number; marker: string; source: string }> = [];
  for (const [pageText, page] of Object.entries(independent)) {
    const pageNumber = Number(pageText);
    if (page.coverage !== 'complete' || page.pageIssues.length) continue;
    const located = rows.map((row, index) => ({ row, index })).filter(x => x.row.sourceRows.some(id => registry.rows[id]?.page === pageNumber));
    const alt = page.rows.map(independentValues);
    for (const pair of alignIndependentRows(located.map(x => x.row.values), alt).pairs) {
      const { row, index } = located[pair.left], reading = page.rows[pair.right], values = alt[pair.right];
      if (row.values[5] || reading.issues.some(i => i.field === 'direction')) continue;
      const marker = semanticText(reading.rawDirection), value = marker === '出' ? 'OUT' : marker === '进' ? 'IN' : '';
      if (!value || values[5] !== value) continue;
      const anchors = [0, 4, 6, 7, 10].filter(f => row.values[f] && row.values[f] === values[f]);
      if (anchors.length < 3) continue;
      const proof = row.fields[5].filter(s => {
        const text = semanticText(s.text);
        return text.length > 1 && text.endsWith(marker) && !/[进出]/.test(text.slice(0, -1))
          && registry.cells[s.id]?.text.includes(s.text);
      });
      if (proof.length !== 1) continue;
      recovered.push({ observation: index + 1, value, cell: proof[0].id, marker,
        source: `independent:p${pageNumber}:row${reading.row}:rawDirection` });
    }
  }
  return recovered;
}
