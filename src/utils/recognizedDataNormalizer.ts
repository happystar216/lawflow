import { BankAccount, StandardTransaction } from '../types/transaction';
import { accountIdentityKey, isReliableAccountNumber, normalizeAccountIdentityPart } from './accountIdentity';
import { balanceContinuityIssues } from './transactionSequence';

export interface NormalizedRecognizedData {
  accounts: BankAccount[];
  transactions: StandardTransaction[];
}

export function normalizeRecognizedData(
  inputAccounts: BankAccount[], inputTransactions: StandardTransaction[]
): NormalizedRecognizedData {
  const transactions = stabilizePageAccountIdentities(inputTransactions);
  const transactionsByAccount = new Map<string, StandardTransaction[]>();
  for (const transaction of transactions) {
    const key = accountIdentityKey(transaction);
    transactionsByAccount.set(key, [...(transactionsByAccount.get(key) || []), transaction]);
  }

  const sourceAccounts = new Map<string, BankAccount[]>();
  for (const account of inputAccounts.filter(account => !isDocumentReviewAccount(account))) {
    const key = accountIdentityKey(account);
    sourceAccounts.set(key, [...(sourceAccounts.get(key) || []), account]);
  }

  const allWarnings = [...new Set(inputAccounts.flatMap(account => account.parseWarnings || []))]
    .filter(warning => !isLegacyDerivedWarning(warning));
  const pageWarnings = allWarnings.filter(warning => warningPage(warning));
  const unscopedWarnings = allWarnings.filter(warning => !warningPage(warning));
  const coveredWarningSet = new Set<string>();
  const keys = new Set([...transactionsByAccount.keys(), ...sourceAccounts.keys()]);
  const accounts: BankAccount[] = [];

  for (const key of keys) {
    const accountTransactions = [...(transactionsByAccount.get(key) || [])].sort(compareSourceOrder);
    const originals = sourceAccounts.get(key) || [];
    if (!accountTransactions.length) continue;
    const pages = [...new Set(accountTransactions.map(item => item.rawPageNumber).filter((page): page is number => Boolean(page)))].sort((a, b) => a - b);
    const pageSet = new Set(pages);
    const parseWarnings = pageWarnings.filter(warning => {
      const page = warningPage(warning);
      if (!page || !pageSet.has(page)) return false;
      coveredWarningSet.add(warning);
      return true;
    });
    const representative = bestOriginal(originals) || minimalAccount(accountTransactions[0]);
    const bankName = mostFrequent(accountTransactions.map(item => item.bankName).filter(isUsefulBankName))
      || representative.bankName || '待核验银行';
    const accountName = cleanAccountHolderName(mostFrequent(accountTransactions.map(item => item.accountName)) || representative.accountName);
    const totalIn = sum(accountTransactions.filter(item => item.direction === 'IN').map(item => item.amount));
    const totalOut = sum(accountTransactions.filter(item => item.direction === 'OUT').map(item => item.amount));
    const dates = accountTransactions.map(item => item.transactionDate).filter(Boolean).sort();
    const reviewIssues = [...new Map(originals.flatMap(item => item.reviewIssues || []).map(issue => [issue.id, issue])).values()];
    const hasDerivedIssues = accountTransactions.some(item => (item.extractionConfidence ?? 1) < 0.8
      || item.amount <= 0 || !item.transactionDate || item.direction === 'UNKNOWN')
      || balanceContinuityIssues(accountTransactions).length > 0;
    accounts.push({
      ...representative,
      accountNumber: accountTransactions[0].accountNumber,
      accountName,
      bankName,
      ownerType: preferredOwnerType(originals),
      fileName: accountTransactions[0].rawSourceFile,
      totalIn, totalOut, transactionCount: accountTransactions.length,
      startDate: dates[0] || '', endDate: dates[dates.length - 1] || '',
      parseWarnings, coveredPages: pages,
      parseStatus: parseWarnings.length || hasDerivedIssues ? 'NEEDS_REVIEW' : 'COMPLETE',
      balanceContinuityIssueCount: balanceContinuityIssues(accountTransactions).length,
      reviewIssues
    });
  }

  const orphanWarnings = pageWarnings.filter(warning => !coveredWarningSet.has(warning));
  const documentWarnings = [...new Set([...unscopedWarnings, ...orphanWarnings])];
  if (documentWarnings.length) {
    const existing = inputAccounts.find(isDocumentReviewAccount);
    const sourceFile = existing?.fileName || transactions[0]?.rawSourceFile || inputAccounts[0]?.fileName || '';
    accounts.push({
      ...(existing || minimalDocumentAccount(sourceFile)),
      accountNumber: `待归属页面-${sourceFile}`, accountName: '待归属页面', bankName: '待核对', ownerType: 'UNKNOWN',
      fileName: sourceFile, transactionCount: 0, totalIn: 0, totalOut: 0,
      parseStatus: 'NEEDS_REVIEW', parseWarnings: documentWarnings,
      coveredPages: [...new Set(orphanWarnings.map(warningPage).filter((page): page is number => Boolean(page)))].sort((a, b) => a - b)
    });
  }
  return { accounts, transactions };
}

export function cleanAccountHolderName(value: string): string {
  return (value || '未知户名')
    .replace(/\.(pdf|xlsx?|csv)$/i, '')
    .replace(/(?:银行)?流水(?:合并)?$/u, '')
    .trim() || '未知户名';
}

function stabilizePageAccountIdentities(input: StandardTransaction[]): StandardTransaction[] {
  const transactions = input.map(transaction => ({ ...transaction }));
  const pages = new Map<number, StandardTransaction[]>();
  for (const transaction of transactions) {
    if (!transaction.rawPageNumber) continue;
    pages.set(transaction.rawPageNumber, [...(pages.get(transaction.rawPageNumber) || []), transaction]);
  }
  for (const [page, pageTransactions] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
    const reliable = pageTransactions.filter(item => isReliableAccountNumber(item.accountNumber));
    const reliableKeys = new Set(reliable.map(accountNumberKey));
    if (reliableKeys.size === 1) {
      const identity = reliable[0];
      for (const transaction of pageTransactions.filter(item => !isReliableAccountNumber(item.accountNumber))) copyIdentity(transaction, identity);
      continue;
    }
    const allUnique = reliable.length === pageTransactions.length
      && new Set(reliable.map(accountNumberKey)).size === reliable.length;
    if (!allUnique || pageTransactions.length < 2) continue;
    const previous = [...transactions].reverse().find(item => (item.rawPageNumber || 0) < page && isReliableAccountNumber(item.accountNumber));
    const next = transactions.find(item => (item.rawPageNumber || 0) > page && isReliableAccountNumber(item.accountNumber));
    if (previous && next && accountNumberKey(previous) === accountNumberKey(next)) {
      for (const transaction of pageTransactions) copyIdentity(transaction, previous);
    }
  }
  return transactions;
}

function copyIdentity(target: StandardTransaction, source: StandardTransaction): void {
  target.accountNumber = source.accountNumber;
  target.accountName = source.accountName;
  target.bankName = source.bankName;
}

function accountNumberKey(value: Pick<StandardTransaction, 'accountNumber'>): string {
  return normalizeAccountIdentityPart(value.accountNumber);
}

function isDocumentReviewAccount(account: BankAccount): boolean {
  return account.ownerType === 'UNKNOWN' && (/待归属页面/.test(account.accountNumber) || account.transactionCount === 0);
}

function isLegacyDerivedWarning(warning: string): boolean {
  return /第\s*\d+\s*页第\s*\d+\s*笔交易余额不连续/.test(warning)
    || /识别置信度低于\s*80%/.test(warning)
    || /第\s*\d+\s*页第\s*\d+\s*笔(?:收支方向|交易金额)无法确认/.test(warning);
}

function warningPage(warning: string): number | undefined {
  const match = warning.match(/第\s*(\d+)\s*页/);
  return match ? Number(match[1]) : undefined;
}

function isUsefulBankName(value: string): boolean {
  return Boolean(value) && !/待核验|待核对|未知/.test(value) && !/^[\u4e00-\u9fa5]{2,4}$/.test(value);
}

function mostFrequent(values: string[]): string {
  const counts = new Map<string, { value: string; count: number }>();
  for (const value of values.filter(Boolean)) {
    const key = normalizeAccountIdentityPart(value);
    const current = counts.get(key);
    counts.set(key, { value, count: (current?.count || 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.length - b.value.length)[0]?.value || '';
}

function preferredOwnerType(accounts: BankAccount[]): BankAccount['ownerType'] {
  return accounts.find(item => item.ownerType !== 'UNKNOWN')?.ownerType || 'DEBTOR_MAIN';
}

function bestOriginal(accounts: BankAccount[]): BankAccount | undefined {
  return [...accounts].sort((a, b) => b.transactionCount - a.transactionCount)[0];
}

function minimalAccount(transaction: StandardTransaction): BankAccount {
  return {
    accountNumber: transaction.accountNumber, accountName: transaction.accountName, bankName: transaction.bankName,
    ownerType: 'DEBTOR_MAIN', fileName: transaction.rawSourceFile, fileType: 'pdf', totalIn: 0, totalOut: 0,
    transactionCount: 0, startDate: '', endDate: '', startBalance: 0, endBalance: 0,
    isBalanced: false, balanceDiff: 0, balanceAvailable: transaction.balanceAvailable !== false
  };
}

function minimalDocumentAccount(sourceFile: string): BankAccount {
  return {
    accountNumber: '', accountName: '待归属页面', bankName: '待核对', ownerType: 'UNKNOWN', fileName: sourceFile,
    fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0, startDate: '', endDate: '', startBalance: 0,
    endBalance: 0, isBalanced: false, balanceDiff: 0, balanceAvailable: false
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}
