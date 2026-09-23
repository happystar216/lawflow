import test from 'node:test';
import assert from 'node:assert/strict';
import type { BankAccount, StandardTransaction } from '../src/types/transaction';
import type { QwenChunkResult } from '../src/parsers/qwenResultMerger';
import type { MinerUPageCheckpoint } from '../src/parsers/mineruBankStatementParser';
import { preserveExtraction } from '../src/recognition/decisionPolicy';
import { reconcileDocumentIdentities, sourceValidationRisks, requireSourceCheck } from '../src/recognition/documentValidation';
import { resolveDocumentOwners } from '../src/recognition/documentOwners';
import { pageBankEvidence } from '../src/recognition/bankEvidence';
import { selectPageCandidate } from '../src/recognition/pageCandidates';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';
import { canonicalizeTransactionEvents } from '../src/engine/transactionEvents';
import { applyRowReviewDecision } from '../src/review/fieldReview';
import { requestStatementPlan } from '../src/recognition/statementPlanningClient';
import { normalizeMinerUDocumentByPage } from '../src/parsers/mineruBankStatementParser';
import { buildEvidenceReviewIssues } from '../src/review/buildEvidenceReviewIssues';

const full = '900000000000001', typo = '900000000000009';
function ledger(number = full, page = 1): QwenChunkResult {
  const account: BankAccount = { accountNumber: number, accountName: '测试户', bankName: '中国工商银行',
    ownerType: 'UNKNOWN', fileName: 'synthetic.pdf', fileType: 'pdf', totalIn: 30, totalOut: 0,
    transactionCount: 3, startDate: '', endDate: '', startBalance: 90, endBalance: 120, isBalanced: true, balanceDiff: 0 };
  return { account, accounts: [account], transactions: Array.from({ length: 3 }, (_, i) => preserveExtraction({
    id: `${page}-${i}`, accountNumber: number, accountName: '测试户', bankName: account.bankName,
    transactionTime: `2024-01-0${i + 1}`, transactionDate: `2024-01-0${i + 1}`, direction: 'IN', amount: 10,
    balance: 100 + i * 10, balanceAvailable: true, summary: '转账', counterpartyName: '',
    rawSourceFile: 'synthetic.pdf', sourceDocumentId: 'synthetic', rawPageNumber: page, rawRowIndex: i + 1,
    extractionConfidence: .99, reviewStatus: 'AUTO_PASSED'
  })), coveredPages: [page], pageStart: page, pageEnd: page, totalPages: 4, countComplete: true };
}
function checkpoint(result = ledger(), text = '中国工商银行'): MinerUPageCheckpoint {
  return { version: 1, page: result.pageStart!, source: { page: result.pageStart!, blocks: [{ order: 1, type: 'text', content: text }] },
    candidates: [{ route: 'MINERU', result: structuredClone(result) }], selected: result };
}

test('inventory plus corroborating ledger resolves a one-digit account error without erasing evidence', () => {
  const a = ledger(typo), b = ledger(full, 3);
  const before = structuredClone([a, b]);
  const result = reconcileDocumentIdentities([a, b], [{ account: b.account, page: 2 }]);
  assert.deepEqual([a, b], before);
  assert.ok(result[0].transactions.every(row => row.accountNumber === full && row.reviewStatus === 'PENDING'));
  assert.equal(result[0].transactions[0].fieldEvidence?.accountNumber?.originalValue, typo);
  assert.deepEqual(result[0].transactions[0].candidateReview?.differences.map(item => item.field), ['accountNumber']);
  const normalized = normalizeRecognizedData(result.flatMap(item => item.accounts!), result.flatMap(item => item.transactions));
  assert.equal(normalized.transactions.length, 6);
  assert.equal(normalized.transactions.filter(row => row.excludedFromAnalysis).length, 3);
  assert.equal(canonicalizeTransactionEvents(normalized.transactions).canonicalTransactions.length, 3);
  const hiddenObservation = { ...normalized.transactions[0], excludedFromAnalysis: true };
  assert.ok(buildEvidenceReviewIssues(normalized.accounts[0], [hiddenObservation])
    .some(issue => issue.category === 'CANDIDATE_CONFLICT' && issue.transactionIds.includes(hiddenObservation.id)),
  'deduplicating an observation cannot silently confirm its account identity');
});

test('explicit receipt account/card labels remain usable when planning omitted all accounts', () => {
  const card = '800000000000004';
  const receipt = ledger(); receipt.transactions = [];
  receipt.pageQuality = [{ page: 1, expectedCount: 0, extractedCount: 0, status: 'COMPLETE', pageType: 'DOCUMENT' }];
  const source = checkpoint(receipt, `中国工商银行\n户名：测试户\n账号：${full}\n对应卡号：${card}`);
  const rows = ledger(card, 2);
  const result = resolveDocumentOwners([source, checkpoint(rows)]);
  assert.ok(result[1].transactions.every(row => row.accountNumber === full));
  assert.equal(result[1].transactions[0].fieldEvidence?.accountNumber?.originalValue, card);
  assert.match(result[1].transactions[0].fieldEvidence?.accountNumber?.reason || '', /对应卡号/);
  const misleading = checkpoint(receipt, `对方账号：${full}\n对应卡号：${card}`);
  assert.equal(resolveDocumentOwners([misleading, checkpoint(rows)])[1].transactions[0].accountNumber, card);
});

test('more rows in a PDF rereading do not displace an intact text candidate', () => {
  const primary = ledger(), recovery = ledger();
  recovery.transactions.push({ ...recovery.transactions[0], id: 'spurious', rawRowIndex: 4 });
  const selected = selectPageCandidate(primary, recovery, 1);
  assert.equal(selected.transactions.length, 3);
  assert.equal(selected.countComplete, false);
  assert.match(selected.warnings?.join('') || '', /清点原件行数/);
});

test('inventoried long and short numbers align candidates on a multi-owner page without rewriting fields', () => {
  const a = ledger('9000000000001'), b = ledger('9000000000002', 2);
  a.transactions.push(...b.transactions);
  const recovery = structuredClone(a);
  const aliases = new Map([['9000000000001', '119000000000001'], ['9000000000002', '119000000000002']]);
  recovery.transactions.forEach(row => row.accountNumber = aliases.get(row.accountNumber)!);
  recovery.transactions[0].balance += .01;
  const selected = selectPageCandidate(a, recovery, 1, false, aliases);
  assert.deepEqual(selected.transactions[0].candidateReview?.differences.map(item => item.field), ['balance']);
  assert.ok(selected.transactions.slice(1).every(row => !row.candidateReview));
  assert.equal(selected.transactions[0].accountNumber, '9000000000001');
});

test('unusable rereading cannot turn an inventoried complete ledger into all-row review', () => {
  const receipt = ledger(full, 1); receipt.transactions = [];
  receipt.pageQuality = [{ page: 1, expectedCount: 0, extractedCount: 0, status: 'COMPLETE', pageType: 'ACCOUNT_INFO' }];
  const source = checkpoint(receipt, `中国工商银行\n账号：${full}`);
  const primary = ledger(full, 2); primary.transactions[0].balance += .02;
  const page = checkpoint(primary);
  const recovery = ledger(typo, 2);
  page.candidates.push({ route: 'ORIGINAL_PDF', result: recovery });
  const before = structuredClone(page.candidates);
  const result = resolveDocumentOwners([source, page])[1];
  assert.equal(result.transactions.length, 3);
  assert.equal(result.transactions[0].balance, 100.02);
  assert.equal(result.transactions.filter(row => row.reviewStatus === 'PENDING').length, 2);
  assert.match(result.warnings?.join('') || '', /本次复读未被采纳/);
  assert.deepEqual(page.candidates, before);
});

test('similar digits never merge without inventory, repeated evidence, unique target and matching source/holder', () => {
  for (const mode of ['noInventory', 'oneRow', 'otherHolder', 'otherFile', 'bothListed', 'manual', 'ambiguous'] as const) {
    const a = ledger(typo), b = ledger(full, 3), c = ledger('900000000000008', 4);
    let inventory = [{ account: b.account, page: 2 }];
    let inputs = [a, b];
    if (mode === 'noInventory') inventory = [];
    if (mode === 'oneRow') a.transactions = a.transactions.slice(0, 1);
    if (mode === 'otherHolder') a.transactions.forEach(row => row.accountName = '另一个人');
    if (mode === 'otherFile') a.transactions.forEach(row => row.sourceDocumentId = 'other');
    if (mode === 'bothListed') inventory.push({ account: a.account, page: 2 });
    if (mode === 'manual') a.transactions[0].reviewStatus = 'VERIFIED';
    if (mode === 'ambiguous') { inputs.push(c); inventory.push({ account: c.account, page: 2 }); }
    assert.equal(reconcileDocumentIdentities(inputs, inventory)[0].transactions[0].accountNumber, typo, mode);
  }
});

test('cent-level discontinuity triggers the two specific source rows without rewriting numbers', () => {
  const page = checkpoint(); page.selected.transactions[0].balance += .02;
  const before = structuredClone(page);
  const risk = sourceValidationRisks([page]).get(1)!;
  assert.deepEqual([...risk.keys()], ['1-0', '1-1']);
  assert.match(risk.get('1-0')!, /0.02/);
  assert.deepEqual(page, before);
  const result = resolveDocumentOwners([page])[0];
  assert.equal(result.transactions[0].balance, 100.02);
  assert.equal(result.transactions[0].reviewStatus, 'PENDING');
  assert.equal(result.transactions[2].reviewStatus, 'AUTO_PASSED');
  const normalized = normalizeRecognizedData(result.accounts!, result.transactions);
  assert.equal(normalized.accounts[0].isBalanced, false);
});

test('reverse printed rows and different accounts do not generate false balance checks', () => {
  const page = checkpoint();
  page.selected.transactions.reverse().forEach((row, index) => row.rawRowIndex = index + 1);
  assert.equal(sourceValidationRisks([page]).size, 0);
  page.selected.transactions[0].accountNumber = typo;
  page.selected.transactions[0].balance = 999;
  assert.equal(sourceValidationRisks([page]).size, 0);
});

test('source check accepts precisely the requested fields, and a partial decision remains pending', () => {
  const row = ledger().transactions[0];
  requireSourceCheck(row, ['amount', 'balance'], '请核对金额和余额');
  assert.equal(applyRowReviewDecision(row, ['amount'], 'ACCEPT_CURRENT').candidateReview?.status, 'PENDING');
  assert.equal(applyRowReviewDecision(row, ['amount', 'balance'], 'ACCEPT_CURRENT').candidateReview?.status, 'CONFIRMED');
  requireSourceCheck(row, ['accountNumber'], '还需确认本方账号');
  assert.equal(applyRowReviewDecision(row, ['amount', 'balance'], 'ACCEPT_CURRENT').candidateReview?.status, 'PENDING');
  assert.equal(applyRowReviewDecision(row, ['amount', 'balance', 'accountNumber'], 'ACCEPT_CURRENT').candidateReview?.status, 'CONFIRMED');
});

test('bank headers survive planner failure; counterparties and filenames never establish own bank', () => {
  assert.equal(pageBankEvidence(checkpoint(ledger(), 'ICBC 中国工商银行')), '中国工商银行');
  assert.equal(pageBankEvidence(checkpoint(ledger(), '中国光大银行交易明细')), '中国光大银行');
  assert.equal(pageBankEvidence(checkpoint(ledger(), '网点名称：工行四川省绵阳高新技术产业开发支行')), '中国工商银行');
  assert.equal(pageBankEvidence(checkpoint(ledger(), '开户机构：中国民生银行股份有限公司三亚凤凰路支行')), '中国民生银行');
  assert.equal(pageBankEvidence(checkpoint(ledger(), '对方开户行：中国建设银行')), undefined);
  assert.equal(pageBankEvidence(checkpoint(ledger(), '<table><tr><td>对方银行</td><td>中国银行</td></tr></table>')), undefined);
  assert.equal(pageBankEvidence(checkpoint(ledger(), '调查令：中国工商银行')), undefined);
  const original = checkpoint(ledger(), 'OCR 未读出抬头');
  original.candidates.push({ route: 'ORIGINAL_PDF', result: ledger() });
  assert.equal(pageBankEvidence(original), undefined, 'a bank guessed by the PDF model is not a printed header');
  original.candidates[1].result.accounts![0].accountNumber = typo;
  assert.equal(pageBankEvidence(original), undefined);
});

test('unique single-owner date isolates account disagreement without adopting the other reading', () => {
  const selected = selectPageCandidate(ledger(typo), ledger(full), 1);
  assert.equal(selected.transactions[0].accountNumber, typo);
  assert.deepEqual(selected.transactions[0].candidateReview?.differences, [{ field: 'accountNumber', selected: typo, alternative: full }]);
});

test('repeated observations on the same physical page are not discarded as duplicates', () => {
  const a = ledger();
  const duplicate: StandardTransaction = { ...a.transactions[0], id: 'legitimate-repeat', rawRowIndex: 4 };
  const result = normalizeRecognizedData(a.accounts!, [...a.transactions, duplicate]);
  assert.equal(result.transactions.filter(row => row.excludedFromAnalysis).length, 0);
});

test('one malformed planning batch does not disable later batches of a long file', async () => {
  const original = globalThis.fetch; const called: number[] = [];
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)); called.push(input.targetPages[0]);
    if (input.targetPages[0] === 1) return new Response(JSON.stringify({ error: '账单分组结果未完整返回' }), { status: 502 });
    return new Response(JSON.stringify({ pages: input.targetPages.map((page: number) => ({ page, type: 'BLANK', bank: null,
      accounts: [], headers: [], continuation: [], relation: 'START', confidence: .99 })) }));
  };
  try {
    const pages = await requestStatementPlan(Array.from({ length: 32 }, (_, i) => ({ page: i + 1, blocks: [] })));
    assert.deepEqual(new Set(called), new Set([1, 5, 9, 17, 25]));
    assert.ok(pages.slice(8).every(page => page.type === 'BLANK'));
    assert.ok(pages.slice(0, 4).every(page => page.type === 'UNKNOWN'));
    assert.ok(pages.slice(4, 8).every(page => page.type === 'BLANK'));
  } finally { globalThis.fetch = original; }
});

test('complete OCR table with a two-cent error invokes original PDF and preserves the conflicting field', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create(); pdf.addPage();
  const file = new File([Uint8Array.from(await pdf.save()).buffer], 'synthetic.pdf', { type: 'application/pdf' });
  const originalFetch = globalThis.fetch;
  const requests: string[] = []; const checkpoints: MinerUPageCheckpoint[] = []; const progress: number[] = [];
  globalThis.fetch = async url => {
    requests.push(String(url));
    const result = ledger();
    if (String(url) === '/api/normalize-mineru-result') {
      result.transactions[0].balance += .02;
      return new Response(JSON.stringify({ accounts: [{ ac: full, holder: '测试户', bk: '中国工商银行', p: 1, cf: .99 }],
        transactions: result.transactions.map(row => ({ p: 1, r: row.rawRowIndex, ac: full, holder: row.accountName,
          bk: row.bankName, tm: row.transactionTime, dir: row.direction, amt: row.amount, bal: row.balance, sm: row.summary, cf: .99 })),
        pageChecks: [{ p: 1, type: 'TRANSACTIONS', extracted: 3, status: 'COMPLETE' }], warnings: [] }));
    }
    assert.equal(String(url), '/api/parse-bank-statement-stream');
    result.pageQuality = [{ page: 1, expectedCount: 3, extractedCount: 3, status: 'COMPLETE', pageType: 'TRANSACTIONS' }];
    return new Response(`data: ${JSON.stringify({ type: 'complete', ...result })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const result = await normalizeMinerUDocumentByPage(file, { pages: [{ page: 1, text: '中国工商银行' }],
      blocks: [{ page: 1, type: 'text', text: '中国工商银行' }] }, 'synthetic.pdf', '测试户', 1,
      item => progress.push(item.percent), undefined, item => checkpoints.push(structuredClone(item)));
    assert.deepEqual(requests, ['/api/normalize-mineru-result', '/api/parse-bank-statement-stream']);
    assert.equal(progress.at(-1), 99);
    assert.ok(progress.slice(0, -1).every(percent => percent <= 90),
      'page completion and focused rereading must not show 99% throughout the page stage');
    assert.equal(checkpoints.at(-1)?.sourceValidation?.status, 'COMPARED');
    const first = result.transactions.find(row => row.rawRowIndex === 1)!;
    assert.equal(first.reviewStatus, 'PENDING');
    assert.ok(first.candidateReview?.differences.some(item => item.field === 'balance' && item.selected === 100.02 && item.alternative === 100));
    assert.equal(first.balance, 100.02, 'do not silently force the ledger to balance');
  } finally { globalThis.fetch = originalFetch; }
});
