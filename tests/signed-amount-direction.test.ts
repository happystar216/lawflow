import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQualitySources } from '../src/recognition/qualitySources';
import { recoverSignedIncome } from '../src/recognition/signedAmountDirection';
import type { AssembledRow } from '../src/recognition/sourceAssembly';
import type { MappedTable } from '../src/recognition/tableMapping';
import type { IndependentPage } from '../src/recognition/independentComparison';

test('unsigned credit in a signed amount column needs a printed debit and an independent credit reading', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [
    ['账号', '日期', '金额', '余额'],
    ['001234567890', '2026-01-01', '-10.00', '90.00'],
    ['001234567890', '2026-01-02', '25.00', '115.00']
  ] }] }]);
  const table: MappedTable = { page: 1, table: 1, kind: 'transactions', accountKind: 'deposit',
    groups: [[2], [3]], ignored: [{ r: [1], kind: 'header' }],
    fields: { amount: { row: 0, col: 3 } }, directionCodes: null };
  const values = (date: string, direction: string, amount: string, balance: string) =>
    ['001234567890', '', '', date, date, direction, amount, balance, '', '', '', ''];
  const rows: AssembledRow[] = [
    { id: 'T1', values: values('2026-01-01', 'OUT', '10.00', '90.00'), sourceRows: [2],
      fields: Array.from({ length: 12 }, (_, col) => col === 6 ? [{ id: registry.rows[2].cells[2], text: '-10.00', normalized: '10.00' }] : []) },
    { id: 'T2', values: values('2026-01-02', '', '25.00', '115.00'), sourceRows: [3],
      fields: Array.from({ length: 12 }, (_, col) => col === 6 ? [{ id: registry.rows[3].cells[2], text: '25.00', normalized: '25.00' }] : []) }
  ];
  const reading: IndependentPage = { pageType: 'transactions', coverage: 'complete', pageIssues: [], rows: [
    { row: 1, values: ['001234567890', '2026-01-01', '', 'OUT', '10.00', '90.00', '', ''], rawDirection: '-10.00', issues: [] },
    { row: 2, values: ['001234567890', '2026-01-02', '', 'IN', '25.00', '115.00', '', ''], rawDirection: '25.00', issues: [] }
  ] };
  assert.deepEqual(recoverSignedIncome(rows, { tables: [table], typeRules: [] }, registry, { 1: reading }), [1]);
  registry.cells[registry.rows[1].cells[2]].text = '余额';
  assert.deepEqual(recoverSignedIncome(rows, { tables: [table], typeRules: [] }, registry, { 1: reading }), []);
  registry.cells[registry.rows[1].cells[2]].text = '金额';
  reading.rows[1].values[3] = 'OUT';
  assert.deepEqual(recoverSignedIncome(rows, { tables: [table], typeRules: [] }, registry, { 1: reading }), []);
});
