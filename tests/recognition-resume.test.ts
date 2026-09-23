import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMinerUDocumentByPage, type MinerUPageCheckpoint } from '../src/parsers/mineruBankStatementParser';
import { recognitionScopeKey, recognitionInputKey, reusablePage, type RecognitionResumeStore } from '../src/recognition/resume';
import { buildPageContexts, type ContextPage } from '../src/recognition/pageContext';
import type { MinerUStructuredDocument } from '../src/parsers/mineruResultParser';
import { normalizeMinerUBankStatementStream } from '../functions/lib/mineruBankStatementNormalizer';

function memoryStore(): RecognitionResumeStore {
  let document: MinerUStructuredDocument | undefined;
  const pages = new Map<number, { key: string; value: MinerUPageCheckpoint }>();
  return {
    loadDocument: async () => structuredClone(document),
    saveDocument: async value => { document = structuredClone(value); },
    loadPage: async (page, key) => {
      const saved = pages.get(page);
      return saved?.key === key ? structuredClone(saved.value) : undefined;
    },
    savePage: async (value, key) => { pages.set(value.page, { key, value: structuredClone(value) }); }
  };
}

function source(): MinerUStructuredDocument {
  return { pages: [], blocks: [1, 2].flatMap(page => [
    { page, type: 'text', text: '测试银行\n本方账号：900000000000001' },
    { page, type: 'text', text: `2024-01-0${page} 收入 10.00 余额 ${page * 10}.00` }
  ]) };
}

function response(page: number, review = false) {
  return new Response(JSON.stringify({
    accounts: [{ ac: '900000000000001', holder: '测试户', bk: '测试银行', p: page, cf: 0.99 }],
    transactions: [{ p: page, r: 1, ac: '900000000000001', holder: '测试户', bk: '测试银行',
      tm: `2024-01-0${page}`, dir: 'IN', amt: 10, bal: page * 10, cp: '', ca: '', cb: '', sm: '测试', cf: 0.99 }],
    pageChecks: [{ p: page, type: 'TRANSACTIONS', extracted: 1, status: review ? 'NEEDS_REVIEW' : 'COMPLETE' }], warnings: []
  }), { headers: { 'Content-Type': 'application/json' } });
}

const file = () => new File(['not-rendered'], 'test.pdf', { type: 'application/pdf' });

test('resume keys isolate user, case, content, respondent, revision and changed context', async () => {
  const baseline = ['u', 'c', 'hash', 'name', 'rev'] as const;
  const keys = baseline.map((_, i) => recognitionScopeKey(...baseline.map((v, j) => i === j ? `${v}2` : v) as unknown as [string, string, string, string, string]));
  assert.equal(new Set([recognitionScopeKey(...baseline), ...keys]).size, 6);
  assert.notEqual(recognitionScopeKey('a|b', 'c', 'd', ''), recognitionScopeKey('a', 'b|c', 'd', ''));
  assert.notEqual(await recognitionInputKey({ page: 1 }), await recognitionInputKey({ page: 1, context: 'changed' }));
});

test('page resume skips completed requests; fresh mode and changed source rerun them', async () => {
  const originalFetch = globalThis.fetch;
  const requested: number[] = [];
  const checkpoints: MinerUPageCheckpoint[] = [];
  const store = memoryStore();
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requested.push(request.pages[0].page);
    return response(request.pages[0].page);
  };
  try {
    const run = (document = source(), fresh = false) => normalizeMinerUDocumentByPage(file(), document, 'test.pdf', '测试户', 2,
      undefined, undefined, checkpoint => checkpoints.push(checkpoint), { resumeStore: store, forceFresh: fresh });
    const first = await run();
    assert.equal(requested.length, 2);
    assert.ok(checkpoints.every(checkpoint => reusablePage(checkpoint, checkpoint.page)));
    checkpoints.length = 0;
    const second = await run();
    assert.equal(requested.length, 2);
    assert.ok(checkpoints.every(checkpoint => checkpoint.reused));
    assert.deepEqual(second.transactions, first.transactions);
    await run(source(), true);
    assert.equal(requested.length, 4);
    const changed = source();
    changed.blocks[1].text += ' 新原文';
    await run(changed);
    assert.equal(requested.length, 5);
  } finally { globalThis.fetch = originalFetch; }
});

test('review pages are retried while complete pages are reused', async () => {
  const originalFetch = globalThis.fetch;
  const requests: number[] = [];
  const store = memoryStore();
  let review = true;
  globalThis.fetch = async (_url, init) => {
    const page = JSON.parse(String(init?.body)).pages[0].page;
    requests.push(page);
    return response(page, review && page === 2);
  };
  try {
    const run = () => normalizeMinerUDocumentByPage(file(), source(), 'test.pdf', '测试户', 2,
      undefined, undefined, undefined, { resumeStore: store });
    await run();
    review = false;
    await run();
    assert.deepEqual(requests.sort(), [1, 2, 2]);
  } finally { globalThis.fetch = originalFetch; }
});

test('cancellation preserves completed checkpoints and a later run resumes remaining pages', async () => {
  const originalFetch = globalThis.fetch;
  const store = memoryStore();
  const controller = new AbortController();
  let interruptedRun = true;
  const requests: number[] = [];
  globalThis.fetch = async (_url, init) => {
    const page = JSON.parse(String(init?.body)).pages[0].page;
    requests.push(page);
    if (page === 2 && interruptedRun) {
      await new Promise((_, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        else init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    return response(page);
  };
  try {
    await assert.rejects(normalizeMinerUDocumentByPage(file(), source(), 'test.pdf', '测试户', 2,
      undefined, controller.signal, checkpoint => { if (checkpoint.page === 1) controller.abort(); }, { resumeStore: store }));
    interruptedRun = false;
    const result = await normalizeMinerUDocumentByPage(file(), source(), 'test.pdf', '测试户', 2,
      undefined, undefined, undefined, { resumeStore: store });
    assert.equal(result.transactions.length, 2);
    assert.equal(requests.filter(page => page === 1).length, 1);
    assert.equal(requests.filter(page => page === 2).length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('unavailable checkpoint storage warns but does not discard recognition', async () => {
  const originalFetch = globalThis.fetch;
  const warnings: string[] = [];
  const fail = async (): Promise<never> => { throw new Error('quota'); };
  globalThis.fetch = async (_url, init) => response(JSON.parse(String(init?.body)).pages[0].page);
  try {
    const result = await normalizeMinerUDocumentByPage(file(), source(), 'test.pdf', '测试户', 2,
      undefined, undefined, undefined, {
        resumeStore: { loadDocument: fail, saveDocument: fail, loadPage: fail, savePage: fail },
        onResumeWarning: warning => warnings.push(warning)
      });
    assert.equal(result.transactions.length, 2);
    assert.ok(warnings.length > 0);
  } finally { globalThis.fetch = originalFetch; }
});

function contextPage(page: number, account = '900000000000001', bank = '测试银行'): ContextPage {
  return { page, ownerAccounts: [account], bank, headers: [{ order: 1, type: 'text', content: `${bank} 本方账号：${account}` }] };
}

test('context uses exact own account evidence, not neighboring pages, suffixes or multiple owners', () => {
  const contexts = buildPageContexts([contextPage(1), contextPage(2, '900000000000002'), contextPage(3),
    contextPage(4, '000001'), { ...contextPage(5), ownerAccounts: [] },
    { ...contextPage(6), ownerAccounts: ['900000000000001', '900000000000002'] }]);
  assert.deepEqual(contexts.get(1)?.references.map(reference => reference.page), [3]);
  assert.equal(contexts.has(2), false);
  assert.equal(contexts.has(4), false);
  assert.equal(contexts.has(5), false);
  assert.equal(contexts.has(6), false);
});

test('conflicting banks block context even when the target bank is unknown', () => {
  const contexts = buildPageContexts([contextPage(1, '900000000000001', ''), contextPage(2), contextPage(3, '900000000000001', '另一银行')]);
  assert.equal(contexts.size, 0);
});

test('page request preserves context evidence but does not include other transaction rows', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.context.targetPage, request.pages[0].page);
    assert.equal(request.context.references.length, 1);
    assert.ok(!JSON.stringify(request.context).includes('余额'));
    assert.deepEqual(request.context.references[0].matchedAccountNumbers, ['900000000000001']);
    return response(request.pages[0].page);
  };
  try {
    await normalizeMinerUDocumentByPage(file(), source(), 'test.pdf', '测试户', 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('normalizer rejects context attached to wrong page before calling upstream', async () => {
  await assert.rejects(normalizeMinerUBankStatementStream({ mode: 'PAGE', sourceFileName: 'test.pdf',
    totalPages: 2, pages: [{ page: 1, blocks: [] }],
    context: { version: 1, targetPage: 2, references: [] }
  }, { GEMINI_API_KEY: 'dummy' }), /跨页参考范围无效/);
});
