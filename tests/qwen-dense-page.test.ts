import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSegmentedPageMap,
  buildVirtualDocumentSegments,
  splitSegmentResultByPage,
  ChunkParseResult,
  PageMapItem
} from '../src/parsers/qwenPdfParser';

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

test('virtual document map keeps continuation pages with one account and splits a second account', () => {
  const map = new Map<number, PageMapItem>([
    [1, pageMap(1, '中国工商银行', ['4088'], 90)],
    [2, pageMap(2, '', [], 0, 'BLANK')],
    [3, pageMap(3, '', [], 0, 'UNKNOWN', 0.2)],
    [4, pageMap(4, '中国工商银行', ['4088'], 90)],
    [5, pageMap(5, '中国工商银行', ['1192'], 90)]
  ]);
  const segments = buildVirtualDocumentSegments(map);
  assert.deepEqual(segments.map(item => item.pages), [[1, 2, 3, 4], [5]]);
  assert.deepEqual(segments[0].accountNumbers, ['4088']);
  assert.deepEqual(segments[1].accountNumbers, ['1192']);
});

test('segment results accept only server-normalized original source page numbers', () => {
  const input = denseResult(true);
  input.transactions = [
    { ...input.transactions[0], id: 'global-49', rawPageNumber: 49 },
    { ...input.transactions[0], id: 'global-51', rawPageNumber: 51 }
  ];
  input.warnings = ['第 51 页字段待核对'];
  const pages = splitSegmentResultByPage(input, {
    id: 'SEG-P49-52', segmentId: 'SEG', bankName: '中国工商银行', accountNumbers: ['4088'],
    pages: [49, 50, 51, 52], file: new File([], 'segment.pdf', { type: 'application/pdf' }),
    pageStart: 49, pageEnd: 52, totalPages: 128, rotation: 0, scale: 1
  }, new Map(), '原始卷宗.pdf');
  assert.equal(pages[0].transactions[0].rawPageNumber, 49);
  assert.equal(pages[2].transactions[0].rawPageNumber, 51);
  assert.match(pages[2].warnings?.join('\n') || '', /第 51 页/);
  assert.equal(pages[2].transactions[0].rawSourceFile, '原始卷宗.pdf');
});

test('segment account index is carried once instead of repeated on every split page', () => {
  const input = denseResult(true);
  input.accounts = [input.account, { ...input.account, accountNumber: '6222000000000002' }];
  const pages = splitSegmentResultByPage(input, {
    id: 'SEG-P35-36', segmentId: 'SEG', bankName: '中国工商银行', accountNumbers: ['4088'],
    pages: [35, 36], file: new File([], 'segment.pdf', { type: 'application/pdf' }),
    pageStart: 35, pageEnd: 36, totalPages: 128, rotation: 0, scale: 1
  }, new Map(), '原始卷宗.pdf');

  assert.equal(pages[0].accounts?.length, 2);
  assert.equal(pages[1].accounts, undefined);
});

test('segmented map inherits account and rotation context across an uncertain continuation page', () => {
  const raw = new Map<number, PageMapItem>([
    [3, pageMap(3, '', [], 90, 'UNKNOWN', 0.6)]
  ]);
  const cached = new Map<number, ChunkParseResult>([
    [2, { ...denseResult(true), pageStart: 2, pageEnd: 2, coveredPages: [2] }],
    [4, { ...denseResult(true), pageStart: 4, pageEnd: 4, coveredPages: [4] }]
  ]);
  const result = buildSegmentedPageMap(raw, cached, 4);
  assert.deepEqual(result.get(3)?.segmentAccountNumbers, ['6222000000000001']);
  assert.equal(result.get(3)?.rotation, 90);
  assert.equal(result.get(2)?.segmentId, result.get(4)?.segmentId);
});

function pageMap(
  page: number,
  bankName: string,
  accountNumbers: string[],
  rotation: 0 | 90 | 180 | 270,
  pageType: PageMapItem['pageType'] = 'TRANSACTIONS',
  confidence = 0.95
): PageMapItem {
  return {
    page, pageType, rotation, bankName, accountName: '胡艳红', accountNumbers,
    density: pageType === 'TRANSACTIONS' ? 'HIGH' : 'LOW', confidence
  };
}
