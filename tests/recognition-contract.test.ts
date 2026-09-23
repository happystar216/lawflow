import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeQwenChunkResults, type QwenChunkResult } from '../src/parsers/qwenResultMerger';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';
import { preserveExtraction } from '../src/recognition/decisionPolicy';
import { selectPageCandidate } from '../src/recognition/pageCandidates';
import type { StandardTransaction, BankAccount } from '../src/types/transaction';
import { buildEvidenceReviewIssues } from '../src/review/buildEvidenceReviewIssues';
import { applyRowReviewDecision } from '../src/review/fieldReview';

// Synthetic, source-independent acceptance fixtures. No real case data is committed.
function row(page: number, accountNumber: string, bankName = '待核验银行', file = 'A.pdf'): StandardTransaction {
  return {
    id: `${file}:${page}:${accountNumber}`, accountNumber, accountName: '测试户名', bankName,
    transactionTime: `2024-01-${String(page).padStart(2, '0')}`, transactionDate: `2024-01-${String(page).padStart(2, '0')}`,
    direction: 'IN', amount: 10, balance: 100, balanceAvailable: true, summary: '结息', counterpartyName: '',
    rawSourceFile: file, rawPageNumber: page, rawRowIndex: 1, extractionConfidence: 0.99
  };
}
function chunk(transaction: StandardTransaction, totalPages = 2): QwenChunkResult {
  const page = transaction.rawPageNumber!;
  const account: BankAccount = {
    accountNumber: transaction.accountNumber, accountName: transaction.accountName, bankName: transaction.bankName,
    fileName: transaction.rawSourceFile, fileType: 'pdf', ownerType: 'DEBTOR_MAIN',
    totalIn: 10, totalOut: 0, transactionCount: 1, startDate: '', endDate: '',
    startBalance: 90, endBalance: 100, balanceDiff: 0, isBalanced: true
  };
  return { account, accounts: [account], transactions: [transaction], coveredPages: [page],
    pageStart: page, pageEnd: page, totalPages, countComplete: true };
}

test('unknown bank never causes an explicit account to inherit a preceding bank account', () => {
  const a = chunk(row(1, '90000001', '甲银行'));
  const b = chunk(row(2, '90000002'));
  const merged = mergeQwenChunkResults([a, b], 'A.pdf', 2);
  assert.equal(merged.transactions[1].accountNumber, '90000002');
  assert.equal(merged.transactions[1].bankName, '待核验银行');
});

test('a source-protected missing account stays unresolved across bank boundaries', () => {
  const a = chunk(preserveExtraction(row(1, '90000001', '甲银行')));
  const b = chunk(preserveExtraction(row(2, '待核验账号-第2页')));
  // A chunk-level identity is not explicit printed evidence.
  b.account = { ...a.account };
  b.accounts = [b.account];
  const merged = mergeQwenChunkResults([a, b], 'A.pdf', 2);
  assert.equal(merged.transactions[1].accountNumber, '待核验账号-第2页');
});

test('identical page numbers from different source files never share identities', () => {
  const a = row(1, '90000001', '甲银行');
  const b = row(1, '待核验账号-第1页', '待核验银行', 'B.pdf');
  const result = normalizeRecognizedData([chunk(a).account, chunk(b).account], [a, b]);
  assert.equal(result.transactions.find(t => t.rawSourceFile === 'B.pdf')?.accountNumber, b.accountNumber);
});

test('protected observations survive normalization and save/load without guessed financial edits', () => {
  const a = preserveExtraction(row(1, '90000001'));
  const b = preserveExtraction({ ...row(2, '90000001'), amount: 1, balance: 120 });
  const input = [a, b];
  const before = structuredClone(input);
  const result = normalizeRecognizedData([chunk(a).account], input);
  const reopened = JSON.parse(JSON.stringify(result));
  const again = normalizeRecognizedData(reopened.accounts, reopened.transactions);
  assert.deepEqual(input, before, 'normalization must not mutate the extraction snapshot');
  assert.deepEqual(again.transactions, result.transactions);
  assert.equal(again.transactions.find(t => t.id === b.id)?.amount, 1);
  assert.equal(again.transactions.find(t => t.id === b.id)?.direction, 'IN');
  assert.equal(again.accounts[0].isBalanced, false);
});

test('equal candidate counts do not resolve contradictory values', () => {
  const a = chunk(row(1, '90000001'), 1);
  const b = structuredClone(a);
  b.transactions[0].amount = 12;
  const result = selectPageCandidate(a, b, 1);
  assert.equal(result.countComplete, true, 'row completeness is independent of field correctness');
  assert.equal(result.transactions[0].reviewStatus, 'PENDING');
  assert.equal(a.transactions[0].amount, 10);
});

test('lawyer edits survive reload while original extraction evidence remains intact', () => {
  const extracted = preserveExtraction(row(1, '90000001'));
  const edited = {
    ...extracted, amount: 15, reviewStatus: 'VERIFIED' as const, reviewedBy: '律师人工核对',
    fieldEvidence: { ...extracted.fieldEvidence, amount: {
      originalValue: 10, currentValue: 15, origin: 'LAWYER_REVIEW' as const, decision: 'CONFIRMED' as const
    } }
  };
  const result = normalizeRecognizedData([chunk(edited).account], [edited]);
  assert.equal(result.transactions[0].amount, 15);
  assert.equal(result.transactions[0].fieldEvidence?.amount?.originalValue, 10);
  assert.equal(result.transactions[0].fieldEvidence?.amount?.origin, 'LAWYER_REVIEW');
});

test('recovery with an inserted middle row selects a whole candidate without offset splicing', () => {
  const a = chunk(row(1, '90000001'), 1);
  a.transactions.push({ ...row(3, '90000001'), rawPageNumber: 1, rawRowIndex: 2 });
  const b = structuredClone(a);
  b.transactions.splice(1, 0, { ...row(2, '90000001'), rawPageNumber: 1, rawRowIndex: 2 });
  b.transactions[2].rawRowIndex = 3;
  const result = selectPageCandidate(a, b, 1, true);
  assert.deepEqual(result.transactions.map(t => t.transactionDate), ['2024-01-01', '2024-01-02', '2024-01-03']);
  assert.equal(result.countComplete, false);
  assert.equal(result.transactions[0].candidateReview, undefined);
  assert.equal(result.transactions[1].candidateReview?.kind, 'UNMATCHED_ROW');
  assert.equal(result.transactions[2].candidateReview, undefined);
});

test('candidate comparison exposes only actual differing fields without suppressing extraction doubts', () => {
  const a = chunk(row(1, '90000001'), 1);
  a.transactions.push({ ...row(2, '90000001'), rawPageNumber: 1, rawRowIndex: 2 });
  const b = structuredClone(a);
  b.transactions[0].balance = 103;
  const selected = selectPageCandidate(a, b, 1);
  assert.deepEqual(selected.transactions[0].candidateReview?.differences, [{ field: 'balance', selected: 100, alternative: 103 }]);
  assert.equal(selected.transactions[1].candidateReview, undefined);
  const issues = buildEvidenceReviewIssues(a.account, selected.transactions);
  assert.equal(issues.find(issue => issue.category === 'CANDIDATE_CONFLICT')?.transactionIds.length, 1);
  assert.match(issues.find(issue => issue.category === 'CANDIDATE_CONFLICT')?.description || '', /100.*103/);
});

test('ambiguous same-day transactions never get paired by offset or equal amount', () => {
  const a = chunk(row(1, '90000001'), 1);
  a.transactions.push({ ...a.transactions[0], id: 'second', rawRowIndex: 2, amount: 20 });
  const b = structuredClone(a);
  b.transactions.reverse();
  const selected = selectPageCandidate(a, b, 1);
  assert.ok(selected.transactions.every(row => row.candidateReview?.kind === 'AMBIGUOUS_ROW'));
  assert.deepEqual(selected.transactions.map(row => row.amount), [10, 20]);
});

test('counterparty name differences are included even when all financial fields agree', () => {
  const a = chunk(row(1, '90000001'), 1);
  const b = structuredClone(a);
  b.transactions[0].counterpartyName = '另一名称';
  assert.equal(selectPageCandidate(a, b, 1).transactions[0].candidateReview?.differences[0].field, 'counterpartyName');
});

test('protected zero settlement cannot erase a candidate conflict or an unreadable amount', () => {
  const first = preserveExtraction(row(1, '90000001'));
  const zero = preserveExtraction({ ...row(2, '90000001'), amount: 0, reviewStatus: 'PENDING',
    dataQualityIssues: ['INVALID_AMOUNT'], candidateReview: { kind: 'UNMATCHED_ROW', differences: [], status: 'PENDING' } });
  const normalized = normalizeRecognizedData([chunk(first).account], [first, zero]);
  const retained = normalized.transactions.find(row => row.id === zero.id)!;
  assert.equal(retained.reviewStatus, 'PENDING');
  assert.deepEqual(retained.dataQualityIssues, ['INVALID_AMOUNT']);
  const issues = buildEvidenceReviewIssues(normalized.accounts[0], normalized.transactions);
  assert.ok(issues.some(issue => issue.category === 'INVALID_AMOUNT'));
  assert.ok(issues.some(issue => issue.category === 'CANDIDATE_CONFLICT'));
  const partial = applyRowReviewDecision(retained, ['amount'], 'ACCEPT_CURRENT');
  assert.equal(partial.candidateReview?.status, 'PENDING');
  assert.equal(partial.reviewStatus, 'PENDING');
  const confirmed = applyRowReviewDecision(retained, ['accountNumber', 'amount', 'balance', 'transactionTime', 'direction', 'counterpartyName', 'counterpartyAccount', 'summary'], 'ACCEPT_CURRENT');
  assert.equal(confirmed.amount, 0);
  assert.deepEqual(confirmed.dataQualityIssues, []);
  assert.equal(confirmed.candidateReview?.status, 'CONFIRMED');
  const reopened = normalizeRecognizedData(normalized.accounts, [first, confirmed]);
  assert.equal(reopened.transactions.find(row => row.id === zero.id)?.candidateReview?.status, 'CONFIRMED');
});
