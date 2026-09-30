import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQualitySources } from '../src/recognition/qualitySources';
import { materializeTableMapping, type TableMappingPlan } from '../src/recognition/tableMapping';
import { sourceBalanceChecks } from '../src/recognition/sourceBalanceChecks';

function fixture(data: string[][], kind: 'deposit' | 'credit' = 'deposit') {
  const { registry } = buildQualitySources([{ nearTableText: ['001234567890'], tables: [{ rows: data }] }]);
  const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: kind,
    groups: data.map((_, i) => [i + 1]), ignored: [], directionCodes: null,
    fields: { accountNumber: { fixed: 1 }, transactionDate: { row: 0, col: 1 }, direction: { row: 0, col: 2 },
      amount: { row: 0, col: 3 }, balance: { row: 0, col: 4 } } }], typeRules: [] };
  const { rows, metadata } = materializeTableMapping(mapping, registry);
  return { rows, metadata, registry };
}
const data = [['2026-01-01', '支出', '10', '90'], ['2026-01-02', '收入', '20', '110']];

test('one cent discontinuity points to both printed rows and never modifies their values', () => {
  const f = fixture([data[0], ['2026-01-02', '收入', '20.01', '110']]);
  const before = JSON.stringify(f.rows);
  const issues = sourceBalanceChecks(f.rows, f.metadata, f.registry);
  assert.equal(issues.length, 4);
  assert.deepEqual(issues.map(i => [i.outputRows, i.field]), [[[1], 'balance'], [[2], 'amount'], [[2], 'direction'], [[2], 'balance']]);
  assert.match(issues[0].message, /0.01元/);
  assert.equal(JSON.stringify(f.rows), before);
});

test('ascending and descending deposit tables reconcile with integer cents', () => {
  for (const entries of [data, [...data].reverse()]) {
    const f = fixture(entries);
    assert.deepEqual(sourceBalanceChecks(f.rows, f.metadata, f.registry), []);
  }
});

test('credit tables, missing money, source gaps and ambiguous chronology do not assert balance breaks', () => {
  for (const [entries, kind] of [
    [[data[0], ['2026-01-02', '收入', '99', '110']], 'credit'],
    [[data[0], ['2026-01-02', '收入', '', '110']], 'deposit'],
    [[data[0], ['2026-01-01', '收入', '99', '110']], 'deposit']
  ] as const) {
    const f = fixture(entries.map(r => [...r]), kind);
    assert.deepEqual(sourceBalanceChecks(f.rows, f.metadata, f.registry), []);
  }
  const f = fixture([data[0], ['2026-01-02', '收入', '99', '110']]);
  f.registry.rows[2].row = 4;
  assert.deepEqual(sourceBalanceChecks(f.rows, f.metadata, f.registry), []);
});
