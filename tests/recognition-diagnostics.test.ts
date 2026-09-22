import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRecognitionDiagnostics } from '../src/review/recognitionDiagnostics';
import { BankAccount, StandardTransaction } from '../src/types/transaction';

test('recognition diagnostics include file, balance, page and row-level problems in one copyable report', () => {
  const account: BankAccount = {
    accountNumber: '6222000012344088', accountName: '胡艳红', bankName: '中国工商银行', ownerType: 'UNKNOWN',
    fileName: '胡艳红银行流水.pdf', fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 1,
    startDate: '2024-01-01', endDate: '2024-01-01', startBalance: 100, endBalance: 50,
    isBalanced: false, balanceDiff: 50, balanceAvailable: true, parseStatus: 'NEEDS_REVIEW',
    parseWarnings: ['第 3 页可能存在漏行']
  };
  const transaction: StandardTransaction = {
    id: 'tx-1', accountNumber: account.accountNumber, accountName: account.accountName, bankName: account.bankName,
    transactionTime: '', transactionDate: '', direction: 'UNKNOWN', amount: 0, balance: 50,
    counterpartyName: '', summary: '司法划扣', rawSourceFile: account.fileName, rawPageNumber: 3, rawRowIndex: 2,
    rawText: '2024-01-01 司法划扣', balanceAvailable: true, extractionConfidence: 0.42,
    reviewStatus: 'PENDING', dataQualityIssues: ['INVALID_DATE', 'INVALID_AMOUNT', 'UNKNOWN_DIRECTION']
  };

  const report = formatRecognitionDiagnostics([account], [transaction]);
  assert.match(report, /# 银行流水识别异常汇总/);
  assert.match(report, /文件：胡艳红银行流水\.pdf/);
  assert.match(report, /中国工商银行（尾号 4088）/);
  assert.match(report, /未平账，相差/);
  assert.match(report, /第 3 页可能存在漏行/);
  assert.match(report, /单笔异常流水/);
  assert.match(report, /第 3 页第 2 行/);
  assert.match(report, /需要核对：.*日期未能可靠读取/);
  assert.match(report, /识别原文：2024-01-01 司法划扣/);
});
