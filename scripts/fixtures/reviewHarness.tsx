// Synthetic UI fixture only. Not imported by the application or production build.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Step2Verify } from '../../src/components/Step2Verify';
import type { BankAccount, StandardTransaction } from '../../src/types/transaction';
import '../../src/index.css';

const account = (number: string, document = 'A'): BankAccount => ({
  accountNumber: number, accountName: '测试户名', bankName: '测试银行', ownerType: 'DEBTOR_MAIN',
  fileName: `${document}.pdf`, sourceDocumentId: document, fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0,
  startDate: '', endDate: '', startBalance: 50, endBalance: 50, balanceDiff: 0, isBalanced: true
});
const owners = [account('90000001'), account('90000002'), account('90000003', 'B'), { ...account('90000004'), bankName: '待核验银行' }];
const rows: StandardTransaction[] = owners.slice(0, 3).map((owner, index) => ({
  id: `row-${index}`, accountNumber: owner.accountNumber, accountName: owner.accountName, bankName: owner.bankName,
  rawSourceFile: owner.fileName, sourceDocumentId: owner.sourceDocumentId, rawPageNumber: 3, rawRowIndex: index + 1,
  transactionTime: '2024-01-01', transactionDate: '2024-01-01', direction: 'IN', amount: index === 1 ? 0 : 1,
  balance: 50, balanceAvailable: true, counterpartyName: '', summary: '结息', recognitionPolicy: 'EVIDENCE_ONLY_V1',
  reviewStatus: 'PENDING', dataQualityIssues: index === 1 ? ['INVALID_AMOUNT'] : [],
  candidateReview: { kind: index === 1 ? 'SOURCE_CHECK' : 'FIELD_CONFLICT', reason: index === 1 ? '原页金额未读清，请核对金额；原件确为零时可以填写 0。' : undefined,
    status: 'PENDING', differences: index === 1
    ? [{ field: 'amount', selected: 0, alternative: 1 }] : [{ field: 'balance', selected: 50, alternative: 60 }] }
}));
function Harness() {
  const removal = new URLSearchParams(location.search).has('removal');
  const [accounts, setAccounts] = useState(removal
    ? [{ ...owners[0], parseWarnings: ['第 3 页页面计数为 1 笔，逐笔提取为 2 笔'] }] : owners);
  const [transactions, setTransactions] = useState<StandardTransaction[]>(removal ? [
    { ...rows[0], candidateReview: undefined, reviewStatus: 'AUTO_PASSED' },
    { ...rows[0], id: 'duplicate-test', rawRowIndex: 2, balance: 51, candidateReview: undefined, reviewStatus: 'AUTO_PASSED' }
  ] : rows);
  (window as any).__REVIEW_TEST__ = { accounts, transactions };
  return <Step2Verify caseId="synthetic-review-test" accounts={accounts} transactions={transactions}
    onAccountsUpdated={setAccounts} onTransactionsUpdated={setTransactions} onNext={() => {}} onPrev={() => {}} />;
}
createRoot(document.getElementById('root')!).render(<Harness />);
