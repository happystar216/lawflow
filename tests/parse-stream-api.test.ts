import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/parse-bank-statement-stream';

test('stream API forwards the complete PDF segment contract to the direct parser', async () => {
  const originalFetch = globalThis.fetch;
  let prompt = '';
  const modelJson = JSON.stringify({
    totalExtracted: 1,
    pagesCovered: [1, 2, 3, 4],
    pageChecks: [
      { pageNumber: 1, transactionCount: 1, pageType: 'TRANSACTIONS', bankName: '测试银行', accountName: '胡艳红', accountNumber: '62220001' },
      { pageNumber: 2, transactionCount: 0, pageType: 'DOCUMENT' },
      { pageNumber: 3, transactionCount: 0, pageType: 'DOCUMENT' },
      { pageNumber: 4, transactionCount: 0, pageType: 'BLANK' }
    ],
    transactions: [
      { p: 1, r: 1, bk: '测试银行', ac: '62220001', tm: '2024-01-01', dir: 'IN', amt: 100, bal: 100,
        cf: { ac: 0.98, tm: 0.98, dir: 0.98, amt: 0.98, bal: 0.98 } }
    ]
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    prompt = body.contents?.[0]?.parts?.[1]?.text || '';
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] }, finishReason: 'STOP' }] })}\n\n`);
  };

  const formData = new FormData();
  formData.append('file', new File(['pdf'], 'segment.pdf', { type: 'application/pdf' }));
  formData.append('sourceFileName', '原始卷宗.pdf');
  formData.append('pageStart', '49');
  formData.append('pageEnd', '52');
  formData.append('totalPages', '128');
  formData.append('isPageSlice', 'true');
  formData.append('auditHint', '银行：测试银行；本方账号：62220001');
  formData.append('verificationMode', 'skip');

  try {
    const response = await onRequestPost({
      request: new Request('https://lawflow.example/api/parse-bank-statement-stream', { method: 'POST', body: formData }),
      env: { GEMINI_API_KEY: 'test' }
    });
    const events = (await response.text()).split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => JSON.parse(line.slice(5).trim()));
    const complete = events.find(event => event.type === 'complete');

    assert.match(prompt, /当前上传 PDF 只有 4 页/);
    assert.match(prompt, /原文件第 49-52 页/);
    assert.match(prompt, /本方账号：62220001/);
    assert.deepEqual(complete.coveredPages, [49, 50, 51, 52]);
    assert.equal(complete.transactions[0].rawPageNumber, 49);
    assert.equal(complete.totalPages, 128);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
