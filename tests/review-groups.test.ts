import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewGroups, accountReviewLabel } from '../src/review/reviewGroups';
import type { BankAccount, StandardTransaction } from '../src/types/transaction';
import { buildEvidenceReviewIssues } from '../src/review/buildEvidenceReviewIssues';

const account = (number: string, document = 'doc-A'): BankAccount => ({
  accountNumber: number, accountName: '测试', bankName: '测试银行', fileName: '同名.pdf', sourceDocumentId: document,
  fileType: 'pdf', ownerType: 'DEBTOR_MAIN', totalIn: 0, totalOut: 0, transactionCount: 0,
  startDate: '', endDate: '', startBalance: 0, endBalance: 0, balanceDiff: 0, isBalanced: false
});
const row = (owner: BankAccount): StandardTransaction => ({
  id: `${owner.sourceDocumentId}:${owner.accountNumber}`, accountNumber: owner.accountNumber,
  bankName: owner.bankName, accountName: owner.accountName, rawSourceFile: owner.fileName, sourceDocumentId: owner.sourceDocumentId,
  rawPageNumber: 3, rawRowIndex: 1, transactionTime: '2024-01-01', transactionDate: '2024-01-01',
  direction: 'IN', amount: 1, balance: 1, counterpartyName: '', summary: '',
  candidateReview: { kind: 'FIELD_CONFLICT', status: 'PENDING', differences: [{ field: 'balance', selected: 1, alternative: 2 }] }
});

test('one printed page groups issues across accounts without crossing source-document boundaries', () => {
  const a = account('90000001');
  const b = account('90000002');
  const c = account('90000001', 'doc-B');
  const rows = [row(a), row(b), row(c)];
  const groups = buildReviewGroups([a, b, c], rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].issues.flatMap(issue => issue.transactionIds).sort(), rows.slice(0, 2).map(row => row.id).sort());
  assert.deepEqual(groups[1].issues.flatMap(issue => issue.transactionIds), [rows[2].id]);
});

test('system checks, empty account metadata and bank uncertainty never impersonate human confirmation', () => {
  const a = account('90000001');
  assert.equal(accountReviewLabel(a, []), '仅账户资料，未提供流水');
  const normal = { ...row(a), candidateReview: undefined, reviewStatus: 'AUTO_PASSED' as const };
  assert.equal(accountReviewLabel(a, [normal]), '系统检查通过，未人工核对');
  const confirmed = { ...normal, reviewStatus: 'VERIFIED' as const, reviewedBy: '律师人工核对', reviewedAt: '2026-01-01' };
  assert.equal(accountReviewLabel(a, [confirmed]), '流水已人工核对');
  assert.equal(accountReviewLabel({ ...a, bankName: '待核验银行' }, [confirmed]), '银行名称待确认');
  assert.notEqual(accountReviewLabel(a, [{ ...confirmed, reviewedAt: undefined }]), '流水已人工核对');
  assert.notEqual(accountReviewLabel(a, [{ ...confirmed, candidateReview: row(a).candidateReview }]), '流水已人工核对');
});

test('missing bank-name evidence is not misclassified as missing transaction rows', () => {
  const owner = { ...account('90000001'), parseWarnings: ['第 3 页银行名称缺少可定位的原文依据，暂显示“待核验银行”'] };
  const issues = buildEvidenceReviewIssues(owner, []);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'ADVISORY');
  assert.equal(issues[0].category, 'DATA_WARNING');
});

test('explicit count disagreement remains required even without a generic missing-row keyword', () => {
  const owner = { ...account('90000001'), parseWarnings: ['第 3 页页面计数为 1 笔，逐笔提取为 2 笔'] };
  const issues = buildEvidenceReviewIssues(owner, []);
  assert.equal(issues[0].severity, 'REQUIRED');
  assert.equal(issues[0].category, 'PAGE_INTEGRITY');
});
