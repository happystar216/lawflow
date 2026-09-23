import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDocumentOwners } from '../src/recognition/documentOwners';
import type { MinerUPageCheckpoint } from '../src/parsers/mineruBankStatementParser';
import { preserveExtraction } from '../src/recognition/decisionPolicy';
import type { BankAccount, StandardTransaction } from '../src/types/transaction';
import { unknownStatementPage } from '../src/recognition/statementPlan';

function fixture(numbers = ['119000000000001', '119000000000002']): MinerUPageCheckpoint[] {
  const account = (number: string): BankAccount => ({ accountNumber: number, accountName: '测试户名', bankName: '甲银行',
    ownerType: 'DEBTOR_MAIN', fileName: 'test.pdf', fileType: 'pdf', totalIn: 0, totalOut: 0,
    transactionCount: 0, startDate: '', endDate: '', startBalance: 0, endBalance: 0, isBalanced: false, balanceDiff: 0 });
  const row: StandardTransaction = preserveExtraction({
    id: 'row', accountNumber: '9000000000001', accountName: '测试户名', bankName: '甲银行',
    transactionDate: '2024-01-01', transactionTime: '2024-01-01', direction: 'IN', amount: 10, balance: 100,
    counterpartyName: '', summary: '', rawSourceFile: 'test.pdf', rawPageNumber: 2, rawRowIndex: 1
  });
  return [1, 2].map(page => ({ version: 1, page,
    source: { page, blocks: [{ order: 1, type: 'text', content: page === 1 ? numbers.join(' ') : '流水' }] },
    candidates: [], selected: { account: account(page === 1 ? numbers[0] : row.accountNumber),
      accounts: page === 1 ? numbers.map(account) : [account(row.accountNumber)], transactions: page === 1 ? [] : [row],
      coveredPages: [page], pageStart: page, pageEnd: page, totalPages: 2,
      pageQuality: [{ page, expectedCount: page === 1 ? 0 : 1, extractedCount: page === 1 ? 0 : 1,
        status: 'COMPLETE', pageType: page === 1 ? 'ACCOUNT_LIST' : 'TRANSACTIONS' }]
    }
  }));
}

test('document identity resolution requires a unique printed account inventory and preserves original evidence', () => {
  const input = fixture();
  const before = structuredClone(input);
  const output = resolveDocumentOwners(input);
  const row = output[1].transactions[0];
  assert.equal(row.accountNumber, '119000000000001');
  assert.equal(row.fieldEvidence?.accountNumber?.originalValue, '9000000000001');
  assert.equal(row.fieldEvidence?.accountNumber?.decision, 'SUGGESTED');
  assert.deepEqual(input, before);
});

test('ambiguous suffixes or unsupported inventory values cannot change identity', () => {
  const ambiguous = fixture(['119000000000001', '229000000000001']);
  assert.equal(resolveDocumentOwners(ambiguous)[1].transactions[0].accountNumber, '9000000000001');
  const invented = fixture();
  invented[0].source.blocks[0].content = '原件没有这些账号';
  assert.equal(resolveDocumentOwners(invented)[1].transactions[0].accountNumber, '9000000000001');
});

test('contradictory institution names become explicit review rather than silently winning', () => {
  const input = fixture();
  for (const [index, bank] of ['甲银行', '乙银行'].entries()) {
    input[index].source.blocks[0].content += ` 开户银行：${bank}`;
    input[index].statement = { descriptor: { ...unknownStatementPage(index + 1, ''),
      bank: { value: bank, evidence: { page: index + 1, block: 1, quote: `开户银行：${bank}` } } },
      group: { id: `g${index}`, pages: [index + 1], bank, accounts: [], needsReview: false } };
  }
  input[1].selected.transactions[0].bankName = '乙银行';
  const result = resolveDocumentOwners(input);
  assert.equal(result[1].transactions[0].bankName, '待核验银行');
  assert.match(result[1].warnings?.join('') || '', /银行名称.*不一致/);
});

test('an unsupported bank guess is not adopted even when it matches the filename', () => {
  const input = fixture();
  const output = resolveDocumentOwners(input);
  assert.equal(output[1].transactions[0].bankName, '待核验银行');
  assert.equal(output[0].accounts?.[0].bankName, '待核验银行');
  assert.match(output[1].warnings?.join('') || '', /缺少可定位的原文依据/);
  assert.equal(input[1].selected.transactions[0].bankName, '甲银行');
});

test('a forged bank quote is rejected, while a source-backed inventory bank can follow an exact account link', () => {
  const input = fixture();
  input[0].statement = { descriptor: { ...unknownStatementPage(1, ''),
    bank: { value: '甲银行', evidence: { page: 1, block: 1, quote: '开户银行：甲银行' } } },
    group: { id: 'g', pages: [1], bank: '甲银行', accounts: [], needsReview: false } };
  assert.equal(resolveDocumentOwners(input)[1].transactions[0].bankName, '待核验银行');
  input[0].source.blocks[0].content += ' 开户银行：甲银行';
  assert.equal(resolveDocumentOwners(input)[1].transactions[0].bankName, '甲银行');
});
