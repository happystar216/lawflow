import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateInternalNetting } from '../src/engine/netting';
import { auditAccountBalance } from '../src/parsers/sanityChecker';
import { parseExcelBankStatement } from '../src/parsers/excelParser';
import { Rule10_UndisclosedReceivables } from '../src/engine/rules/Rule10_UndisclosedReceivables';
import { Rule11_FalseAssetDeclaration } from '../src/engine/rules/Rule11_FalseAssetDeclaration';
import { Rule05_FabricatedRemarksBilateral } from '../src/engine/rules/Rule05_FabricatedRemarksBilateral';
import { Rule08_WealthInsuranceTransfer } from '../src/engine/rules/Rule08_WealthInsuranceTransfer';
import { BankAccount, StandardTransaction } from '../src/types/transaction';
import { CaseMetadata } from '../src/types/case';

const account = (number: string, ownerType: BankAccount['ownerType'] = 'DEBTOR_MAIN'): BankAccount => ({
  accountNumber: number,
  accountName: ownerType === 'DEBTOR_MAIN' ? '张三' : '李四',
  bankName: '测试银行',
  ownerType,
  fileName: `${number}.xlsx`,
  fileType: 'excel',
  totalIn: 0,
  totalOut: 0,
  transactionCount: 0,
  startDate: '2024-01-01',
  endDate: '2024-12-31',
  startBalance: 0,
  endBalance: 0,
  isBalanced: false,
  balanceDiff: 0,
  balanceAvailable: true
});

const tx = (id: string, accountNumber: string, direction: 'IN' | 'OUT', amount: number, counterpartyName: string, summary = ''): StandardTransaction => ({
  id,
  accountNumber,
  accountName: '张三',
  bankName: '测试银行',
  transactionTime: '2024-03-01',
  transactionDate: '2024-03-01',
  direction,
  amount,
  balance: 0,
  counterpartyName,
  summary,
  rawSourceFile: 'test.xlsx'
});

const caseMeta = (declaredAssets: CaseMetadata['declaredAssets'] = []): CaseMetadata => ({
  id: 'case-1',
  caseNumber: '(2024)测执1号',
  courtName: '测试法院',
  applicantName: '申请人',
  respondentName: '张三',
  targetAmount: 100000,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  timeline: {
    executionFilingDate: '2024-01-01',
    reportOrderServedDate: '2024-02-01',
    freezeDate: '2024-02-10',
    customNodes: []
  },
  declaredAssets
});

test('internal netting requires a debtor-owned, opposite-side pair', () => {
  const accounts = [account('A'), account('B'), account('S', 'SPOUSE')];
  const transactions = [
    { ...tx('out', 'A', 'OUT', 1000, '张三'), counterpartyAccount: 'B' },
    { ...tx('in', 'B', 'IN', 1000, '张三'), counterpartyAccount: 'A' },
    { ...tx('spouse', 'A', 'OUT', 2000, '李四'), counterpartyAccount: 'S' },
    { ...tx('unmatched', 'A', 'OUT', 3000, '张三'), counterpartyAccount: 'B' }
  ];

  const result = calculateInternalNetting(transactions, accounts);
  assert.equal(result.internalCount, 2);
  assert.equal(result.internalTotalAmount, 1000);
  assert.equal(result.processedTransactions.find(item => item.id === 'spouse')?.isInternalTransfer, undefined);
  assert.equal(result.processedTransactions.find(item => item.id === 'unmatched')?.isInternalTransfer, undefined);
});

test('balance audit reports a real difference and distinguishes unavailable balances', () => {
  const available = { ...account('A'), startBalance: 100, endBalance: 50 };
  const report = auditAccountBalance(available, [tx('out', 'A', 'OUT', 25, '甲')]);
  assert.equal(report.isAuditable, true);
  assert.equal(report.isBalanced, false);
  assert.equal(report.difference, 25);

  const unavailable = auditAccountBalance({ ...available, balanceAvailable: false }, []);
  assert.equal(unavailable.isAuditable, false);
  assert.equal(unavailable.isBalanced, false);
});

test('CSV parsing preserves quoted fields and derives the opening balance', async () => {
  const csv = [
    '交易日期,支出,存入,余额,对方户名,摘要',
    '2024-01-01,100,,900,"甲,公司",服务费',
    '2024-01-02,,200,1100,乙公司,回款'
  ].join('\n');
  const file = new File([csv], '流水.csv', { type: 'text/csv' });
  const parsed = await parseExcelBankStatement(file);
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[0].counterpartyName, '甲,公司');
  assert.equal(parsed.account.startBalance, 1000);
  assert.equal(parsed.account.endBalance, 1100);
  assert.equal(auditAccountBalance(parsed.account, parsed.transactions).isBalanced, true);
});

test('receivable rule excludes repayment remarks and leaves matches unadopted', () => {
  const rule = new Rule10_UndisclosedReceivables();
  const context = {
    caseMeta: caseMeta(),
    allTransactions: [
      tx('repay', 'A', 'OUT', 50000, '李四', '还借款'),
      tx('lend', 'A', 'OUT', 50000, '王五', '借出款')
    ],
    counterpartySummaries: {}
  };

  const matches = rule.evaluate(context);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].transactionIds[0], 'lend');
  assert.equal(matches[0].lawyerAdopted, false);
  assert.match(matches[0].aiReasoning, /可能/);
});

test('repayment remarks always create a lawyer verification task', () => {
  const rule = new Rule05_FabricatedRemarksBilateral();
  const matches = rule.evaluate({
    caseMeta: caseMeta(),
    allTransactions: [tx('repay', 'A', 'OUT', 50000, '李四', '还借款')],
    counterpartySummaries: {}
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].verificationStatus, 'PENDING');
  assert.ok((matches[0].verificationChecklist || []).length >= 5);
  assert.match(matches[0].aiReasoning, /必须由律师核验/);
});

test('insurance purchased before account freeze remains an asset clue', () => {
  const rule = new Rule08_WealthInsuranceTransfer();
  const insurance = { ...tx('policy', 'A', 'OUT', 80000, '中国平安人寿保险股份有限公司', '年金保险趸交保费'), transactionDate: '2024-01-05' };
  const matches = rule.evaluate({ caseMeta: caseMeta(), allTransactions: [insurance], counterpartySummaries: {} });
  assert.equal(matches.length, 1);
  assert.match(matches[0].timePhase, /冻结前/);
  assert.match(matches[0].aiReasoning, /现金价值/);
  assert.ok((matches[0].verificationChecklist || []).some(item => item.includes('投保人')));
});

test('false-report rule requires an actual declaration and uses current article numbering', () => {
  const rule = new Rule11_FalseAssetDeclaration();
  const income = tx('income', 'A', 'IN', 20000, '公司', '工资');
  assert.equal(rule.evaluate({ caseMeta: caseMeta(), allTransactions: [income], counterpartySummaries: {} }).length, 0);

  const matches = rule.evaluate({
    caseMeta: caseMeta([{ id: 'd1', category: 'income', declaredContent: '无收入', declaredValue: 0 }]),
    allTransactions: [income],
    counterpartySummaries: {}
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].lawyerAdopted, false);
  assert.match(matches[0].statutoryBasis[0], /第252条/);
});
