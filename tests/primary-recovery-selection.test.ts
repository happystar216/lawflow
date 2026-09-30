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

test('a stable complete grid can retain one original supported row without discarding the rest of the reread', () => {
  const header = ['日期', '借方', '贷方', '余额'];
  const raw = [first, second, ['2026/07/12', '0', '30', '40'], ['2026/07/13', '0', '10', '30']];
  const original = { nearTableText: ['old header'], tables: [{ rows: [header, ...raw] }] };
  const reading = { ...independent, rows: raw.map((r, i) => ({ row: i + 1,
    values: ['', r[0].replaceAll('/', '-'), '', 'OUT', r[2], r[3], '', ''], rawDirection: '', issues: [] })) };
  const fresh = structuredClone(original); fresh.nearTableText = ['new header']; fresh.tables[0].rows[1][2] = '11.00';
  const before = JSON.stringify([original, fresh]);
  const result = selectPrimaryRecovery(original, fresh, reading);
  assert.notEqual(result.selected, original);
  assert.deepEqual(result.selected.nearTableText, ['new header']);
  assert.deepEqual(result.selected.tables[0].rows[1], first);
  assert.equal(result.decision.corroboratedSelected, 4);
  assert.deepEqual(result.decision.retainedSourceRows, [{ table: 1, row: 2, independentRow: 1 }]);
  assert.equal(JSON.stringify([original, fresh]), before);
  for (const problem of ['date', 'balance', 'header', 'count', 'uncertainty', 'reorder']) {
    const altered = structuredClone(fresh), alternate = structuredClone(reading);
    if (problem === 'date') altered.tables[0].rows[1][0] = '2026/08/10';
    if (problem === 'balance') altered.tables[0].rows[1][3] = '80';
    if (problem === 'header') altered.tables[0].rows[0][1] = '其他';
    if (problem === 'count') altered.tables[0].rows.pop();
    if (problem === 'uncertainty') alternate.coverage = 'uncertain';
    if (problem === 'reorder') [altered.tables[0].rows[2], altered.tables[0].rows[3]] = [altered.tables[0].rows[3], altered.tables[0].rows[2]];
    assert.equal(selectPrimaryRecovery(original, altered, alternate).selected, original, problem);
  }
});
