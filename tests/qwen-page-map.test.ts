import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBankPageSheet } from '../functions/lib/qwenPageMap';

test('page-map classifier preserves requested pages and normalizes uncertain output', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ pages: [
      { page: 33, pageType: 'TRANSACTIONS', rotation: 90, bankName: '中国工商银行', accountName: '胡艳红', accountNumbers: ['2308 4171 0100 3074 088'], density: 'HIGH', confidence: 0.96 },
      { page: 34, pageType: 'BLANK', rotation: 45, accountNumbers: [], density: 'other', confidence: 2 }
    ] }) } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await classifyBankPageSheet(
      new File([new Uint8Array([1, 2])], 'map.jpg', { type: 'image/jpeg' }),
      [33, 34, 35],
      { DASHSCOPE_API_KEY: 'key', DASHSCOPE_BASE_URL: 'https://example.invalid' }
    );
    assert.deepEqual(result.map(item => item.page), [33, 34, 35]);
    assert.equal(result[0].rotation, 90);
    assert.deepEqual(result[0].accountNumbers, ['2308417101003074088']);
    assert.equal(result[1].rotation, 0);
    assert.equal(result[1].confidence, 1);
    assert.equal(result[2].pageType, 'UNKNOWN');
    assert.equal(result[2].confidence, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('page-map classifier uses the PDF recognition provider when it is available', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async input => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ pages: [
        { page: 1, pageType: 'ACCOUNT_INFO', rotation: 0, bankName: '中国农业银行', accountName: '胡艳红', accountNumbers: ['22240201100609597'], density: 'LOW', confidence: 0.97 }
      ] }) }] } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await classifyBankPageSheet(
      new File([new Uint8Array([1, 2])], 'map.jpg', { type: 'image/jpeg' }),
      [1],
      { GEMINI_API_KEY: 'key', GEMINI_MODEL: 'gemini-test' }
    );
    assert.match(requestedUrl, /gemini-test:generateContent/);
    assert.equal(result[0].bankName, '中国农业银行');
    assert.deepEqual(result[0].accountNumbers, ['22240201100609597']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('page-map classifier preserves detailed document page types', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ pages: [
      { page: 1, pageType: 'INVESTIGATION_ORDER', rotation: 0, bankName: '', accountNumbers: [], density: 'LOW', confidence: 0.94, documentBoundary: 'START', documentLabel: '律调令285号之一·农业银行', investigationOrderNo: '285号之一' },
      { page: 2, pageType: 'ACCOUNT_LIST', rotation: 0, bankName: '中国农业银行', accountNumbers: ['62220001'], density: 'LOW', confidence: 0.96 }
    ] }) } }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await classifyBankPageSheet(
      new File([new Uint8Array([1, 2])], 'map.jpg', { type: 'image/jpeg' }),
      [1, 2],
      { DASHSCOPE_API_KEY: 'key', DASHSCOPE_BASE_URL: 'https://example.invalid' }
    );
    assert.deepEqual(result.map(item => item.pageType), ['INVESTIGATION_ORDER', 'ACCOUNT_LIST']);
    assert.equal(result[0].documentBoundary, 'START');
    assert.equal(result[0].investigationOrderNo, '285号之一');
    assert.equal(result[1].documentBoundary, 'UNCERTAIN');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
