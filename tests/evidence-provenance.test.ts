import test from 'node:test';
import assert from 'node:assert/strict';
import { BankAccount, StandardTransaction } from '../src/types/transaction';
import { accountIdentityKey } from '../src/utils/accountIdentity';
import { attachSourceProvenance, createExtractionRun, identifySourceDocument, sourceIdentity } from '../src/utils/evidenceProvenance';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';

function account(fileName: string): BankAccount {
  return {
    accountNumber: '22255301100006216', accountName: '胡艳红', bankName: '四川农信',
    ownerType: 'DEBTOR_MAIN', fileName, fileType: 'pdf', totalIn: 0, totalOut: 10,
    transactionCount: 1, startDate: '2024-01-01', endDate: '2024-01-01',
    startBalance: 100, endBalance: 90, isBalanced: true, balanceDiff: 0
  };
}

function transaction(fileName: string): StandardTransaction {
  return {
    id: 'TX_GEMINI_1', accountNumber: '22255301100006216', accountName: '胡艳红', bankName: '四川农信',
    transactionTime: '2024-01-01', transactionDate: '2024-01-01', direction: 'OUT', amount: 10,
    balance: 90, counterpartyName: '', summary: '司法划扣', rawSourceFile: fileName,
    rawPageNumber: 3, rawRowIndex: 1, balanceAvailable: true,
    extractionConfidence: 0.95, extractionMethod: 'DOCUMENT_PDF'
  };
}

test('source identity is based on file contents rather than file name', async () => {
  const first = await identifySourceDocument(new File(['first'], '流水.pdf', { type: 'application/pdf' }));
  const sameContent = await identifySourceDocument(new File(['first'], '另一个名字.pdf', { type: 'application/pdf' }));
  const sameNameDifferentContent = await identifySourceDocument(new File(['second'], '流水.pdf', { type: 'application/pdf' }));

  assert.equal(first.documentId, sameContent.documentId);
  assert.notEqual(first.documentId, sameNameDifferentContent.documentId);
});

test('provenance creates source-scoped stable observations and account identities', async () => {
  const file = new File(['evidence'], '流水.pdf', { type: 'application/pdf' });
  const source = await identifySourceDocument(file);
  const first = attachSourceProvenance([account(file.name)], [transaction(file.name)], source, createExtractionRun(source.documentId));
  const second = attachSourceProvenance([account(file.name)], [transaction(file.name)], source, createExtractionRun(source.documentId));

  assert.equal(first.transactions[0].id, second.transactions[0].id);
  assert.equal(first.transactions[0].sourceObservationId, first.transactions[0].id);
  assert.equal(first.accounts[0].sourceContentHash, source.contentHash);
  assert.equal(sourceIdentity(first.accounts[0]), source.documentId);
  assert.equal(accountIdentityKey(first.accounts[0]), accountIdentityKey(first.transactions[0]));
});

test('normalization keeps observations from two source documents separate', async () => {
  const firstSource = await identifySourceDocument(new File(['statement-a'], '同名流水.pdf', { type: 'application/pdf' }));
  const secondSource = await identifySourceDocument(new File(['statement-b'], '同名流水.pdf', { type: 'application/pdf' }));
  const first = attachSourceProvenance(
    [account('同名流水.pdf')], [transaction('同名流水.pdf')], firstSource, createExtractionRun(firstSource.documentId)
  );
  const second = attachSourceProvenance(
    [account('同名流水.pdf')], [transaction('同名流水.pdf')], secondSource, createExtractionRun(secondSource.documentId)
  );
  const normalized = normalizeRecognizedData(
    [...first.accounts, ...second.accounts],
    [...first.transactions, ...second.transactions]
  );

  assert.equal(normalized.accounts.length, 2);
  assert.equal(normalized.transactions.length, 2);
  assert.equal(new Set(normalized.accounts.map(item => item.sourceDocumentId)).size, 2);
});

test('automatic corrections retain field-level original and suggested values', async () => {
  const file = new File(['judicial-deduction'], '司法划扣.pdf', { type: 'application/pdf' });
  const source = await identifySourceDocument(file);
  const base = transaction(file.name);
  const rows: StandardTransaction[] = [
    { ...base, id: 'before', rawRowIndex: 1, transactionTime: '2024-12-21', transactionDate: '2024-12-21', direction: 'IN', amount: 1.38, balance: 5456.73, summary: '结息' },
    { ...base, id: 'deduction', rawRowIndex: 2, transactionTime: '2025-02-25', transactionDate: '2025-02-25', amount: 197.97, balance: 3.47, summary: '司法划扣', rawText: '2025-02-25 OUT 197.97 司法划扣' },
    { ...base, id: 'after', rawRowIndex: 3, transactionTime: '2025-03-21', transactionDate: '2025-03-21', direction: 'IN', amount: 1, balance: 4.47, summary: '结息' }
  ];
  const judicialAccount = { ...account(file.name), startBalance: 5455.35, endBalance: 4.47 };
  const annotated = attachSourceProvenance([judicialAccount], rows, source, createExtractionRun(source.documentId));
  const normalized = normalizeRecognizedData(annotated.accounts, annotated.transactions);
  const deduction = normalized.transactions.find(item => item.rawRowIndex === 2)!;

  assert.equal(deduction.amount, 5453.26);
  assert.equal(deduction.fieldEvidence?.amount?.originalValue, 197.97);
  assert.equal(deduction.fieldEvidence?.amount?.currentValue, 5453.26);
  assert.equal(deduction.fieldEvidence?.amount?.decision, 'SUGGESTED');
  assert.match(deduction.fieldEvidence?.amount?.reason || '', /相邻余额关系/);
});
