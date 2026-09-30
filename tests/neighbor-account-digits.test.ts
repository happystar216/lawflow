import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQualitySources } from '../src/recognition/qualitySources';
import { materializeTableMapping, type TableMappingPlan } from '../src/recognition/tableMapping';
import { recoverNeighborAccountDigits } from '../src/recognition/neighborAccountDigits';
import type { IndependentPage } from '../src/recognition/independentComparison';

function fixture() {
  const { registry } = buildQualitySources([{ nearTableText: ['001234567890'], tables: [{ rows: [
    ['日期', '方向', '金额', '余额', '流水号', '对方户名/账号'],
    ['2026-01-01', '支出', '10', '90', '1234567890\\n9988776655', '测试公司/009876543210']
  ] }] }]);
  const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', groups: [[2]],
    ignored: [{ r: [1], kind: 'header' }], directionCodes: null,
    fields: { accountNumber: { fixed: 1 }, transactionDate: { row: 0, col: 1 }, direction: { row: 0, col: 2 },
      amount: { row: 0, col: 3 }, balance: { row: 0, col: 4 }, counterpartyAccount: { row: 0, col: 6, part: 'account' } } }], typeRules: [] };
  const rows = materializeTableMapping(mapping, registry).rows;
  const independent: Record<number, IndependentPage> = { 1: { pageType: 'transactions', coverage: 'complete', pageIssues: [], rows: [
    { row: 1, values: ['001234567890', '2026-01-01', '', 'OUT', '10.00', '90.00', '测试公司', '0098765432109988776655'], rawDirection: '支出', issues: [] }
  ] } };
  return { registry, mapping, rows, independent };
}

test('only an exact continuation from the adjacent printed serial-number column is removed from an independent account', () => {
  const f = fixture();
  const original = JSON.stringify(f.independent);
  const result = recoverNeighborAccountDigits(f.rows, f.mapping, f.registry, f.independent);
  assert.equal(result.pages[1].rows[0].values[7], '009876543210');
  assert.equal(result.applied[0].appendedLine, '9988776655');
  assert.equal(JSON.stringify(f.independent), original);
  assert.equal(f.rows[0].values[10], '009876543210');
});

test('legitimate longer accounts, different cells, missing headers and uncertain digits cannot be shortened', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.independent[1].rows[0].values[7] = '0098765432101234567890'; },
    (f: ReturnType<typeof fixture>) => { f.registry.cells[f.registry.rows[1].cells[4]].text = '备注'; },
    (f: ReturnType<typeof fixture>) => { f.registry.cells[f.registry.rows[2].cells[4]].text = '12345678909988776655'; },
    (f: ReturnType<typeof fixture>) => { f.independent[1].rows[0].issues.push({ field: 'counterpartyAccount', kind: 'uncertain', reason: '遮挡' }); },
    (f: ReturnType<typeof fixture>) => { f.independent[1].rows[0].values[0] = ''; f.independent[1].rows[0].values[1] = ''; }
  ]) {
    const f = fixture(); change(f);
    assert.equal(recoverNeighborAccountDigits(f.rows, f.mapping, f.registry, f.independent).applied.length, 0);
  }
});
