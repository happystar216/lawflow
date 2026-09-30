import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPrimaryRecovery } from '../src/recognition/primaryRecoverySelection';

const first = ['2026/07/10', '0.00', '10.00', '90.00'];
const second = ['2026/07/11', '0.00', '20.00', '70.00'];
const page = (rows: string[][]) => ({ nearTableText: [], tables: rows.map(row => ({ rows: [row] })) });
const independent = { pageType: 'transactions', coverage: 'complete', pageIssues: [], rows: [
  { row: 1, values: ['', '2026-07-10', '', 'OUT', '10', '90', '', ''], rawDirection: '', issues: [] },
  { row: 2, values: ['', '2026-07-11', '', 'OUT', '20', '70', '', ''], rawDirection: '', issues: [] }
] };

test('a reread losing a corroborated lower statement keeps the complete original', () => {
  const original = page([first, second]);
  const result = selectPrimaryRecovery(original, page([first]), independent);
  assert.equal(result.selected, original);
  assert.deepEqual(result.decision.lostIndependentRows, [2]);
});

test('a fuller independently supported reread replaces an incomplete transcript', () => {
  const fuller = page([first, second]);
  assert.equal(selectPrimaryRecovery(page([first]), fuller, independent).selected, fuller);
});

test('a reread cannot trade one corroborated transaction for a different one', () => {
  const original = page([first]);
  assert.equal(selectPrimaryRecovery(original, page([second]), independent).selected, original);
});

test('one numeric cell cannot corroborate both amount and balance; missing evidence is not a vote', () => {
  const observations = { ...independent, rows: [{ ...independent.rows[0], values: ['', '2026-07-10', '', 'OUT', '10', '10', '', ''] }] };
  const next = page([]);
  assert.equal(selectPrimaryRecovery(page([['2026/07/10', '10']]), next, observations).selected, next);
  assert.equal(selectPrimaryRecovery(page([first]), next, { ...independent, rows: [] }).selected, next);
});

test('ambiguous duplicate anchors cannot assert unique coverage', () => {
  const result = selectPrimaryRecovery(page([first, first]), page([]), independent);
  assert.equal(result.decision.corroboratedBefore, 0);
});
