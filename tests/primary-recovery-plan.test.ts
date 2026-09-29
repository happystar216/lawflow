import test from 'node:test';
import assert from 'node:assert/strict';
import { planPrimaryRecovery } from '../src/recognition/primaryRecoveryPlan';
import type { AssemblyIssue } from '../src/recognition/sourceAssembly';
test('structural gaps select only affected full pages, while ordinary field disagreements stay in field review', () => {
  const registry = { pages: [1, 2], cells: {}, rows: { 1: { id: 1, page: 1, table: 1, row: 1, cells: [] },
    2: { id: 2, page: 2, table: 1, row: 1, cells: [] } } };
  const issues: AssemblyIssue[] = [{ id: 'a', code: 'INDEPENDENT_EXTRA_OBSERVATION', field: null, outputRows: [],
    sourceRows: [2], sourceCells: [], severity: 'REQUIRED', message: 'coverage gap' },
    { id: 'b', code: 'INDEPENDENT_VALUE_CONFLICT', field: 'amount', outputRows: [1], sourceRows: [1], sourceCells: [], severity: 'REQUIRED', message: 'amount differs' }];
  assert.deepEqual(planPrimaryRecovery(issues, registry).selected.map(p => p.page), [2]);
  assert.equal(planPrimaryRecovery(issues, registry, 0).deferred.length, 1);
  issues[0].sourceRows = []; issues[0].sourcePages = [2];
  assert.deepEqual(planPrimaryRecovery(issues, registry).selected.map(p => p.page), [2], 'entirely missed page has no source row IDs');
});

test('bounded recovery prioritizes disputed transactions over earlier unreadable document pages', () => {
  const issues: AssemblyIssue[] = Array.from({ length: 8 }, (_, index) => ({ id: String(index),
    code: index === 7 ? 'INDEPENDENT_ROW_UNMATCHED' : 'INDEPENDENT_PAGE_INCOMPLETE', field: null,
    outputRows: index === 7 ? [1, 2, 3] : [], sourcePages: [index + 1], sourceRows: [], sourceCells: [],
    severity: 'REQUIRED', message: 'synthetic coverage issue' }));
  const plan = planPrimaryRecovery(issues, { pages: Array.from({ length: 8 }, (_, i) => i + 1), cells: {}, rows: {} });
  assert.equal(plan.selected[0].page, 8);
  assert.equal(plan.selected.length, 6);
  assert.equal(plan.deferred.length, 2);
});
