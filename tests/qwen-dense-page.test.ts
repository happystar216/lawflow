import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeBandResult, ChunkParseResult } from '../src/parsers/qwenPdfParser';

function denseResult(countComplete: boolean): ChunkParseResult {
  return {
    account: {
      id: 'account-1',
      accountName: '胡艳红',
      accountNumber: '6222000000000001',
      bankName: '中国工商银行',
      fileName: '银行流水.pdf'
    },
    transactions: [{
      id: 'transaction-1',
      accountId: 'account-1',
      accountName: '胡艳红',
      accountNumber: '6222000000000001',
      bankName: '中国工商银行',
      transactionDate: '2024-01-01',
      transactionTime: '2024-01-01 10:00:00',
      direction: 'IN',
      amount: 100,
      balance: 100,
      summary: '转账',
      counterpartyName: '张三',
      counterpartyAccount: '',
      sourceFileName: '银行流水.pdf',
      rawPageNumber: 35,
      rawRowIndex: 1,
      reviewStatus: 'VERIFIED'
    }],
    warnings: [],
    coveredPages: [35],
    pageStart: 35,
    pageEnd: 35,
    totalPages: 128,
    expectedTransactionCount: 2,
    countComplete,
    pageQuality: [{
      page: 35,
      expectedCount: 2,
      extractedCount: 1,
      status: countComplete ? 'COMPLETE' : 'NEEDS_REVIEW',
      pageType: 'TRANSACTIONS'
    }]
  };
}

test('dense-page result is preserved after one band pass and marked for focused review', () => {
  const result = finalizeBandResult(denseResult(false), 35);
  assert.equal(result.countComplete, false);
  assert.equal(result.transactions[0].reviewStatus, 'PENDING');
  assert.equal(result.pageQuality?.[0].status, 'NEEDS_REVIEW');
  assert.match(result.warnings?.join('\n') || '', /一次完整读取和一次分段补读/);
  assert.match(result.warnings?.join('\n') || '', /独立清点为 2 笔，分段提取为 1 笔/);
});

test('complete dense-page result remains unchanged', () => {
  const input = denseResult(true);
  assert.equal(finalizeBandResult(input, 35), input);
});
