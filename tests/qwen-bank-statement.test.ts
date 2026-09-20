import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBankStatementWithQwen } from '../functions/lib/qwenBankStatement';

const env = { DASHSCOPE_API_KEY: 'test-key', DASHSCOPE_BASE_URL: 'https://example.invalid' };

function response(content: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { total_tokens: 10 }
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function parse(raw: unknown, count: number, verificationMode: 'always' | 'auto' | 'skip' = 'always') {
  const originalFetch = globalThis.fetch;
  const queue = [response(raw), response({ transactionCount: count, readability: 'CLEAR', pageType: 'TRANSACTIONS' })];
  globalThis.fetch = async () => queue.shift()!;
  try {
    return await parseBankStatementWithQwen(
      new File([new Uint8Array([1, 2, 3])], 'page.jpg', { type: 'image/jpeg' }),
      env,
      undefined,
      { sourceFileName: '流水.pdf', pageStart: 53, pageEnd: 53, totalPages: 128, verificationMode }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function row(accountNumber: string, rowIndex: number) {
  return {
    bankName: '中国工商银行', accountName: '胡艳红', accountNumber,
    transactionTime: `2024-01-0${rowIndex}`, transactionDate: `2024-01-0${rowIndex}`,
    direction: 'OUT', amount: 10, balance: 100 - rowIndex * 10,
    summary: '测试', rawPageNumber: 1, rawRowIndex: rowIndex, confidence: 0.95
  };
}

test('Qwen page header owner overrides a repeated secondary card number', async () => {
  const owner = '2308417101003074088';
  const secondaryCard = '6212262308019103022';
  const result = await parse({
    document: { bankName: '中国工商银行', accountName: '胡艳红', accountNumber: secondaryCard },
    pageChecks: [{
      pageNumber: 1, transactionCount: 2, pageType: 'TRANSACTIONS',
      ownerAccounts: [{ bankName: '中国工商银行', accountName: '胡艳红', accountNumber: owner }]
    }],
    transactions: [row(secondaryCard, 1), row(secondaryCard, 2)]
  }, 2);
  assert.equal(result.account.accountNumber, owner);
  assert.ok(result.transactions.every(transaction => transaction.accountNumber === owner));
});

test('Qwen preserves row identities on a genuine multi-owner consolidated page', async () => {
  const first = '25530110017362';
  const second = '240101100859012';
  const result = await parse({
    document: { bankName: '绵阳农村商业银行', accountName: '胡艳红', accountNumber: first },
    pageChecks: [{
      pageNumber: 1, transactionCount: 2, pageType: 'TRANSACTIONS',
      ownerAccounts: [
        { bankName: '绵阳农村商业银行', accountName: '胡艳红', accountNumber: first },
        { bankName: '绵阳农村商业银行', accountName: '胡艳红', accountNumber: second }
      ]
    }],
    transactions: [row(first, 1), row(second, 2)]
  }, 2);
  assert.deepEqual(result.transactions.map(transaction => transaction.accountNumber), [first, second]);
});

test('Qwen auto verification skips the second model call for a clean sparse page', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const raw = {
    document: { bankName: '中国工商银行', accountName: '胡艳红', accountNumber: '2308417101003074088' },
    pageChecks: [{ pageNumber: 1, transactionCount: 1, pageType: 'TRANSACTIONS' }],
    transactions: [row('2308417101003074088', 1)]
  };
  globalThis.fetch = async () => {
    calls += 1;
    return response(raw);
  };
  try {
    const result = await parseBankStatementWithQwen(
      new File([new Uint8Array([1])], 'page.jpg', { type: 'image/jpeg' }), env, undefined,
      { sourceFileName: '流水.pdf', pageStart: 1, pageEnd: 1, totalPages: 128, verificationMode: 'auto' }
    );
    assert.equal(calls, 1);
    assert.equal(result.countComplete, true);
    assert.equal(result.warnings.some(warning => warning.includes('未完成独立行数复核')), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Qwen auto verification retains the second pass for a dense page', async () => {
  const denseRows = Array.from({ length: 25 }, (_, index) => row('2308417101003074088', index + 1));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const queue = [response({
    document: { bankName: '中国工商银行', accountName: '胡艳红', accountNumber: '2308417101003074088' },
    pageChecks: [{ pageNumber: 1, transactionCount: 25, pageType: 'TRANSACTIONS' }],
    transactions: denseRows
  }), response({ transactionCount: 25, readability: 'CLEAR', pageType: 'TRANSACTIONS' })];
  globalThis.fetch = async () => {
    calls += 1;
    return queue.shift()!;
  };
  try {
    await parseBankStatementWithQwen(
      new File([new Uint8Array([1])], 'page.jpg', { type: 'image/jpeg' }), env, undefined,
      { sourceFileName: '流水.pdf', pageStart: 1, pageEnd: 1, totalPages: 128, verificationMode: 'auto' }
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
