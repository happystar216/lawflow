import type { BankAccount, StandardTransaction, TransactionEvidenceField } from '../types/transaction';
import type { QwenChunkResult } from '../parsers/qwenResultMerger';
import type { MinerUPageCheckpoint } from '../parsers/mineruBankStatementParser';
import { normalizeAccountIdentityPart as numberKey } from '../utils/accountIdentity';
import { isCreditCardStatement } from '../utils/transactionSequence';
import { preserveExtraction, sameSource } from './decisionPolicy';
import { canonicalBank } from './bankEvidence';

const unknown = (bank: string) => !bank || /待核|未知/.test(bank);
const cents = (value: number) => Math.round(value * 100);
const signature = (row: StandardTransaction) => [row.transactionDate, row.direction, cents(row.amount), cents(row.balance)].join('|');
const usable = (row: StandardTransaction) => /^\d{4}-\d{2}-\d{2}$/.test(row.transactionDate)
  && row.direction !== 'UNKNOWN' && row.balanceAvailable !== false && Number.isFinite(row.balance) && Number.isFinite(row.amount);

export function requireSourceCheck(row: StandardTransaction, fields: TransactionEvidenceField[], reason: string): void {
  if (row.reviewedAt || row.reviewStatus === 'VERIFIED') return;
  const review = row.candidateReview;
  if (!review) row.candidateReview = { kind: 'SOURCE_CHECK', status: 'PENDING', reason,
    differences: fields.map(field => ({ field, selected: row[field] ?? null, alternative: null })) };
  else if (review.status !== 'CONFIRMED') {
    review.reason = [...new Set([review.reason, reason].filter(Boolean))].join('；');
    review.requiredFields = [...new Set([...(review.requiredFields || []), ...fields])];
  }
  row.reviewStatus = 'PENDING';
}

/** A near-number match alone NEVER merges accounts. Require an explicit inventory
 * plus a unique, multi-date overlapping ledger with at least 80% corroboration. */
export function reconcileDocumentIdentities(results: QwenChunkResult[], inventory: Array<{ account: BankAccount; page: number }>,
  printedAliases: Array<{ account: string; card: string; page: number }> = []): QwenChunkResult[] {
  const output = structuredClone(results);
  const cardLinks = new Map<string, Set<string>>();
  for (const link of printedAliases) cardLinks.set(link.card, new Set([...(cardLinks.get(link.card) || []), link.account]));
  for (const result of output) {
    const applied = new Map<string, string>();
    for (const row of result.transactions) {
      const targets = cardLinks.get(row.accountNumber);
      if (targets?.size !== 1 || row.reviewedAt || row.reviewStatus === 'VERIFIED') continue;
      const target = [...targets][0];
      const owner = inventory.find(item => item.account.accountNumber === target && item.account.accountName.trim() === row.accountName.trim());
      if (!owner || !row.accountName.trim() || /待核|未知/.test(row.accountName)) continue;
      applied.set(row.accountNumber, target);
      row.fieldEvidence = preserveExtraction(row).fieldEvidence;
      row.accountNumber = target;
      row.fieldEvidence!.accountNumber = { ...row.fieldEvidence!.accountNumber!, currentValue: target,
        origin: 'AUTO_NORMALIZATION', decision: 'SUGGESTED',
        reason: `第 ${owner.page} 页原件明确列出了账号与对应卡号；保留原始卡号并按该关系归户` };
    }
    for (const account of [result.account, ...(result.accounts || [])]) {
      account.accountNumber = applied.get(account.accountNumber) || account.accountNumber;
    }
  }
  const rows = output.flatMap(result => result.transactions);
  const groups = new Map<string, StandardTransaction[]>();
  for (const row of rows) groups.set(numberKey(row.accountNumber), [...(groups.get(numberKey(row.accountNumber)) || []), row]);
  const listed = new Set(inventory.map(item => numberKey(item.account.accountNumber)));
  const aliases = new Map<string, { target: string; page: number; matches: number }>();
  for (const [number, own] of groups) {
    if (listed.has(number) || !/^\d{12,32}$/.test(number) || own.some(row => row.reviewedAt || row.reviewStatus === 'VERIFIED')) continue;
    const candidates = inventory.filter(({ account }) => {
      const target = numberKey(account.accountNumber);
      return target.length === number.length && [...number].filter((digit, i) => digit !== target[i]).length === 1;
    }).map(({ account, page }) => {
      const other = groups.get(numberKey(account.accountNumber)) || [];
      const matches = own.filter(row => usable(row) && row.amount > 0 && row.accountName?.trim()
        && !/待核|未知/.test(row.accountName) && row.accountName.trim() === account.accountName.trim()
        && own.filter(item => signature(item) === signature(row)).length === 1
        && other.filter(item => usable(item) && signature(item) === signature(row) && sameSource(item, row)
          && item.rawPageNumber !== row.rawPageNumber && item.accountName.trim() === row.accountName.trim()
          && (unknown(item.bankName) || unknown(row.bankName) || canonicalBank(item.bankName) === canonicalBank(row.bankName))).length === 1);
      return { target: account.accountNumber, page, matches: matches.length, dates: new Set(matches.map(row => row.transactionDate)).size };
    }).filter(item => item.matches >= 3 && item.matches / own.length >= .8 && item.dates >= 2);
    const unique = new Map(candidates.map(item => [numberKey(item.target), item]));
    if (unique.size === 1) aliases.set(number, [...unique.values()][0]);
  }
  for (const result of output) {
    for (const row of result.transactions) {
      const alias = aliases.get(numberKey(row.accountNumber));
      if (!alias) continue;
      const previous = row.accountNumber;
      row.fieldEvidence = preserveExtraction(row).fieldEvidence;
      row.accountNumber = alias.target;
      const reason = `本方账号“${previous}”与第 ${alias.page} 页账户资料及 ${alias.matches} 笔跨日重叠流水不一致，暂归入“${alias.target}”。请核对本页账号，确认是否同一账户；原始读法已保留。`;
      row.fieldEvidence!.accountNumber = { ...row.fieldEvidence!.accountNumber!, currentValue: alias.target,
        origin: 'AUTO_NORMALIZATION', decision: 'SUGGESTED', reason };
      requireSourceCheck(row, ['accountNumber'], reason);
    }
    for (const account of [result.account, ...(result.accounts || [])]) {
      const alias = aliases.get(numberKey(account.accountNumber));
      if (alias) account.accountNumber = alias.target;
    }
  }
  // Exact account links may carry a supported bank from any page, even if the
  // metadata page was classified DOCUMENT or planning for the ledger failed.
  const banks = new Map<string, Set<string>>();
  for (const result of output) for (const item of [result.account, ...(result.accounts || []), ...result.transactions]) {
    if (!unknown(item.bankName)) {
      const key = numberKey(item.accountNumber);
      banks.set(key, new Set([...(banks.get(key) || []), canonicalBank(item.bankName)]));
    }
  }
  for (const result of output) for (const item of [result.account, ...(result.accounts || []), ...result.transactions]) {
    const candidates = banks.get(numberKey(item.accountNumber));
    if (unknown(item.bankName) && candidates?.size === 1) item.bankName = [...candidates][0];
  }
  return output;
}

/** Check adjacent printed rows without changing their values or reordering rows
 * to make the balance work. Integer cents catch even a one-cent discrepancy. */
export function sourceValidationRisks(checkpoints: MinerUPageCheckpoint[]): Map<number, Map<string, string>> {
  const risks = new Map<number, Map<string, string>>();
  const documentRows = new Map<string, StandardTransaction[]>();
  for (const checkpoint of checkpoints) for (const row of checkpoint.selected.transactions) {
    const key = `${row.sourceDocumentId || row.rawSourceFile}|${numberKey(row.accountNumber)}`;
    documentRows.set(key, [...(documentRows.get(key) || []), row]);
  }
  for (const checkpoint of checkpoints) {
    const groups = new Map<string, StandardTransaction[]>();
    for (const row of checkpoint.selected.transactions) groups.set(numberKey(row.accountNumber), [...(groups.get(numberKey(row.accountNumber)) || []), row]);
    for (const rows of groups.values()) {
      const key = `${rows[0].sourceDocumentId || rows[0].rawSourceFile}|${numberKey(rows[0].accountNumber)}`;
      if (isCreditCardStatement(documentRows.get(key) || rows)) continue;
      const ordered = [...rows].sort((a, b) => (a.rawRowIndex || 0) - (b.rawRowIndex || 0));
      let forward = 0, reverse = 0;
      for (let i = 1; i < ordered.length; i++) {
        if (ordered[i].transactionTime > ordered[i - 1].transactionTime) forward++;
        if (ordered[i].transactionTime < ordered[i - 1].transactionTime) reverse++;
      }
      if (reverse > forward) ordered.reverse();
      for (let i = 1; i < ordered.length; i++) {
        const previous = ordered[i - 1], current = ordered[i];
        if (!usable(previous) || !usable(current) || !sameSource(previous, current)) continue;
        const difference = cents(previous.balance) + (current.direction === 'IN' ? 1 : -1) * cents(current.amount) - cents(current.balance);
        if (!difference) continue;
        const reason = `第 ${checkpoint.page} 页第 ${previous.rawRowIndex}、${current.rawRowIndex} 行余额衔接相差 ${(Math.abs(difference) / 100).toFixed(2)} 元。可能是数字读错、缺行或原件不连续；请核对这两行的金额、收支方向和交易后余额，不要按差额改数。`;
        const byRow = risks.get(checkpoint.page) || new Map<string, string>();
        byRow.set(previous.id, reason); byRow.set(current.id, reason);
        risks.set(checkpoint.page, byRow);
      }
    }
  }
  return risks;
}
