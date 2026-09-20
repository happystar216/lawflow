import test from 'node:test';
import assert from 'node:assert/strict';
import { BankAccount, StandardTransaction } from '../src/types/transaction';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';
import { buildEvidenceReviewIssues } from '../src/review/buildEvidenceReviewIssues';

function transaction(id: string, page: number, accountNumber: string, bankName = '中国建设银行'): StandardTransaction {
  return {
    id, accountNumber, bankName, accountName: '胡艳红', transactionTime: '2024-01-01', transactionDate: '2024-01-01',
    direction: 'OUT', amount: 10, balance: 90, counterpartyName: '甲', summary: '', rawSourceFile: '流水.pdf',
    rawPageNumber: page, rawRowIndex: 1, extractionConfidence: 0.95
  };
}

function account(accountNumber: string, bankName: string, transactionCount = 1, warnings: string[] = []): BankAccount {
  return {
    accountNumber, bankName, accountName: '胡艳红', ownerType: 'DEBTOR_MAIN', fileName: '流水.pdf', fileType: 'pdf',
    totalIn: 0, totalOut: 10, transactionCount, startDate: '', endDate: '', startBalance: 100, endBalance: 90,
    isBalanced: true, balanceDiff: 0, parseWarnings: warnings
  };
}

test('normalizer merges the same full account despite different bank labels', () => {
  const result = normalizeRecognizedData(
    [account('6214663610258281', '中国建设银行'), account('6214663610258281', '建设银行股份有限公司')],
    [transaction('a', 1, '6214663610258281'), transaction('b', 2, '6214663610258281', '建设银行股份有限公司')]
  );
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].transactionCount, 2);
  assert.equal(result.accounts[0].bankName, '中国建设银行');
});

test('normalizer migrates a cached short account alias to the full listed account', () => {
  const fullNumber = '22255301100006216';
  const shortNumber = '255301100006216';
  const result = normalizeRecognizedData(
    [account(fullNumber, '四川农信', 0), account(shortNumber, '四川农信', 1)],
    [transaction('legacy-short', 3, shortNumber, '四川农信')]
  );
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].accountNumber, fullNumber);
  assert.equal(result.transactions[0].accountNumber, fullNumber);
});

test('normalizer repairs a page of one-off owner identifiers when adjacent pages agree', () => {
  const transactions = [
    transaction('before', 1, '6214663610258281'),
    transaction('bad-a', 2, '1010050361692410653421440'),
    { ...transaction('bad-b', 2, '1010050151692411896446025'), rawRowIndex: 2 },
    transaction('after', 3, '6214663610258281')
  ];
  const result = normalizeRecognizedData(transactions.map(item => account(item.accountNumber, item.bankName)), transactions);
  assert.deepEqual([...new Set(result.transactions.filter(item => item.rawPageNumber === 2).map(item => item.accountNumber))], ['6214663610258281']);
  assert.equal(result.accounts.length, 1);
});

test('normalizer attaches unscoped parser commentary to one real account instead of creating a fake account', () => {
  const warning = '页眉未明确标注银行名称，请结合原件核对';
  const result = normalizeRecognizedData(
    [account('6214663610258281', '中国建设银行', 1, [warning]), account('6225888570025456', '招商银行', 1, [warning])],
    [transaction('a', 1, '6214663610258281'), transaction('b', 2, '6225888570025456', '招商银行')]
  );
  assert.equal(result.accounts.some(item => item.ownerType === 'UNKNOWN'), false);
  const warnedAccounts = result.accounts.filter(item => item.parseWarnings?.includes(warning));
  assert.equal(warnedAccounts.length, 1);
  assert.equal(buildEvidenceReviewIssues(warnedAccounts[0], result.transactions).length, 1);
});

test('normalizer preserves a review account for a page warning with no matching transactions', () => {
  const warning = '第 9 页识别失败，请对照原件核对';
  const result = normalizeRecognizedData(
    [account('6214663610258281', '中国建设银行', 1, [warning])],
    [transaction('a', 1, '6214663610258281')]
  );
  const reviewAccount = result.accounts.find(item => item.ownerType === 'UNKNOWN');
  assert.deepEqual(reviewAccount?.parseWarnings, [warning]);
  assert.deepEqual(reviewAccount?.coveredPages, [9]);
});

test('normalizer migrates a cached file-level warning off a legacy review account', () => {
  const warning = 'Gemini 直传结果未经独立二次清点，所有识别交易均需律师对照原件复核';
  const legacyReviewAccount: BankAccount = {
    ...account('待归属页面-流水.pdf', '待核对', 0, [warning]),
    accountName: '待归属页面', ownerType: 'UNKNOWN'
  };
  const result = normalizeRecognizedData(
    [account('6214663610258281', '中国建设银行'), legacyReviewAccount],
    [transaction('a', 1, '6214663610258281')]
  );
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].accountNumber, '6214663610258281');
  assert.deepEqual(result.accounts[0].parseWarnings, ['智能识别结果未经独立二次清点，所有识别交易均需律师对照原件复核']);
  assert.equal(result.accounts[0].parseStatus, 'NEEDS_REVIEW');
});

test('normalizer auto-passes legacy Gemini rows that were blanket-marked pending without field issues', () => {
  const legacyTransaction: StandardTransaction = {
    ...transaction('legacy-gemini', 2, '6214663610258281'),
    extractionMethod: 'GEMINI_DIRECT_PDF', extractionConfidence: 0.75,
    reviewStatus: 'PENDING', dataQualityIssues: []
  };
  const result = normalizeRecognizedData(
    [account('6214663610258281', '中国建设银行')],
    [legacyTransaction]
  );
  assert.equal(result.transactions[0].extractionConfidence, 0.9);
  assert.equal(result.transactions[0].reviewStatus, 'AUTO_PASSED');
  assert.equal(buildEvidenceReviewIssues(result.accounts[0], result.transactions).some(issue => issue.category === 'LOW_CONFIDENCE'), false);
});

test('normalizer preserves a real zero-transaction account instead of replacing it with a review placeholder', () => {
  const emptyAccount = {
    ...account('6222000000000001', 'DEBTOR_MAIN', 0, ['原件各页均未识别到交易明细；请确认所选查询期间是否确无流水']),
    bankName: '测试银行',
    accountName: '张三',
    fileName: '无流水证明.pdf',
    transactionCount: 0,
    totalIn: 0,
    totalOut: 0
  };
  const result = normalizeRecognizedData([emptyAccount], []);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].accountNumber, '6222000000000001');
  assert.equal(result.accounts[0].accountName, '张三');
  assert.equal(result.accounts[0].transactionCount, 0);
  assert.equal(result.accounts[0].ownerType, 'DEBTOR_MAIN');
});

test('normalizer never merges two real accounts merely because their pages alternate', () => {
  const first = '2308014101100042218';
  const second = '2308417101003074088';
  const rows = [
    { ...transaction('a1', 29, first, '中国工商银行'), balance: 1000 },
    { ...transaction('b1', 33, second, '中国工商银行'), balance: 990 },
    { ...transaction('a2', 47, first, '中国工商银行'), balance: 980 },
    { ...transaction('b2', 51, second, '中国工商银行'), balance: 970 }
  ];
  const result = normalizeRecognizedData(
    [account(first, '中国工商银行', 2), account(second, '中国工商银行', 2)],
    rows
  );
  assert.deepEqual(new Set(result.transactions.map(item => item.accountNumber)), new Set([first, second]));
  assert.equal(result.accounts.length, 2);
});

test('normalizer merges a narrowly corroborated OCR account-number alias', () => {
  const canonical = '2308417101003074088';
  const damaged = '230841710103074088';
  const rows = [
    { ...transaction('a1', 33, canonical, '中国工商银行'), amount: 10, balance: 100 },
    { ...transaction('b1', 51, damaged, '中国工商银行'), amount: 10, balance: 90 },
    { ...transaction('a2', 53, canonical, '中国工商银行'), amount: 10, balance: 80 }
  ];
  const result = normalizeRecognizedData(
    [account(canonical, '中国工商银行', 2), account(damaged, '中国工商银行', 1)],
    rows
  );
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].accountNumber, canonical);
  assert.ok(result.transactions.every(item => item.accountNumber === canonical));
});

test('normalizer merges an OCR alias when duplicate rows corroborate it without a return transition', () => {
  const canonical = '2308417101003074088';
  const damaged = '230841710103074088';
  const rows = [
    { ...transaction('a1', 33, canonical, '中国工商银行'), transactionDate: '2023-05-21', amount: 10, balance: 100 },
    { ...transaction('a2', 33, canonical, '中国工商银行'), rawRowIndex: 2, transactionDate: '2023-06-21', amount: 20, balance: 80 },
    { ...transaction('b1', 51, damaged, '中国工商银行'), transactionDate: '2023-05-21', amount: 10, balance: 100 },
    { ...transaction('b2', 51, damaged, '中国工商银行'), rawRowIndex: 2, transactionDate: '2023-06-21', amount: 20, balance: 80 }
  ];
  const result = normalizeRecognizedData(
    [account(canonical, '中国工商银行', 2), account(damaged, '中国工商银行', 2)],
    rows
  );
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].accountNumber, canonical);
});

test('normalizer repairs an isolated impossible OCR year from the account period', () => {
  const number = '6230580000272593653';
  const dates = ['2023-12-21', '2024-03-21', '2024-06-21', '2024-09-21', '2029-12-21', '2025-03-21'];
  const rows = dates.map((date, index) => ({
    ...transaction(`d${index}`, index + 1, number, '平安银行'),
    transactionDate: date,
    transactionTime: date,
    rawRowIndex: index + 1
  }));
  const result = normalizeRecognizedData([account(number, '平安银行', rows.length)], rows);
  const repaired = result.transactions.find(item => item.id === 'd4');
  assert.equal(repaired?.transactionDate, '2024-12-21');
  assert.match(repaired?.correctionReason || '', /修正异常年份/);
});

test('normalizer rejects an owner-name-derived bank hallucination', () => {
  const number = '6223670100008876';
  const row = transaction('bank-name', 123, number, '胡艳红商业银行');
  const result = normalizeRecognizedData([account(number, '胡艳红商业银行')], [row]);
  assert.equal(result.accounts[0].bankName, '待核验银行');
});

test('normalizer trusts a short real bank name and repairs a known institution alias', () => {
  const pingAn = normalizeRecognizedData(
    [account('6230580000272593653', '平安银行')],
    [transaction('ping-an', 1, '6230580000272593653', '平安银行')]
  );
  assert.equal(pingAn.accounts[0].bankName, '平安银行');
  const mianyang = normalizeRecognizedData(
    [account('6223670100008876', '绵阳商业银行')],
    [transaction('mianyang', 123, '6223670100008876', '绵阳商业银行')]
  );
  assert.equal(mianyang.accounts[0].bankName, '绵阳市商业银行');
});

test('normalizer restores the printed raw date when a prior pass shifted the year', () => {
  const number = '6230580000272593653';
  const row = {
    ...transaction('raw-date', 97, number, '平安银行'),
    transactionDate: '2029-12-21',
    transactionTime: '2029-12-21',
    rawText: '户名 240101100859012 CNY 20251221 结息 BTCH PSWB0429 0 20260727'
  };
  const result = normalizeRecognizedData([account(number, '平安银行')], [row]);
  assert.equal(result.transactions[0].transactionDate, '2025-12-21');
  assert.match(result.transactions[0].correctionReason || '', /原始行印刷日期/);
});
