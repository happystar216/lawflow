import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQualitySources } from '../src/recognition/qualitySources';
import { runQualityTrial } from '../src/recognition/qualityTrialPipeline';
import type { TableMappingPlan } from '../src/recognition/tableMapping';
import type { IndependentPage } from '../src/recognition/independentComparison';

test('joined direction requires a located independent literal marker and keeps uncertain conflicts', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [['001234567890', '2026-01-01', '短信服务出', '20', '80']] }] }]);
  const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', groups: [[1]], ignored: [], directionCodes: null,
    fields: Object.fromEntries(['accountNumber', 'transactionDate', 'direction', 'amount', 'balance'].map((f, i) => [f, { row: 0, col: i + 1 }])) }], typeRules: [] };
  const page: IndependentPage = { pageType: 'transactions', coverage: 'complete', pageIssues: [], rows: [{ row: 1,
    values: ['001234567890', '2026-01-01', '', 'OUT', '20', '80', '', ''], rawDirection: '出', issues: [] }] };
  const run = (p: IndependentPage) => runQualityTrial(mapping, registry, { 1: p }, { singleIssuerDocument: false });
  const result = run(page);
  assert.equal(result.rows[0].values[5], 'OUT');
  assert.ok(result.transformations.some(t => t.basis === 'JOINED_PRINTED_DIRECTION_WITH_INDEPENDENT_MARKER'));
  assert.ok(!result.pending.some(i => i.field === 'direction'));
  const uncertain = structuredClone(page); uncertain.rows[0].issues.push({ field: 'direction', kind: 'uncertain', reason: 'faint' });
  assert.equal(run(uncertain).rows[0].values[5], '');
  const wrong = structuredClone(page); wrong.rows[0].rawDirection = '进'; wrong.rows[0].values[3] = 'IN';
  assert.equal(run(wrong).rows[0].values[5], '');
});

test('source catalog assigns every real row to exactly its input table', () => {
  const { source } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [['a'], ['b']] }, { rows: [['c']] }] }, { nearTableText: [], tables: [] }]);
  assert.deepEqual(source[0].tableCatalog, [{ table: 1, rowIds: [1, 2] }, { table: 2, rowIds: [3] }]);
  assert.deepEqual(source[1].tableCatalog, []);
});
