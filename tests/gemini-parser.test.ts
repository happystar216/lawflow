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
