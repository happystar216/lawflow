import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfWithGeminiStream } from '../functions/lib/geminiBankStatement';

test('Gemini parser keeps invalid fields pending and reports missing page coverage', async () => {
  const originalFetch = globalThis.fetch;
  const modelJson = JSON.stringify({
    totalExtracted: 1,
    pagesCovered: [1],
    pageChecks: [{ pageNumber: 1, transactionCount: 1, pageType: 'TRANSACTIONS' }],
    transactions: [{ p: 1, bk: '测试银行', ac: 'A', tm: 'not-a-date', dir: 'MAYBE', amt: 'bad', bal: null }]
  });
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] })}\n\n`);
  try {
    const result = await parsePdfWithGeminiStream(
      new File(['pdf'], 'test.pdf', { type: 'application/pdf' }),
      { GEMINI_API_KEY: 'test' },
      undefined,
      undefined,
      { totalPages: 2 }
    );
    assert.equal(result.countComplete, false);
    assert.match(result.warnings.join('；'), /第 2 页/);
    assert.equal(result.transactions[0].direction, 'UNKNOWN');
    assert.equal(result.transactions[0].reviewStatus, 'PENDING');
    assert.deepEqual(result.transactions[0].dataQualityIssues, ['INVALID_DATE', 'INVALID_AMOUNT', 'UNKNOWN_DIRECTION']);
    assert.equal(result.accounts[0].parseStatus, 'NEEDS_REVIEW');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini parser does not silently rewrite a direction to fit balances', async () => {
  const originalFetch = globalThis.fetch;
  const modelJson = JSON.stringify({
    totalExtracted: 2,
    pagesCovered: [1],
    pageChecks: [{ pageNumber: 1, transactionCount: 2, pageType: 'TRANSACTIONS' }],
    transactions: [
      { p: 1, bk: '测试银行', ac: 'A', tm: '2024-01-01', dir: 'IN', amt: 100, bal: 100 },
      { p: 1, bk: '测试银行', ac: 'A', tm: '2024-01-02', dir: 'OUT', amt: 50, bal: 150 }
    ]
  });
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] })}\n\n`);
  try {
    const result = await parsePdfWithGeminiStream(
      new File(['pdf'], 'test.pdf', { type: 'application/pdf' }),
      { GEMINI_API_KEY: 'test' }, undefined, undefined, { totalPages: 1 }
    );
    assert.equal(result.transactions[1].direction, 'OUT');
    assert.equal(result.transactions[1].amount, 50);
    assert.equal(result.transactions[1].balance, 150);
    assert.equal(result.transactions[1].extractionConfidence, 0.9);
    assert.equal(result.transactions[1].reviewStatus, 'AUTO_PASSED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini parser uses each page header identity instead of a carried-over transaction account', async () => {
  const originalFetch = globalThis.fetch;
  const modelJson = JSON.stringify({
    totalExtracted: 2,
    pagesCovered: [4, 6],
    pageChecks: [
      { pageNumber: 4, transactionCount: 1, pageType: 'TRANSACTIONS', bankName: '中国工商银行', accountName: '胡艳红', accountNumber: '2308014101400042218' },
      { pageNumber: 6, transactionCount: 1, pageType: 'TRANSACTIONS', bankName: '中国工商银行', accountName: '胡艳红', accountNumber: '2308417101003074088' }
    ],
    transactions: [
      { p: 4, bk: '中国工商银行', ac: '2308417101003074088', tm: '2025-03-21', dir: 'IN', amt: 3.1, bal: 13.85 },
      { p: 6, bk: '中国工商银行', ac: '2308417101003074088', tm: '2024-09-21', dir: 'IN', amt: 0.01, bal: 0.01 }
    ]
  });
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] })}\n\n`);
  try {
    const result = await parsePdfWithGeminiStream(
      new File(['pdf'], 'test.pdf', { type: 'application/pdf' }),
      { GEMINI_API_KEY: 'test' }, undefined, undefined, { totalPages: 6 }
    );
    assert.deepEqual(result.transactions.map(transaction => transaction.accountNumber), [
      '2308014101400042218', '2308417101003074088'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
