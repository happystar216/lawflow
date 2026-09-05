import test from 'node:test';
import assert from 'node:assert/strict';
import { QwenChunkResult, mergeQwenChunkResults } from '../src/parsers/qwenResultMerger';
import { BankAccount, StandardTransaction } from '../src/types/transaction';

const account = (): BankAccount => ({
  accountNumber: '62220001', accountName: '张三', bankName: '测试银行', ownerType: 'DEBTOR_MAIN',
  fileName: '流水.pdf', fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0,
  startDate: '', endDate: '', startBalance: 1000, endBalance: 1000,
  isBalanced: false, balanceDiff: 0, balanceAvailable: true
});

const transaction = (
  id: string, page: number, row: number, direction: 'IN' | 'OUT', amount: number, balance: number
): StandardTransaction => ({
  id, accountNumber: '62220001', accountName: '张三', bankName: '测试银行',
  transactionTime: `2024-01-0${page}`, transactionDate: `2024-01-0${page}`,
  direction, amount, balance, counterpartyName: '测试对手方', summary: '',
  rawSourceFile: '流水.pdf', rawPageNumber: page, rawRowIndex: row,
  balanceAvailable: true, extractionConfidence: 0.9, extractionMethod: 'DOCUMENT_PDF'
});

const chunk = (pageStart: number, pageEnd: number, transactions: StandardTransaction[]): QwenChunkResult => ({
  account: account(), transactions, warnings: [],
  coveredPages: Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart + index),
  pageStart, pageEnd, totalPages: 2
});

test('Qwen chunk merge restores source order, deduplicates locators and reconciles balances', () => {
  const first = transaction('a', 1, 1, 'OUT', 100, 900);
  const duplicate = { ...first, id: 'duplicate', extractionConfidence: 0.7 };
  const second = transaction('b', 2, 1, 'IN', 50, 950);
  const merged = mergeQwenChunkResults([
    chunk(2, 2, [second]),
    chunk(1, 1, [first, duplicate])
  ], '原始流水.pdf', 2);

  assert.equal(merged.transactions.length, 2);
  assert.equal(merged.accounts.length, 1);
  assert.deepEqual(merged.transactions.map(item => item.rawPageNumber), [1, 2]);
  assert.equal(merged.account.startBalance, 1000);
  assert.equal(merged.account.endBalance, 950);
  assert.equal(merged.account.isBalanced, true);
  assert.equal(merged.account.parseStatus, 'COMPLETE');
});

test('Qwen chunk merge separates multiple banks in one PDF into account tabs', () => {
  const bankOne = transaction('a', 1, 1, 'OUT', 100, 900);
  const bankTwo = {
    ...transaction('b', 2, 1, 'IN', 200, 1200),
    bankName: '另一银行',
    accountNumber: '95588002'
  };
  const secondChunk = chunk(2, 2, [bankTwo]);
  secondChunk.account = { ...account(), bankName: bankTwo.bankName, accountNumber: bankTwo.accountNumber };
  const merged = mergeQwenChunkResults([chunk(1, 1, [bankOne]), secondChunk], '多银行流水.pdf', 2);

  assert.equal(merged.accounts.length, 2);
  assert.deepEqual(merged.accounts.map(item => item.bankName), ['测试银行', '另一银行']);
  assert.deepEqual(merged.accounts.map(item => item.transactionCount), [1, 1]);
  assert.equal(merged.accounts.every(item => item.balanceContinuityIssueCount === 0), true);
});

test('Qwen chunk merge inherits the surrounding owner account for a headerless continuation page', () => {
  const first = transaction('a', 1, 1, 'OUT', 100, 900);
  const continuation = {
    ...transaction('b', 2, 1, 'IN', 50, 950),
    bankName: '待核验银行',
    accountNumber: '待核验-流水'
  };
  const last = transaction('c', 3, 1, 'OUT', 20, 930);
  const thirdChunk = chunk(3, 3, [last]);
  thirdChunk.totalPages = 3;
  const secondChunk = chunk(2, 2, [continuation]);
  secondChunk.totalPages = 3;
  const firstChunk = chunk(1, 1, [first]);
  firstChunk.totalPages = 3;
  const merged = mergeQwenChunkResults([firstChunk, secondChunk, thirdChunk], '续表流水.pdf', 3);

  assert.equal(merged.accounts.length, 1);
  assert.equal(merged.transactions.find(item => item.rawPageNumber === 2)?.accountNumber, first.accountNumber);
});

test('Qwen chunk merge rejects any missing original page', () => {
  assert.throws(
    () => mergeQwenChunkResults([chunk(1, 1, [transaction('a', 1, 1, 'OUT', 100, 900)])], '流水.pdf', 2),
    /缺少第 2 页/
  );
});

test('Qwen chunk merge flags row-level balance discontinuity for lawyer review', () => {
  const first = transaction('a', 1, 1, 'OUT', 100, 900);
  const broken = transaction('b', 2, 1, 'IN', 50, 999);
  const merged = mergeQwenChunkResults([chunk(1, 1, [first]), chunk(2, 2, [broken])], '流水.pdf', 2);
  assert.equal(merged.account.parseStatus, 'NEEDS_REVIEW');
  assert.equal(merged.account.balanceContinuityIssueCount, 1);
  assert.equal(merged.account.parseWarnings?.length || 0, 0);
});

test('Qwen chunk merge marks an incomplete-page warning for lawyer review without rejecting the file', () => {
  const warned = chunk(1, 1, [transaction('a', 1, 1, 'OUT', 100, 900)]);
  warned.totalPages = 1;
  warned.warnings = ['第 1 页页面汇总为 2 笔，自动复核后最多识别 1 笔；律师需对照原件补充核验'];
  const merged = mergeQwenChunkResults([warned], '流水.pdf', 1);
  assert.equal(merged.transactions.length, 1);
  assert.equal(merged.account.parseStatus, 'NEEDS_REVIEW');
  assert.match(merged.account.parseWarnings?.[0] || '', /补充核验/);
});

test('Qwen chunk merge detects reverse-chronological statements before reconciling balances', () => {
  const latest = { ...transaction('latest', 1, 1, 'IN', 50, 950), transactionTime: '2024-01-02', transactionDate: '2024-01-02' };
  const earliest = { ...transaction('earliest', 2, 1, 'OUT', 100, 900), transactionTime: '2024-01-01', transactionDate: '2024-01-01' };
  const merged = mergeQwenChunkResults([chunk(1, 1, [latest]), chunk(2, 2, [earliest])], '倒序流水.pdf', 2);

  assert.equal(merged.account.startBalance, 1000);
  assert.equal(merged.account.endBalance, 950);
  assert.equal(merged.account.isBalanced, true);
  assert.equal(merged.account.balanceContinuityIssueCount, 0);
});

test('Qwen chunk merge normalizes spaces and separators in owner account identity', () => {
  const formatted = { ...transaction('formatted', 1, 1, 'OUT', 100, 900), bankName: '测试 银行', accountNumber: '6222-0001' };
  const plain = transaction('plain', 2, 1, 'IN', 50, 950);
  const merged = mergeQwenChunkResults([chunk(1, 1, [formatted]), chunk(2, 2, [plain])], '账号格式.pdf', 2);

  assert.equal(merged.accounts.length, 1);
  assert.equal(merged.account.transactionCount, 2);
});

test('Qwen chunk merge exposes failed pages as an unassigned review account', () => {
  const failed = chunk(2, 2, []);
  failed.warnings = ['第 2 页连续识别失败：页面无法读取；已继续处理后续页面'];
  const merged = mergeQwenChunkResults([chunk(1, 1, [transaction('a', 1, 1, 'OUT', 100, 900)]), failed], '含失败页.pdf', 2);

  assert.equal(merged.accounts.length, 2);
  assert.equal(merged.accounts[1].ownerType, 'UNKNOWN');
  assert.deepEqual(merged.accounts[1].coveredPages, [2]);
  assert.match(merged.accounts[1].parseWarnings?.[0] || '', /第 2 页/);
});

test('Qwen chunk merge keeps an all-failed document reviewable instead of aborting', () => {
  const failed = chunk(1, 1, []);
  failed.totalPages = 1;
  failed.warnings = ['第 1 页连续识别失败：原件不清晰；已继续处理后续页面'];
  const merged = mergeQwenChunkResults([failed], '全失败.pdf', 1);

  assert.equal(merged.transactions.length, 0);
  assert.equal(merged.accounts.length, 1);
  assert.equal(merged.account.parseStatus, 'NEEDS_REVIEW');
  assert.deepEqual(merged.account.coveredPages, [1]);
});

test('Qwen chunk merge corrects a page whose debit and credit directions are consistently reversed', () => {
  const rows = [
    transaction('a', 1, 1, 'IN', 100, 900),
    transaction('b', 1, 2, 'OUT', 50, 950),
    transaction('c', 1, 3, 'IN', 20, 930),
    transaction('d', 1, 4, 'OUT', 70, 1000)
  ];
  const onlyChunk = chunk(1, 1, rows);
  onlyChunk.totalPages = 1;
  const merged = mergeQwenChunkResults([onlyChunk], '方向颠倒流水.pdf', 1);

  assert.deepEqual(merged.transactions.map(item => item.direction), ['OUT', 'IN', 'OUT', 'IN']);
  assert.equal(merged.transactions.every(item => item.reviewStatus === 'CORRECTED'), true);
  assert.match(merged.account.parseWarnings?.join('\n') || '', /自动纠正整页收支方向/);
});

test('Qwen chunk merge keeps a suspected amount and balance column shift for review', () => {
  const rows = [
    transaction('a', 1, 1, 'OUT', 900, 0),
    transaction('b', 1, 2, 'IN', 950, 0),
    transaction('c', 1, 3, 'OUT', 930, 0),
    transaction('d', 1, 4, 'IN', 1000, 0)
  ];
  const onlyChunk = chunk(1, 1, rows);
  onlyChunk.totalPages = 1;
  const merged = mergeQwenChunkResults([onlyChunk], '列错位流水.pdf', 1);

  assert.equal(merged.transactions.every(item => item.reviewStatus === 'PENDING'), true);
  assert.equal(merged.transactions.every(item => (item.extractionConfidence || 0) <= 0.4), true);
  assert.match(merged.account.parseWarnings?.join('\n') || '', /发生额与余额列整体错位/);
});
