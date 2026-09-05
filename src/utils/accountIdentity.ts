import { BankAccount, StandardTransaction } from '../types/transaction';

type AccountIdentity = Pick<BankAccount, 'bankName' | 'accountNumber'> & Partial<Pick<BankAccount, 'fileName'>>;
type TransactionIdentity = Pick<StandardTransaction, 'bankName' | 'accountNumber'> & Partial<Pick<StandardTransaction, 'rawSourceFile'>>;

export function accountIdentityKey(value: AccountIdentity | TransactionIdentity): string {
  const sourceFile = (value as AccountIdentity).fileName || (value as TransactionIdentity).rawSourceFile;
  const accountNumber = normalize(value.accountNumber);
  return isReliableAccountNumber(value.accountNumber)
    ? ['account', accountNumber].join('|')
    : ['unverified', normalize(value.bankName), accountNumber, normalize(sourceFile || '')].join('|');
}

export function transactionBelongsToAccount(transaction: StandardTransaction, account: BankAccount): boolean {
  if (isReliableAccountNumber(transaction.accountNumber) && isReliableAccountNumber(account.accountNumber)) {
    return normalize(transaction.accountNumber) === normalize(account.accountNumber);
  }
  return normalize(transaction.bankName) === normalize(account.bankName)
    && normalize(transaction.accountNumber) === normalize(account.accountNumber);
}

export function normalizeAccountIdentityPart(value: string): string {
  return value.replace(/[\s\-_—–·•]/g, '').toLocaleLowerCase();
}

export function isReliableAccountNumber(value: string): boolean {
  const normalized = normalizeAccountIdentityPart(value || '');
  return normalized.length >= 8
    && !/待核验|待归属|未知|未识别|unknown/.test(normalized);
}

const normalize = normalizeAccountIdentityPart;
