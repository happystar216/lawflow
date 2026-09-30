import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAccountCandidates } from '../src/recognition/accountCandidateSelection';
import { KEY_READER_COLUMNS, type IndependentPage } from '../src/recognition/independentComparison';
import { runQualityTrial } from '../src/recognition/qualityTrialPipeline';
import { qualityToWeb } from '../src/recognition/qualityWebAdapter';
import { buildQualitySources } from '../src/recognition/qualitySources';
import type { TableMappingPlan } from '../src/recognition/tableMapping';

function fixture() {
  const { registry } = buildQualitySources([{ nearTableText: ['001234567890'], tables: [{ rows: [
    ['2026-01-01', '支出', '10', '90', '账户转账', '测试公司', '009876543210']
  ] }] }]);
  const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', groups: [[1]], ignored: [], directionCodes: null,
    fields: { accountNumber: { fixed: 1 }, transactionDate: { row: 0, col: 1 }, direction: { row: 0, col: 2 },
      amount: { row: 0, col: 3 }, balance: { row: 0, col: 4 }, description: { row: 0, col: 5 },
      counterpartyName: { row: 0, col: 6 }, counterpartyAccount: { row: 0, col: 7 } } }], typeRules: [] };
  const values = ['001234567890', '', '', '', '2026-01-01', 'OUT', '10.00', '90.00', '账户转账', '测试公司', '009876543218', ''];
  const page: IndependentPage = { pageType: 'transactions', coverage: 'complete', pageIssues: [],
    rows: [{ row: 1, values: KEY_READER_COLUMNS.map(i => values[i]), rawDirection: '支出', issues: [] }] };
  return { registry, mapping, first: { 1: page }, fresh: { 1: structuredClone(page) } };
}

test('agreed alternate account is provisional: keep source, required conflict, page and both UI candidates', () => {
  const f = fixture(), original = JSON.stringify(f);
  const result = runQualityTrial(f.mapping, f.registry, f.first, { singleIssuerDocument: false }, {}, f.fresh);
  assert.equal(result.rows[0].values[10], '009876543218');
  assert.equal(result.observations[0].values[10], '009876543210');
  assert.equal(result.consolidation.events[0].values[10], '009876543210');
  assert.equal(result.accountCandidateSelections.length, 1);
  const issue = result.pending.find(i => i.field === 'counterpartyAccount')!;
  assert.equal(issue.severity, 'REQUIRED');
  assert.deepEqual(issue.outputRows, [1]);
  assert.deepEqual(issue.sourcePages, [1]);
  assert.match(issue.message, /仍需核对原件/);
  assert.equal(JSON.stringify(f), original);
  const web = qualityToWeb(result, f.registry, 'test.pdf', 1, f.mapping);
  assert.equal(web.transactions[0].fieldEvidence!.counterpartyAccount!.decision, 'UNRESOLVED');
  assert.deepEqual(web.transactions[0].candidateReview!.differences,
    [{ field: 'counterpartyAccount', selected: '009876543218', alternative: '009876543210' }]);
  assert.equal(web.accounts[0].parseStatus, 'NEEDS_REVIEW');
});

test('candidate selection refuses disagreement, uncertainty, masking, length changes, missing anchors and row ambiguity', () => {
  for (const problem of ['disagreement', 'uncertainty', 'mask', 'length', 'anchor', 'coverage', 'duplicates', 'no-alert']) {
    const f = fixture();
    const base = runQualityTrial(f.mapping, f.registry, f.first, { singleIssuerDocument: false });
    if (problem === 'disagreement') f.fresh[1].rows[0].values[7] = '009876543219';
    if (problem === 'uncertainty') f.fresh[1].rows[0].issues.push({ field: 'counterpartyAccount', kind: 'uncertain', reason: '模糊' });
    if (problem === 'mask') f.first[1].rows[0].values[7] = f.fresh[1].rows[0].values[7] = '0098****3218';
    if (problem === 'length') f.first[1].rows[0].values[7] = f.fresh[1].rows[0].values[7] = '0098765432181';
    if (problem === 'anchor') f.fresh[1].rows[0].values[5] = '80.00';
    if (problem === 'coverage') f.first[1].coverage = 'uncertain';
    if (problem === 'duplicates') f.first[1].rows.push(structuredClone(f.first[1].rows[0]));
    if (problem === 'no-alert') base.pending = [];
    assert.equal(selectAccountCandidates(base.rows, base.pending, f.registry, f.first, f.fresh).length, 0, problem);
  }
});
