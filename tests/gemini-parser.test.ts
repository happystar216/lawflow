import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfWithGeminiStream } from '../functions/lib/geminiBankStatement';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';

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

test('Gemini parser preserves row accounts on a consolidated page containing multiple accounts', async () => {
  const originalFetch = globalThis.fetch;
  const modelJson = JSON.stringify({
    totalExtracted: 3,
    pagesCovered: [3],
    pageChecks: [
      { pageNumber: 3, transactionCount: 3, pageType: 'TRANSACTIONS', bankName: '四川农信', accountName: '胡艳红', accountNumber: '240101100859012' }
    ],
    transactions: [
      { p: 3, bk: '四川农信', ac: '255301100017262', tm: '2023-06-21', dir: 'IN', amt: 0.03, bal: 57.46, sm: '结息' },
      { p: 3, bk: '四川农信', ac: '240101100859012', tm: '2023-06-21', dir: 'IN', amt: 16.07, bal: 31461.44, sm: '结息' },
      { p: 3, bk: '四川农信', ac: '255301100006216', tm: '2023-06-21', dir: 'IN', amt: 2.78, bal: 5442.19, sm: '结息' }
    ]
  });
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] })}\n\n`);
  try {
    const result = await parsePdfWithGeminiStream(
      new File(['pdf'], 'multi-account.pdf', { type: 'application/pdf' }),
      { GEMINI_API_KEY: 'test' }, undefined, undefined, { totalPages: 3 }
    );
    assert.deepEqual(result.transactions.map(transaction => transaction.accountNumber), [
      '255301100017262', '240101100859012', '255301100006216'
    ]);
    assert.equal(result.accounts.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account-list page keeps five accounts while three consolidated-ledger groups receive transactions', async () => {
  const originalFetch = globalThis.fetch;
  const listedAccounts = [
    '22240101100859012',
    '22240201100609597',
    '22253101100348085',
    '22255301100006216',
    '22255301100017262'
  ];
  const modelJson = JSON.stringify({
    totalExtracted: 3,
    pagesCovered: [1, 2, 3],
    pageChecks: [
      { pageNumber: 1, transactionCount: 0, pageType: 'DOCUMENT' },
      {
        pageNumber: 2,
        transactionCount: 0,
        pageType: 'ACCOUNT_INFO',
        bankName: '四川农信',
        accountName: '胡艳红',
        accountNumber: '',
        accountNumbers: listedAccounts
      },
      {
        pageNumber: 3,
        transactionCount: 3,
        pageType: 'TRANSACTIONS',
        bankName: '四川农信',
        accountName: '胡艳红',
        accountNumber: '',
        accountNumbers: ['255301100017262', '240101100859012', '255301100006216']
      }
    ],
    transactions: [
      { p: 3, bk: '四川农信', ac: '255301100017262', tm: '2023-06-21', dir: 'IN', amt: 0.03, bal: 57.46, sm: '结息' },
      { p: 3, bk: '四川农信', ac: '240101100859012', tm: '2023-06-21', dir: 'IN', amt: 16.07, bal: 31461.44, sm: '结息' },
      { p: 3, bk: '四川农信', ac: '255301100006216', tm: '2023-06-21', dir: 'IN', amt: 2.78, bal: 5442.19, sm: '结息' }
    ]
  });
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] })}\n\n`);
  try {
    const parsed = await parsePdfWithGeminiStream(
      new File(['pdf'], '06_中国农业银行.pdf', { type: 'application/pdf' }),
      { GEMINI_API_KEY: 'test' }, undefined, undefined, { totalPages: 3, respondentName: '胡艳红' }
    );
    const normalized = normalizeRecognizedData(parsed.accounts, parsed.transactions);
    assert.deepEqual(
      normalized.accounts.map(account => account.accountNumber).sort(),
      [...listedAccounts].sort()
    );
    assert.equal(normalized.accounts.filter(account => account.transactionCount > 0).length, 3);
    assert.equal(normalized.accounts.filter(account => account.transactionCount === 0).length, 2);
    assert.deepEqual(
      normalized.transactions.map(transaction => transaction.accountNumber).sort(),
      ['22255301100017262', '22240101100859012', '22255301100006216'].sort()
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini parser splits consolidated balance groups when the model repeats one account', async () => {
  const originalFetch = globalThis.fetch;
  const repeatedAccount = '255301100017262';
  const modelJson = JSON.stringify({
    totalExtracted: 6,
    pagesCovered: [3],
    pageChecks: [{
      pageNumber: 3,
      transactionCount: 6,
      pageType: 'TRANSACTIONS',
      bankName: '四川农信',
      accountName: '胡艳红',
      accountNumber: '',
      accountNumbers: ['255301100017262', '240101100859012', '255301100006216']
    }],
    transactions: [
      { p: 3, bk: '四川农信', ac: repeatedAccount, tm: '2023-06-21', dir: 'IN', amt: 0.03, bal: 57.48, sm: '结息' },
      { p: 3, bk: '四川农信', ac: repeatedAccount, tm: '2023-09-21', dir: 'IN', amt: 0.03, bal: 57.51, sm: '结息' },
      { p: 3, bk: '四川农信', ac: repeatedAccount, tm: '2023-06-21', dir: 'IN', amt: 16.08, bal: 31477.52, sm: '结息' },
      { p: 3, bk: '四川农信', ac: repeatedAccount, tm: '2023-09-21', dir: 'IN', amt: 15.92, bal: 31493.44, sm: '结息' },
      { p: 3, bk: '四川农信', ac: repeatedAccount, tm: '2023-06-21', dir: 'IN', amt: 2.76, bal: 5440, sm: '结息' },
      { p: 3, bk: '四川农信', ac: repeatedAccount, tm: '2023-09-21', dir: 'IN', amt: 2.75, bal: 5442.75, sm: '结息' }
    ]
  });
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] })}\n\n`);
  try {
    const result = await parsePdfWithGeminiStream(
      new File(['pdf'], 'repeated-account.pdf', { type: 'application/pdf' }),
      { GEMINI_API_KEY: 'test' }, undefined, undefined, { totalPages: 3 }
    );
    assert.deepEqual(result.transactions.map(transaction => transaction.accountNumber), [
      '255301100017262', '255301100017262',
      '240101100859012', '240101100859012',
      '255301100006216', '255301100006216'
    ]);
    assert.equal(result.accounts.length, 3);
    assert.equal(result.warnings.some(warning => /逐笔账号未可靠读取/.test(warning)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini parser preserves a visible account result when the document has no transactions', async () => {
  const originalFetch = globalThis.fetch;
  const modelJson = JSON.stringify({
    totalExtracted: 0,
    pagesCovered: [1, 2],
    pageChecks: [
      { pageNumber: 1, transactionCount: 0, pageType: 'ACCOUNT_INFO', bankName: '测试银行', accountName: '张三', accountNumber: '62220001' },
      { pageNumber: 2, transactionCount: 0, pageType: 'BLANK', bankName: '', accountName: '', accountNumber: '' }
    ],
    transactions: []
  });
  globalThis.fetch = async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: modelJson }] } }] })}\n\n`);
  try {
    const result = await parsePdfWithGeminiStream(
      new File(['pdf'], 'no-transactions.pdf', { type: 'application/pdf' }),
      { GEMINI_API_KEY: 'test' }, undefined, undefined, { totalPages: 2 }
    );
    assert.equal(result.transactions.length, 0);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].accountNumber, '62220001');
    assert.equal(result.accounts[0].transactionCount, 0);
    assert.equal(result.accounts[0].isBalanced, false);
    assert.match(result.warnings.join('；'), /确无流水/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
