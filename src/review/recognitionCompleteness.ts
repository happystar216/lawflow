import { BankAccount, EvidenceReviewIssue, StandardTransaction } from '../types/transaction';
import { buildEvidenceReviewIssues } from './buildEvidenceReviewIssues';

const HARD_FAILURE_PATTERN = /连续识别失败|服务暂时不可用|未能完整获取|PDF\s*解析不完整/;

export function isDocumentReviewAccount(account: BankAccount): boolean {
  return account.ownerType === 'UNKNOWN'
    && (/待归属页面|待处理页面/.test(account.accountNumber) || account.accountName === '待归属页面');
}

export function businessAccounts(accounts: BankAccount[]): BankAccount[] {
  return accounts.filter(account => !isDocumentReviewAccount(account));
}

export function isBlockingRecognitionIssue(issue: EvidenceReviewIssue): boolean {
  return issue.category === 'PAGE_INTEGRITY'
    && issue.severity === 'REQUIRED'
    && (issue.status === 'PENDING' || issue.status === 'UNRESOLVED')
    && HARD_FAILURE_PATTERN.test(`${issue.title} ${issue.description}`);
}

export function blockingRecognitionIssues(
  accounts: BankAccount[],
  transactions: StandardTransaction[]
): EvidenceReviewIssue[] {
  return accounts
    .flatMap(account => buildEvidenceReviewIssues(account, transactions))
    .filter(isBlockingRecognitionIssue);
}

export function incompleteRecognitionPages(accounts: BankAccount[]): number[] {
  const pages = accounts.flatMap(account => (account.parseWarnings || [])
    .filter(warning => HARD_FAILURE_PATTERN.test(warning))
    .map(warning => Number(warning.match(/第\s*(\d+)\s*页/)?.[1] || 0))
    .filter(page => Number.isInteger(page) && page > 0));
  return [...new Set(pages)].sort((left, right) => left - right);
}
