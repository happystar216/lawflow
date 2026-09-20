import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSegmentedPageMap,
  buildSegmentPageRuns,
  buildVirtualDocumentSegments,
  finalizeBandResult,
  preferContextAudit,
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

test('segment API batches retain blank backs instead of degrading to one request per front page', () => {
  const pendingFrontPages = new Set([1, 3, 5, 7]);
  assert.deepEqual(
    buildSegmentPageRuns([1, 2, 3, 4, 5, 6, 7, 8], pendingFrontPages, 4),
    [[1, 2, 3, 4], [5, 6, 7, 8]]
  );
});

test('segment results map local PDF page numbers back to original source pages', () => {
  const input = denseResult(true);
  input.transactions = [
    { ...input.transactions[0], id: 'local-1', rawPageNumber: 1 },
    { ...input.transactions[0], id: 'local-3', rawPageNumber: 3 }
  ];
  input.warnings = ['第 3 页字段待核对'];
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

test('global page audit never replaces existing evidence with fewer rows or another account', () => {
  const existing = denseResult(false);
  const fewer = { ...denseResult(true), transactions: [] };
  assert.equal(preferContextAudit(existing, fewer), false);

  const otherAccount = denseResult(true);
  otherAccount.transactions = otherAccount.transactions.map(transaction => ({ ...transaction, accountNumber: '1192' }));
  assert.equal(preferContextAudit(existing, otherAccount), false);

  const moreComplete = denseResult(true);
  moreComplete.transactions = [
    ...moreComplete.transactions,
    { ...moreComplete.transactions[0], id: 'transaction-2', rawRowIndex: 2, amount: 200 }
  ];
  assert.equal(preferContextAudit(existing, moreComplete), true);
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
