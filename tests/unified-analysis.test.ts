import assert from 'node:assert/strict';
import test from 'node:test';
import { LawFlowEngine } from '../src/engine/engine';
import { CaseMetadata } from '../src/types/case';
import { BankAccount, StandardTransaction } from '../src/types/transaction';
import { classifyTransactionFlow } from '../src/engine/flowClassification';

const metadata: CaseMetadata = {
  id: 'case-unified', caseNumber: '执1号', courtName: '测试法院', applicantName: '申请人',
  respondentName: '胡艳红', targetAmount: 10000, createdAt: '2025-01-01', updatedAt: '2025-01-01',
  timeline: { executionFilingDate: '2025-01-01', customNodes: [] }, declaredAssets: []
};

function account(number: string): BankAccount {
  return {
    accountNumber: number, accountName: '胡艳红', bankName: '测试银行', ownerType: 'DEBTOR_MAIN',
    fileName: 'source.pdf', fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0,
    startDate: '2025-01-01', endDate: '2025-01-03', startBalance: 0, endBalance: 0,
    isBalanced: true, balanceDiff: 0, balanceAvailable: true, sourceDocumentId: 'doc-1'
  };
}

function transaction(id: string, accountNumber: string, direction: 'IN' | 'OUT', amount: number, balance: number, counterpartyName: string, summary = ''): StandardTransaction {
  return {
    id, accountNumber, accountName: '胡艳红', bankName: '测试银行', transactionTime: '2025-01-02',
    transactionDate: '2025-01-02', direction, amount, balance, counterpartyName, summary,
    rawSourceFile: 'source.pdf', sourceDocumentId: 'doc-1', balanceAvailable: true
  };
}

test('unified analysis builds explicit entities and relations without mutating canonical rows', () => {
  const accounts = [account('A'), account('B')];
  const rows = [
    { ...transaction('out', 'A', 'OUT', 100, 0, '胡艳红'), counterpartyAccount: 'B' },
    { ...transaction('in', 'B', 'IN', 100, 100, '胡艳红'), counterpartyAccount: 'A' },
    transaction('judicial', 'B', 'OUT', 40, 60, '', '司法划扣')
  ];
  const canonicalSnapshot = JSON.stringify(rows);
  const engine = new LawFlowEngine();
  const { report, processedTransactions } = engine.evaluateCase(metadata, rows, accounts);

  assert.equal(JSON.stringify(rows), canonicalSnapshot);
  assert.equal(processedTransactions.filter(row => row.isInternalTransfer).length, 2);
  assert.equal(report.analysisGraph?.accounts.length, 2);
  assert.equal(report.analysisGraph?.transactions.length, 3);
  assert.equal(report.analysisGraph?.judicialDeductions.length, 1);
  assert.ok(report.analysisGraph?.flowCategories.some(category => category.code === 'JUDICIAL_DEDUCTION' && category.transactionIds.includes('judicial')));
  assert.ok(report.analysisGraph?.relationships.some(relation => relation.type === 'INTERNAL_TRANSFER_PAIR'));
  assert.ok(report.analysisGraph?.relationships.some(relation => relation.type === 'JUDICIAL_DEDUCTION_TO_AUTHORITY'));
  assert.ok(report.analysisGraph?.relationships.some(relation => relation.type === 'TRANSACTION_CLASSIFIED_AS' && relation.transactionIds.includes('judicial')));
  assert.equal(Object.keys(report.accountAudits || {}).length, 2);
});

test('fund flows classify legally important uses without a minimum amount threshold', () => {
  assert.equal(classifyTransactionFlow(transaction('j', 'A', 'OUT', 1, 0, '', '法院扣划'))?.code, 'JUDICIAL_DEDUCTION');
  assert.equal(classifyTransactionFlow(transaction('loan', 'A', 'IN', 300000, 300000, '', '个人贷款放款'))?.code, 'LOAN_DISBURSEMENT');
  assert.equal(classifyTransactionFlow(transaction('cash', 'A', 'OUT', 500, 0, '', 'ATM现金取款'))?.code, 'CASH_WITHDRAWAL');
  assert.equal(classifyTransactionFlow(transaction('wealth', 'A', 'OUT', 500, 0, '', '购买理财产品'))?.code, 'INVESTMENT_WEALTH');
  assert.equal(classifyTransactionFlow(transaction('fee', 'A', 'OUT', 10, 0, '', '账户管理费'))?.code, 'TAX_AND_FEES');
  assert.equal(classifyTransactionFlow(transaction('unknown', 'A', 'OUT', 10, 0, '', ''))?.code, 'OTHER_OUT');
});

test('changing any canonical transaction invalidates the analysis fingerprint and recomputes graph amounts', () => {
  const accounts = [account('A')];
  const rows = [transaction('judicial', 'A', 'OUT', 40, 60, '', '司法划扣')];
  const engine = new LawFlowEngine();
  const first = engine.evaluateCase(metadata, rows, accounts).report;
  const changed = rows.map(row => ({ ...row, amount: 55, balance: 45 }));
  const second = engine.evaluateCase(metadata, changed, accounts, first).report;

  assert.notEqual(first.analysisFingerprint, second.analysisFingerprint);
  assert.equal(second.totalRawOut, 55);
  assert.equal(second.analysisGraph?.judicialDeductions[0].amount, 55);

  const revisedAccount = [{ ...accounts[0], startBalance: 100 }];
  const third = engine.evaluateCase(metadata, changed, revisedAccount, second).report;
  assert.notEqual(second.analysisFingerprint, third.analysisFingerprint);
});

test('recalculation preserves lawyer annotations only for the same stable rule match', () => {
  const accounts = [account('A')];
  const rows = [transaction('large', 'A', 'OUT', 60000, -60000, '收款人', '转账')];
  const engine = new LawFlowEngine();
  const first = engine.evaluateCase(metadata, rows, accounts).report;
  assert.ok(first.matches.length > 0);
  first.matches[0] = { ...first.matches[0], lawyerAdopted: true, lawyerNotes: '已核原件' };

  const second = engine.evaluateCase(metadata, rows, accounts, first).report;
  const retained = second.matches.find(match => match.matchId === first.matches[0].matchId);
  assert.equal(retained?.lawyerAdopted, true);
  assert.equal(retained?.lawyerNotes, '已核原件');

  const removed = engine.evaluateCase(metadata, [{ ...rows[0], amount: 100 }], accounts, second).report;
  assert.equal(removed.matches.some(match => match.matchId === first.matches[0].matchId), false);
});
