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
  assert.deepEqual(result.accounts[0].parseWarnings, [warning]);
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
