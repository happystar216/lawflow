import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceReviewIssues } from '../src/review/buildEvidenceReviewIssues';
import { BankAccount, StandardTransaction } from '../src/types/transaction';
import { chronologicalTransactions, balanceContinuityIssues } from '../src/utils/transactionSequence';
import { auditAccountBalance } from '../src/parsers/sanityChecker';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';

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

function makeTx(
  id: string,
  page: number,
  row: number,
  date: string,
  time: string,
  direction: 'IN' | 'OUT',
  amount: number,
  balance: number
): StandardTransaction {
  return {
    id,
    accountNumber: '62220201',
    accountName: '胡艳红',
    bankName: '中国光大银行',
    transactionDate: date,
    transactionTime: time,
    direction,
    amount,
    balance,
    counterpartyName: '对手方',
    summary: '测试摘要',
    rawSourceFile: '光大银行流水.pdf',
    rawPageNumber: page,
    rawRowIndex: row,
    balanceAvailable: true,
    extractionConfidence: 0.95,
    extractionMethod: 'DOCUMENT_PDF'
  };
}

test('chronologicalTransactions preserves physical order when OCR date typo would create false balance breaks', () => {
  // Page 3 physical rows in statement:
  // Row 6: 2023-09-21 06:48:17, IN 0.26, bal 0.84
  // Row 7: 2023-09-28 13:08:57, IN 11739.42, bal 11740.26 (0.84 + 11739.42 = 11740.26)
  // Row 8: 2023-09-27 21:30:27 (OCR misread from 2023-09-30), OUT 2640, bal 9100.26 (11740.26 - 2640 = 9100.26)
  // Row 9: 2023-09-30 21:43:51, OUT 9099.42, bal 0.84 (9100.26 - 9099.42 = 0.84)
  const row6 = makeTx('tx6', 3, 6, '2023-09-21', '06:48:17', 'IN', 0.26, 0.84);
  const row7 = makeTx('tx7', 3, 7, '2023-09-28', '13:08:57', 'IN', 11739.42, 11740.26);
  const row8 = makeTx('tx8', 3, 8, '2023-09-27', '21:30:27', 'OUT', 2640.00, 9100.26);
  const row9 = makeTx('tx9', 3, 9, '2023-09-30', '21:43:51', 'OUT', 9099.42, 0.84);

  const txs = [row6, row7, row8, row9];

  const ordered = chronologicalTransactions(txs);
  assert.deepEqual(ordered.map(t => t.id), ['tx6', 'tx7', 'tx8', 'tx9']);

  const issues = balanceContinuityIssues(txs);
  assert.equal(issues.length, 0, 'Should not report false balance discontinuity caused by OCR date misread');

  // Also verify evidence review issues does not report balance break or false discrete statement
  const testAcc: BankAccount = {
    accountNumber: '62220201',
    accountName: '胡艳红',
    bankName: '中国光大银行',
    ownerType: 'DEBTOR_MAIN',
    fileName: '光大银行流水.pdf',
    fileType: 'pdf',
    totalIn: 11739.68,
    totalOut: 11739.42,
    transactionCount: 4,
    startDate: '2023-09-21',
    endDate: '2023-09-30',
    startBalance: 0.58,
    endBalance: 0.84,
    isBalanced: true,
    balanceDiff: 0,
    balanceAvailable: true
  };
  const reviewIssues = buildEvidenceReviewIssues(testAcc, txs);
  assert.equal(reviewIssues.some(i => i.category === 'BALANCE_BREAK'), false);
});

test('auditAccountBalance calibrates startBalance when mistakenly populated with first transaction ending balance', () => {
  const loanTx = makeTx('tx1', 1, 1, '2023-05-31', '17:49:06', 'IN', 300000.00, 300000.00);
  const transferTx = makeTx('tx2', 1, 2, '2023-05-31', '18:00:00', 'OUT', 299999.16, 0.84);

  // Parser mistakenly initialized startBalance to 300,000.00 (the balance after loan disbursement)
  const acc: BankAccount = {
    accountNumber: '62220201',
    accountName: '胡艳红',
    bankName: '中国光大银行',
    ownerType: 'DEBTOR_MAIN',
    fileName: '光大银行流水.pdf',
    fileType: 'pdf',
    totalIn: 300000.00,
    totalOut: 299999.16,
    transactionCount: 2,
    startDate: '2023-05-31',
    endDate: '2023-05-31',
    startBalance: 300000.00,
    endBalance: 0.84,
    isBalanced: false,
    balanceDiff: 300000.00,
    balanceAvailable: true
  };

  const report = auditAccountBalance(acc, [loanTx, transferTx]);
  assert.equal(report.isAuditable, true);
  assert.equal(report.isBalanced, true, 'Audit should be balanced after calibrating opening balance');
  assert.equal(report.difference < 1, true);
  assert.equal(report.calculatedEndBalance.toFixed(2), '0.84');
});

test('normalizeRecognizedData correctly reconciles opening balance from loan disbursement transaction', () => {
  const loanTx = makeTx('tx1', 1, 1, '2023-05-31', '17:49:06', 'IN', 300000.00, 300000.00);
  const transferTx = makeTx('tx2', 1, 2, '2023-05-31', '18:00:00', 'OUT', 299999.16, 0.84);

  const rawAccount: BankAccount = {
    accountNumber: '62220201',
    accountName: '胡艳红',
    bankName: '中国光大银行',
    ownerType: 'DEBTOR_MAIN',
    fileName: '光大银行流水.pdf',
    fileType: 'pdf',
    totalIn: 300000.00,
    totalOut: 299999.16,
    transactionCount: 2,
    startDate: '2023-05-31',
    endDate: '2023-05-31',
    startBalance: 300000.00,
    endBalance: 0.84,
    isBalanced: false,
    balanceDiff: 300000.00,
    balanceAvailable: true
  };

  const normalized = normalizeRecognizedData([rawAccount], [loanTx, transferTx]);
  assert.equal(normalized.accounts.length, 1);
  assert.equal(normalized.accounts[0].startBalance, 0);
  assert.equal(normalized.accounts[0].endBalance, 0.84);
  assert.equal(normalized.accounts[0].isBalanced, true);
  assert.equal(normalized.accounts[0].balanceDiff < 1, true);
});

