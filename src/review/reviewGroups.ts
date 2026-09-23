import type { BankAccount, EvidenceReviewIssue, StandardTransaction } from '../types/transaction';
import { accountIdentityKey, transactionBelongsToAccount } from '../utils/accountIdentity';
import { buildEvidenceReviewIssues } from './buildEvidenceReviewIssues';

export interface EvidenceReviewGroup {
  key: string;
  account: BankAccount;
  pageNumber?: number;
  issues: EvidenceReviewIssue[];
}
export const reviewDocumentKey = (account: BankAccount): string => account.sourceDocumentId
  ? `document:${account.sourceDocumentId}` : `legacy-file:${account.fileName}`;

/** A printed page is shared by every account on it, but never across documents. */
export function buildReviewGroups(accounts: BankAccount[], transactions: StandardTransaction[]): EvidenceReviewGroup[] {
  const groups = new Map<string, EvidenceReviewGroup>();
  for (const account of accounts) {
    for (const issue of buildEvidenceReviewIssues(account, transactions)) {
      const key = issue.pageNumber ? `${reviewDocumentKey(account)}|page:${issue.pageNumber}`
        : `${accountIdentityKey(account)}|issue:${issue.id}`;
      const existing = groups.get(key);
      if (existing) existing.issues.push(issue);
      else groups.set(key, { key, account, pageNumber: issue.pageNumber, issues: [issue] });
    }
  }
  return [...groups.values()].sort((a, b) => reviewDocumentKey(a.account).localeCompare(reviewDocumentKey(b.account))
    || (a.pageNumber || Number.MAX_SAFE_INTEGER) - (b.pageNumber || Number.MAX_SAFE_INTEGER));
}

/** No issues is a system observation, never proof of a human sign-off. */
export function accountReviewLabel(account: BankAccount, transactions: StandardTransaction[]): string {
  const rows = transactions.filter(row => transactionBelongsToAccount(row, account) && !row.excludedFromAnalysis);
  if (!rows.length) return '仅账户资料，未提供流水';
  if (!account.bankName || /待核验|未知|待核对/.test(account.bankName)) return '银行名称待确认';
  if (transactions.some(row => transactionBelongsToAccount(row, account)
    && row.candidateReview && row.candidateReview.status !== 'CONFIRMED')) return '仍有字段待核对';
  return rows.every(row => row.reviewedBy === '律师人工核对' && Boolean(row.reviewedAt)
    && !row.dataQualityIssues?.length && (!row.candidateReview || row.candidateReview.status === 'CONFIRMED')
    && (row.reviewStatus === 'VERIFIED' || row.reviewStatus === 'CORRECTED'))
    ? '流水已人工核对' : '系统检查通过，未人工核对';
}
