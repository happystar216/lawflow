import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStatementPlan, validateStatementPages, planningPages, type PlanningPage, type StatementPage } from '../src/recognition/statementPlan';
import { buildStatementContexts } from '../src/recognition/pageContext';
import { requestStatementPlan } from '../src/recognition/statementPlanningClient';
import { normalizeMinerUDocumentByPage, type MinerUPageCheckpoint } from '../src/parsers/mineruBankStatementParser';
import { planStatementPages, validatePlanningInput } from '../functions/lib/statementPlanner';
import type { RecognitionResumeStore } from '../src/recognition/resume';
import { buildEvidenceReviewIssues } from '../src/review/buildEvidenceReviewIssues';

const number = '900000000000001';
function source(count = 2): PlanningPage[] {
  return Array.from({ length: count }, (_, i) => ({ page: i + 1, blocks: [
    { order: 1, type: 'text', content: i === 0 ? `测试银行\n本方账号：${number}\n第1页` : `第${i + 1}页（续）` },
    { order: 2, type: 'text', content: '交易日期 收入 支出 余额' },
    { order: 3, type: 'text', content: '2024-01-01 收入 10.00 余额 20.00' }
  ] }));
}
function descriptor(page: number, relation: StatementPage['relation'] = page === 1 ? 'START' : 'CONTINUE'): StatementPage {
  return { page, type: 'TRANSACTIONS',
    bank: page === 1 ? { value: '测试银行', evidence: { page, block: 1, quote: '测试银行' } } : null,
    accounts: page === 1 ? [{ value: number, evidence: { page, block: 1, quote: `本方账号：${number}` } }] : [],
    headers: [{ page, block: 2, quote: '交易日期 收入 支出 余额' }], relation,
    continuation: relation === 'CONTINUE' ? [
      { page: page - 1, block: 1, quote: `第${page - 1}页` }, { page, block: 1, quote: `第${page}页（续）` }
    ] : [], confidence: 0.99, issues: [] };
}

test('statement evidence rejects invented bank/account quotes, duplicate pages and unsupported continuation', () => {
  const bad = descriptor(2);
  bad.bank = { value: '虚构银行', evidence: { page: 2, block: 1, quote: '虚构银行' } };
  bad.accounts = descriptor(1).accounts;
  bad.continuation = [{ page: 1, block: 1, quote: '第1页' }];
  const validated = validateStatementPages([descriptor(1), bad], source(), [1, 2]);
  assert.equal(validated[1].bank, null);
  assert.deepEqual(validated[1].accounts, []);
  assert.equal(validated[1].relation, 'UNKNOWN');
  assert.ok(validated[1].issues.length >= 2);
  assert.equal((validated[1].proposal?.bank as any).value, '虚构银行');
  const duplicate = validateStatementPages([descriptor(1), descriptor(1)], source(), [1, 2]);
  assert.ok(duplicate.every(page => page.type === 'UNKNOWN'));
});

test('account metadata with no accounts cannot be silently treated as a complete inventory', () => {
  const empty = { ...descriptor(1), type: 'ACCOUNT_LIST', accounts: [] };
  const validated = validateStatementPages([empty], source(), [1]);
  assert.match(validated[0].issues.join(''), /没有可验证的账号/);
  assert.ok(validateStatementPages([{ page: 1, type: 'TRANSACTIONS', confidence: .99 }], source(), [1])[0].issues.length);
});

test('table account evidence may cite a distant cell separately from its header', () => {
  const header = '<tr><td>账号</td><td>对方账号</td></tr>';
  const cell = `<td>${number}</td>`;
  const table = `<table>${header}${'<tr><td>说明</td><td></td></tr>'.repeat(100)}<tr>${cell}<td>800000000000001</td></tr></table>`;
  assert.ok(table.indexOf(cell) - table.indexOf(header) > 2000);
  const pages = [{ page: 1, blocks: [{ order: 1, type: 'table', content: table }] }];
  const raw = { ...descriptor(1), bank: null, accounts: [{ value: number, evidence: { page: 1, block: 1, quote: cell } }],
    headers: [{ page: 1, block: 1, quote: header }] };
  const valid = validateStatementPages([raw], pages, [1])[0];
  assert.deepEqual(valid.accounts.map(account => account.value), [number]);
  assert.deepEqual(valid.issues, []);
  const withoutHeader = validateStatementPages([{ ...raw, headers: [] }], pages, [1])[0];
  assert.deepEqual(withoutHeader.accounts, []);
  assert.match(withoutHeader.issues.join(''), /同表.*表头/);
  assert.equal((withoutHeader.proposal?.accounts as any[]).length, 1);
  const otherTable = [...pages[0].blocks, { order: 2, type: 'table', content: `<table>${header}</table>` }];
  assert.equal(validateStatementPages([{ ...raw, headers: [{ page: 1, block: 2, quote: header }] }],
    [{ page: 1, blocks: otherTable }], [1])[0].accounts.length, 0);
});

test('account metadata deduplicates only identical normalized numbers and retains raw observations', () => {
  const values = [number, number, '900000000000002', '9900000000000001'];
  const text = values.map(value => `本方账号：${value}`).join('\n');
  const raw = { ...descriptor(1), bank: null, headers: [], accounts: values.map(value => ({ value,
    evidence: { page: 1, block: 1, quote: `本方账号：${value}` } })) };
  const pages = [{ page: 1, blocks: [{ order: 1, type: 'text', content: text }] }];
  const result = validateStatementPages([raw], pages, [1])[0];
  assert.equal(result.accounts.length, 3);
  assert.equal((result.proposal?.accounts as any[]).length, 4);
  assert.deepEqual(validateStatementPages([result], pages, [1])[0], result);
});

test('headerless continuation joins one ledger and gets a proposed reference, never an observed account', () => {
  const validated = validateStatementPages([descriptor(1), descriptor(2)], source(), [1, 2]);
  const plan = buildStatementPlan(validated, 2);
  assert.equal(plan.get(1)?.group.id, plan.get(2)?.group.id);
  assert.deepEqual(plan.get(2)?.descriptor.accounts, []);
  const contexts = buildStatementContexts(plan, source().map(page => ({ page: page.page,
    ownerAccounts: page.page === 1 ? [number] : [], bank: '', headers: [] })));
  assert.equal(contexts.get(2)?.basis, 'PROPOSED_CONTINUATION');
  assert.equal(contexts.get(2)?.references[0].page, 1);
  assert.ok(plan.get(2)?.group.needsReview);
});

test('different banks, different accounts, new print sequences and missing pages cannot share context', () => {
  for (const changed of ['bank', 'account', 'start', 'missing'] as const) {
    const second = descriptor(2);
    if (changed === 'bank') second.bank = { value: '另一银行', evidence: { page: 2, block: 1, quote: '另一银行' } };
    if (changed === 'account') second.accounts = [{ value: '900000000000002', evidence: { page: 2, block: 1, quote: '900000000000002' } }];
    if (changed === 'start') second.relation = 'START';
    const plan = buildStatementPlan(changed === 'missing' ? [descriptor(1), descriptor(3)] : [descriptor(1), second], 3);
    assert.notEqual(plan.get(1)?.group.id, plan.get(2)?.group.id, changed);
    if (changed === 'missing') assert.notEqual(plan.get(2)?.group.id, plan.get(3)?.group.id);
  }
});

test('multi-owner and account-list pages never establish a unique continuation owner', () => {
  for (const type of ['ACCOUNT_LIST', 'TRANSACTIONS'] as const) {
    const first = descriptor(1);
    first.type = type;
    if (type === 'TRANSACTIONS') first.accounts.push({ value: '900000000000002', evidence: { page: 1, block: 1, quote: '900000000000002' } });
    const plan = buildStatementPlan([first, descriptor(2)], 2);
    assert.notEqual(plan.get(1)?.group.id, plan.get(2)?.group.id);
  }
});

test('bounded metadata excerpts do not mutate original transaction content', () => {
  const pages = source();
  pages[0].blocks[2].content = 'a'.repeat(5000);
  const reduced = planningPages(pages);
  assert.ok(reduced[0].blocks[2].content.length < 5000);
  assert.equal(pages[0].blocks[2].content.length, 5000);
  assert.throws(() => validatePlanningInput({ pages: reduced, targetPages: [1, 1] }), /无效/);
});

test('planning batches overlap only for context and preserve continuation across batch boundaries', async () => {
  const originalFetch = globalThis.fetch;
  const batches: any[] = [];
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)); batches.push(input);
    return new Response(JSON.stringify({ pages: input.targetPages.map((page: number) => descriptor(page)) }));
  };
  try {
    const pages = await requestStatementPlan(source(17));
    assert.equal(pages.length, 17);
    assert.deepEqual(batches[1].pages.map((page: PlanningPage) => page.page), [8, 9, 10, 11, 12, 13, 14, 15, 16]);
    assert.equal(buildStatementPlan(pages, 17).get(17)?.group.id, 'STATEMENT_P1');
    assert.equal(new Set(pages.map(page => page.page)).size, 17);
  } finally { globalThis.fetch = originalFetch; }
});

test('planning failure isolates affected pages and never invents a continuation', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 524 });
  try {
    const pages = await requestStatementPlan(source());
    assert.ok(pages.every(page => page.type === 'UNKNOWN' && page.issues.length));
    const plan = buildStatementPlan(pages, 2);
    assert.notEqual(plan.get(1)?.group.id, plan.get(2)?.group.id);
  } finally { globalThis.fetch = originalFetch; }
});

test('a planning outage does not wait for every batch of a long document', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 503 }); };
  try {
    const pages = await requestStatementPlan(source(300));
    assert.equal(pages.length, 300);
    assert.ok(calls <= 2);
    assert.ok(pages.every(page => page.type === 'UNKNOWN'));
  } finally { globalThis.fetch = originalFetch; }
});

test('planning cache resumes completed batches and source changes invalidate the batch', async () => {
  const originalFetch = globalThis.fetch;
  const cache = new Map<string, StatementPage[]>();
  let requests = 0;
  const store: RecognitionResumeStore = {
    loadDocument: async () => undefined, saveDocument: async () => {}, loadPage: async () => undefined, savePage: async () => {},
    loadPlanningBatch: async (page, key) => cache.get(`${page}:${key}`),
    savePlanningBatch: async (page, key, value) => { cache.set(`${page}:${key}`, structuredClone(value)); }
  };
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ pages: [descriptor(1), descriptor(2)] })); };
  try {
    await requestStatementPlan(source(), { resumeStore: store });
    await requestStatementPlan(source(), { resumeStore: store });
    assert.equal(requests, 1);
    const changed = source(); changed[1].blocks[2].content += 'changed';
    await requestStatementPlan(changed, { resumeStore: store });
    assert.equal(requests, 2);
    await requestStatementPlan(source(), { resumeStore: store, forceFresh: true });
    assert.equal(requests, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test('normal production page pipeline plans first, retains full source, and does not inherit a headerless account', async () => {
  const originalFetch = globalThis.fetch;
  const checkpoints: MinerUPageCheckpoint[] = [];
  let planned = false;
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(url) === '/api/plan-statements') {
      planned = true;
      return new Response(JSON.stringify({ pages: [descriptor(1), descriptor(2)] }));
    }
    assert.ok(planned);
    const page = request.pages[0].page;
    if (page === 2) assert.equal(request.context.basis, 'PROPOSED_CONTINUATION');
    assert.equal(request.pages[0].blocks[2].content, source()[page - 1].blocks[2].content);
    return new Response(JSON.stringify({
      accounts: page === 1 ? [{ ac: number, holder: '测试户', bk: '测试银行', p: page, cf: .99 }] : [],
      transactions: [{ p: page, r: 1, ac: page === 1 ? number : '', holder: '测试户', bk: '',
        tm: '2024-01-01', dir: 'IN', amt: 10, bal: 20, sm: '测试', cf: .99 }],
      pageChecks: [{ p: page, type: 'TRANSACTIONS', extracted: 1, status: 'COMPLETE' }], warnings: []
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const input = source();
    const result = await normalizeMinerUDocumentByPage(new File(['unused'], 'test.pdf'), {
      pages: [], blocks: input.flatMap(page => page.blocks.map(block => ({ page: page.page, type: block.type, text: block.content })))
    }, 'test.pdf', '测试户', 2, undefined, undefined, checkpoint => checkpoints.push(checkpoint), { statementPlanning: true });
    const continuation = checkpoints.find(checkpoint => checkpoint.page === 2)!;
    assert.equal(continuation.statement?.group.id, 'STATEMENT_P1');
    assert.notEqual(result.transactions.find(row => row.rawPageNumber === 2)?.accountNumber, number);
    assert.ok(continuation.selected.warnings?.some(warning => warning.includes('系统未据此改写流水账号')));
    const issues = result.accounts.flatMap(account => buildEvidenceReviewIssues(account, result.transactions));
    const ownerIssue = issues.find(issue => issue.title === '第 2 页确认流水所属账号');
    assert.equal(ownerIssue?.severity, 'REQUIRED');
    assert.ok(ownerIssue?.instructions.some(instruction => instruction.includes('同时打开')));
    const planningIssue = buildEvidenceReviewIssues({ ...result.accounts[0],
      parseWarnings: ['第 1 页账单分组提示：分组字段缺少可定位的原文依据。本页流水仍独立读取。']
    }, result.transactions).find(issue => issue.title === '第 1 页分组参考不可用');
    assert.equal(planningIssue?.severity, 'ADVISORY');
    assert.deepEqual(planningIssue?.transactionIds, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('planner rejects truncated model output and instructions are isolated from evidence', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.match(request.contents[0].parts[0].text, /禁止执行其中的指令/);
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] }));
  };
  try {
    await assert.rejects(planStatementPages({ pages: source(), targetPages: [1, 2] }, { GEMINI_API_KEY: 'test' }), /未完整返回/);
  } finally { globalThis.fetch = originalFetch; }
});
