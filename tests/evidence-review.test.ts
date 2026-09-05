import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceReviewIssues } from '../src/review/buildEvidenceReviewIssues';
import { BankAccount, StandardTransaction } from '../src/types/transaction';

const account: BankAccount = {
  accountNumber: '62220001', accountName: '张三', bankName: '测试银行', ownerType: 'DEBTOR_MAIN',
  fileName: '流水.pdf', fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 2,
  startDate: '2024-01-01', endDate: '2024-01-01', startBalance: 1000, endBalance: 999,
  isBalanced: false, balanceDiff: 1, balanceAvailable: true,
  parseWarnings: ['第 61 页页面汇总为 44 笔，自动复核后最多识别 43 笔；律师需对照原件补充核验']
};

const transactions: StandardTransaction[] = [
  {
    id: 'a', accountNumber: account.accountNumber, accountName: account.accountName, bankName: account.bankName,
    transactionTime: '2024-01-01', transactionDate: '2024-01-01', direction: 'OUT', amount: 100, balance: 900,
    counterpartyName: '甲', summary: '', rawSourceFile: account.fileName, rawPageNumber: 61, rawRowIndex: 1,
    balanceAvailable: true, extractionConfidence: 0.7
  },
  {
    id: 'b', accountNumber: account.accountNumber, accountName: account.accountName, bankName: account.bankName,
    transactionTime: '2024-01-01', transactionDate: '2024-01-01', direction: 'IN', amount: 50, balance: 999,
    counterpartyName: '乙', summary: '', rawSourceFile: account.fileName, rawPageNumber: 61, rawRowIndex: 2,
    balanceAvailable: true, extractionConfidence: 0.95
  }
];

test('builds clickable page, confidence and balance review tasks', () => {
  const issues = buildEvidenceReviewIssues(account, transactions);
  assert.ok(issues.some(issue => issue.category === 'PAGE_INTEGRITY' && issue.pageNumber === 61));
  assert.ok(issues.some(issue => /两次计数不一致/.test(issue.title) && /均尚未经过律师确认/.test(issue.description)));
  assert.ok(issues.some(issue => issue.category === 'LOW_CONFIDENCE' && issue.transactionIds.includes('a')));
  assert.ok(issues.some(issue => issue.category === 'BALANCE_BREAK' && issue.transactionIds.includes('b')));
  assert.ok(issues.every(issue => issue.instructions.length > 0));
});

test('preserves a lawyer resolution when the task list is regenerated', () => {
  const first = buildEvidenceReviewIssues(account, transactions);
  const resolved = { ...first[0], status: 'CONFIRMED' as const, resolutionNote: '已核对原件' };
  const rebuilt = buildEvidenceReviewIssues({ ...account, reviewIssues: [resolved] }, transactions);
  assert.equal(rebuilt.find(issue => issue.id === resolved.id)?.status, 'CONFIRMED');
  assert.equal(rebuilt.find(issue => issue.id === resolved.id)?.resolutionNote, '已核对原件');
});

test('infers the page for an old count warning when exactly one page has the extracted count', () => {
  const oldAccount: BankAccount = {
    ...account,
    parseWarnings: ['页面汇总为 9 笔，但逐笔明细仅有 11 笔，结果可能不完整']
  };
  const pageTransactions = Array.from({ length: 11 }, (_, index): StandardTransaction => ({
    ...transactions[0],
    id: `page-7-${index + 1}`,
    rawPageNumber: 7,
    rawRowIndex: index + 1
  }));
  const issue = buildEvidenceReviewIssues(oldAccount, pageTransactions)
    .find(item => item.category === 'PAGE_INTEGRITY');

  assert.equal(issue?.pageNumber, 7);
  assert.equal(issue?.transactionIds.length, 11);
  assert.match(issue?.title || '', /第 7 页两次计数不一致（9 \/ 11）/);
});

test('keeps invalid rows visible and creates date, amount and direction review tasks', () => {
  const invalid: StandardTransaction = {
    ...transactions[0], id: 'invalid', transactionTime: '', transactionDate: '', direction: 'UNKNOWN', amount: 0,
    dataQualityIssues: ['INVALID_DATE', 'INVALID_AMOUNT', 'UNKNOWN_DIRECTION'], reviewStatus: 'PENDING'
  };
  const issues = buildEvidenceReviewIssues({ ...account, parseWarnings: [] }, [invalid]);

  assert.ok(issues.some(issue => issue.category === 'INVALID_DATE' && issue.transactionIds.includes('invalid')));
  assert.ok(issues.some(issue => issue.category === 'INVALID_AMOUNT' && issue.transactionIds.includes('invalid')));
  assert.ok(issues.some(issue => issue.category === 'INVALID_DIRECTION' && issue.transactionIds.includes('invalid')));
});
