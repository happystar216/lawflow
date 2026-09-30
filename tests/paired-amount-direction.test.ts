import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQualitySources } from '../src/recognition/qualitySources';
import { materializeTableMapping, type TableMappingPlan } from '../src/recognition/tableMapping';
import { recoverPairedAmountDirections } from '../src/recognition/pairedAmountDirection';
import { selectSourceParty } from '../src/recognition/sourceFragments';
import { runQualityTrial } from '../src/recognition/qualityTrialPipeline';
import type { IndependentPage } from '../src/recognition/independentComparison';

test('printed column directions clear corroborated alerts while an independent disagreement remains visible', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [
    ['日期', '借方金额', '贷方金额', '金额', '余额'], ['2026-01-01', '10', '0', '10', '90'],
    ['2026-01-02', '0', '20', '20', '110']
  ] }] }]);
  const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit',
    groups: [[2], [3]], ignored: [{ r: [1], kind: 'header' }], directionCodes: null,
    fields: { transactionDate: { row: 0, col: 1 }, amount: { row: 0, col: 4 }, balance: { row: 0, col: 5 } } }], typeRules: [] };
  const page: IndependentPage = { pageType: 'transactions', coverage: 'complete', pageIssues: [], rows: [
    { row: 1, values: ['', '2026-01-01', '', 'OUT', '10', '90', '', ''], rawDirection: '借方', issues: [] },
    { row: 2, values: ['', '2026-01-02', '', 'IN', '20', '110', '', ''], rawDirection: '贷方', issues: [] }
  ] };
  const result = runQualityTrial(mapping, registry, { 1: page }, { singleIssuerDocument: false });
  assert.deepEqual(result.rows.map(r => r.values[5]), ['OUT', 'IN']);
  assert.ok(!result.pending.some(i => i.field === 'direction'));
  page.rows[1].values[3] = 'OUT';
  const conflict = runQualityTrial(mapping, registry, { 1: page }, { singleIssuerDocument: false });
  assert.ok(conflict.pending.some(i => i.field === 'direction' && i.code === 'INDEPENDENT_VALUE_CONFLICT'));
});

test('deposit column direction requires a readable zero opposite an amount that matches the selected source', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [
    ['借方发生额', '贷方发生额', '金额'], ['10', '0', '10'], ['0', '20', '20'],
    ['', '20', '20'], ['10', '20', '20'], ['-10', '0', '10'], ['0', '0', '0'], ['10', '0', '99']
  ] }] }]);
  const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit',
    groups: [2, 3, 4, 5, 6, 7, 8].map(id => [id]), ignored: [{ r: [1], kind: 'header' }], directionCodes: null,
    fields: { amount: { row: 0, col: 3 } } }], typeRules: [] };
  const rows = materializeTableMapping(mapping, registry).rows;
  assert.deepEqual(recoverPairedAmountDirections(rows, mapping, registry).map(x => [x.index, x.direction]), [[0, 'OUT'], [1, 'IN']]);
  rows[0].values[5] = 'IN';
  assert.deepEqual(recoverPairedAmountDirections(rows, mapping, registry).map(x => x.index), [1]);
  mapping.tables[0].accountKind = 'credit';
  assert.deepEqual(recoverPairedAmountDirections(rows, mapping, registry), []);
});

test('a line break immediately before a party separator preserves exact fragments and multiple accounts stay ambiguous', () => {
  for (const sep of ['\n/', '\r\n／', '\\n/']) {
    const cell = { id: 1, text: `测试公司${sep}001234567890`, page: 1, row: 1, column: 1 };
    assert.deepEqual(selectSourceParty(cell, 'name'), [{ id: 1, text: '测试公司' }]);
    assert.deepEqual(selectSourceParty(cell, 'account'), [{ id: 1, text: '001234567890' }]);
  }
  assert.equal(selectSourceParty({ id: 1, text: '测试公司/001234567890/009876543210', page: 1, row: 1, column: 1 }, 'account'), null);
});
