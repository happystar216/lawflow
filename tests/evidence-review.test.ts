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

test('normalizeRecognizedData self-heals transaction amount when LLM extracts contract amount from summary instead of actual partial payment', () => {
  // Row 1 (2023-10-31): bal = 0.84
  const row1 = makeTx('tx1', 4, 1, '2023-10-31', '21:46:43', 'OUT', 9099.42, 0.84);
  // Row 2 (2023-11-30): actual withdrawal 0.84, bal 0.00. LLM extracted amount=2640.00 from summary '@2640.00@6@1@', but rawText has 0.84
  const row2 = {
    ...makeTx('tx2', 4, 2, '2023-11-30', '21:40:04', 'OUT', 2640.00, 0.00),
    summary: '5045237200078J001@胡艳红@2640.00@6@1@',
    rawText: '2023-11-30 21:40:04 OUT 0.84 5045237200078J001@胡艳红@2640.00@6@1@'
  };

  const rawAccount: BankAccount = {
    accountNumber: '62220201',
    accountName: '胡艳红',
    bankName: '中国光大银行',
    ownerType: 'DEBTOR_MAIN',
    fileName: '光大银行流水.pdf',
    fileType: 'pdf',
    totalIn: 0,
    totalOut: 2640.00,
    transactionCount: 2,
    startDate: '2023-10-31',
    endDate: '2023-11-30',
    startBalance: 0.84 + 9099.42,
    endBalance: 0.00,
    isBalanced: false,
    balanceDiff: 2639.16,
    balanceAvailable: true
  };

  const normalized = normalizeRecognizedData([rawAccount], [row1, row2]);
  const healedTx = normalized.transactions.find(t => t.id === 'tx2');
  assert.equal(healedTx?.amount, 0.84, 'Amount should be auto-healed to 0.84');
  assert.equal(normalized.accounts[0].isBalanced, true);
  assert.equal(normalized.accounts[0].balanceContinuityIssueCount, 0);
});

test('normalizeRecognizedData deduplicates identical transactions from multi-template court prints (e.g. Page 4 and Page 13) eliminating 10 false continuity alerts', () => {
  const accountBase: BankAccount = {
    accountNumber: '2308014101100042218',
    accountName: '被执行人',
    bankName: '中国工商银行',
    ownerType: 'DEBTOR_MAIN',
    fileName: '工行流水卷宗.pdf',
    fileType: 'pdf',
    totalIn: 0,
    totalOut: 0,
    transactionCount: 0,
    startDate: '2023-06-21',
    endDate: '2025-03-21',
    startBalance: 100.00,
    endBalance: 111.31,
    isBalanced: true,
    balanceDiff: 0,
    balanceAvailable: true
  };

  const p4Txs: StandardTransaction[] = [
    { ...makeTx('p4_10', 4, 1, '2025-03-21', '00:51:29', 'IN', 3.10, 111.31), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' },
    { ...makeTx('p4_9', 4, 2, '2024-12-21', '02:30:15', 'IN', 2.50, 108.21), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' },
    { ...makeTx('p4_8', 4, 3, '2024-06-21', '01:00:00', 'IN', 1.80, 105.71), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' },
    { ...makeTx('p4_7', 4, 4, '2024-03-21', '02:15:00', 'IN', 1.50, 103.91), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' },
    { ...makeTx('p4_6', 4, 5, '2023-12-21', '01:20:00', 'IN', 1.15, 102.41), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' },
    { ...makeTx('p4_5', 4, 6, '2023-09-30', '21:43:51', 'OUT', 40.00, 101.26), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '还贷-504523' },
    { ...makeTx('p4_4', 4, 7, '2023-09-28', '13:08:57', 'IN', 50.00, 141.26), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '网银跨行汇款' },
    { ...makeTx('p4_3', 4, 8, '2023-09-27', '21:30:27', 'OUT', 10.00, 91.26), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '转账' },
    { ...makeTx('p4_2', 4, 9, '2023-09-21', '06:48:17', 'IN', 0.26, 101.26), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '储蓄结息' },
    { ...makeTx('p4_1', 4, 10, '2023-06-21', '01:00:00', 'IN', 1.00, 101.00), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '储蓄结息' }
  ];

  // Page 13: The exact same 10 transactions reprinted in forward order
  const p13Txs: StandardTransaction[] = [
    { ...makeTx('p13_1', 13, 1, '2023-06-21', '01:00:00', 'IN', 1.00, 101.00), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '储蓄结息' },
    { ...makeTx('p13_2', 13, 2, '2023-09-21', '06:48:17', 'IN', 0.26, 101.26), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '储蓄结息' },
    { ...makeTx('p13_3', 13, 3, '2023-09-27', '21:30:27', 'OUT', 10.00, 91.26), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '转账' },
    { ...makeTx('p13_4', 13, 4, '2023-09-28', '13:08:57', 'IN', 50.00, 141.26), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '网银跨行汇款' },
    { ...makeTx('p13_5', 13, 5, '2023-09-30', '21:43:51', 'OUT', 40.00, 101.26), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '还贷-504523' },
    { ...makeTx('p13_6', 13, 6, '2023-12-21', '01:20:00', 'IN', 1.15, 102.41), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' },
    { ...makeTx('p13_7', 13, 7, '2024-03-21', '02:15:00', 'IN', 1.50, 103.91), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' },
    { ...makeTx('p13_8', 13, 8, '2024-06-21', '01:00:00', 'IN', 1.80, 105.71), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' },
    { ...makeTx('p13_9', 13, 9, '2024-12-21', '02:30:15', 'IN', 2.50, 108.21), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' },
    { ...makeTx('p13_10', 13, 10, '2025-03-21', '00:51:29', 'IN', 3.10, 111.31), accountNumber: accountBase.accountNumber, bankName: accountBase.bankName, summary: '利息 批量业务' }
  ];

  // Without deduplication: 20 transactions would trigger multiple balance breaks
  const rawContinuityIssues = balanceContinuityIssues([...p4Txs, ...p13Txs]);
  assert.ok(rawContinuityIssues.length >= 9, 'Without deduplication, duplicated pairs break continuity');

  // With normalizer deduplication:
  const normalized = normalizeRecognizedData([accountBase], [...p4Txs, ...p13Txs]);
  assert.equal(normalized.transactions.length, 10, 'Should deduplicate from 20 to 10 transactions');
  assert.equal(normalized.accounts[0].transactionCount, 10);
  assert.equal(normalized.accounts[0].balanceContinuityIssueCount, 0, 'Should have 0 continuity breaks');
  assert.equal(normalized.accounts[0].isBalanced, true, 'Account should be perfectly balanced');
  assert.deepEqual(normalized.accounts[0].coveredPages, [4, 13], 'Both Page 4 and Page 13 should be covered');

  // Review issues generated should have 0 balance breaks for Page 13
  const issues = buildEvidenceReviewIssues(normalized.accounts[0], normalized.transactions);
  const breakIssues = issues.filter(i => i.category === 'BALANCE_BREAK');
  assert.equal(breakIssues.length, 0, 'No balance break review issues should exist');
});

test('normalizeRecognizedData calibrates credit card installment conversion directions from balance math, resolving Page 21 breaks', () => {
  const account: BankAccount = {
    accountNumber: '6229100012131959',
    accountName: '胡艳红',
    bankName: '中国工商银行牡丹信用卡',
    ownerType: 'DEBTOR_MAIN',
    fileName: '工行流水卷宗.pdf',
    fileType: 'pdf',
    totalIn: 0,
    totalOut: 0,
    transactionCount: 0,
    startDate: '2023-08-20',
    endDate: '2023-08-29',
    startBalance: -8843.82,
    endBalance: -9902.92,
    isBalanced: true,
    balanceDiff: 0,
    balanceAvailable: true
  };

  const rawTxs: StandardTransaction[] = [
    { ...makeTx('c1', 21, 1, '2023-08-20', '2023-08-20', 'OUT', 49.90, -8893.72), accountNumber: account.accountNumber, bankName: account.bankName, summary: '财付通-素言帽社' },
    { ...makeTx('c2', 21, 2, '2023-08-20', '2023-08-20', 'OUT', 29.90, -8923.62), accountNumber: account.accountNumber, bankName: account.bankName, summary: '财付通-素言帽社' },
    { ...makeTx('c2_b', 21, 3, '2023-08-20', '2023-08-20', 'OUT', 7.00, -8930.62), accountNumber: account.accountNumber, bankName: account.bankName, summary: '财付通-素言帽社' },
    { ...makeTx('c3', 21, 4, '2023-08-22', '2023-08-22', 'OUT', 1417.23, -10347.85), accountNumber: account.accountNumber, bankName: account.bankName, summary: '财付通-深圳迪仕艾' },
    { ...makeTx('c4', 21, 5, '2023-08-29', '2023-08-29', 'OUT', 139.80, -10208.05), accountNumber: account.accountNumber, bankName: account.bankName, summary: '分行营业室 普通消费转分期' },
    { ...makeTx('c5', 21, 6, '2023-08-29', '2023-08-29', 'OUT', 46.60, -10254.65), accountNumber: account.accountNumber, bankName: account.bankName, summary: '分行营业室 消费' },
    { ...makeTx('c6', 21, 7, '2023-08-29', '2023-08-29', 'OUT', 0.84, -10255.49), accountNumber: account.accountNumber, bankName: account.bankName, summary: '分行营业室 费用' },
    { ...makeTx('c7', 21, 8, '2023-08-29', '2023-08-29', 'OUT', 352.57, -9902.92), accountNumber: account.accountNumber, bankName: account.bankName, summary: '分行营业室 普通消费转分期' }
  ];

  const rawIssues = balanceContinuityIssues(rawTxs);
  assert.ok(rawIssues.length >= 2, 'Uncalibrated directions cause balance continuity breaks');

  const normalized = normalizeRecognizedData([account], rawTxs);
  assert.equal(normalized.transactions.find(t => t.id === 'c4')?.direction, 'IN', 'c4 should be calibrated to IN');
  assert.equal(normalized.transactions.find(t => t.id === 'c7')?.direction, 'IN', 'c7 should be calibrated to IN');
  assert.equal(normalized.accounts[0].balanceContinuityIssueCount, 0, 'All breaks should be resolved');
});




