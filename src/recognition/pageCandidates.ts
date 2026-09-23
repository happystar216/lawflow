import type { QwenChunkResult } from '../parsers/qwenResultMerger';
import { preserveExtraction } from './decisionPolicy';
import type { StandardTransaction, TransactionEvidenceField } from '../types/transaction';
import { normalizeAccountIdentityPart } from '../utils/accountIdentity';

const comparedFields: TransactionEvidenceField[] = ['accountNumber', 'transactionTime', 'direction', 'amount',
  'balance', 'counterpartyName', 'counterpartyAccount', 'summary'];
const value = (row: StandardTransaction, field: TransactionEvidenceField): string | number | null =>
  field === 'balance' && row.balanceAvailable === false ? null : row[field] ?? '';
// Unique exact owner+date anchors only. Ambiguous same-day rows are never paired
// by index, amount, balance, or a fuzzy account suffix.
const anchor = (row: StandardTransaction) => {
  const account = normalizeAccountIdentityPart(row.accountNumber);
  const date = row.transactionTime?.slice(0, 10);
  return /^\d{8,32}$/.test(account) && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${account}|${date}` : '';
};

/** Compare whole page candidates. Never join rows by offsets or shift their years. */
export function selectPageCandidate(
  primary: QwenChunkResult,
  recovery: QwenChunkResult,
  page: number,
  damagedPrimary = false,
  accountAliases: ReadonlyMap<string, string> = new Map()
): QwenChunkResult {
  const owner = (row: StandardTransaction) => accountAliases.get(normalizeAccountIdentityPart(row.accountNumber))
    || normalizeAccountIdentityPart(row.accountNumber);
  const comparable = (row: StandardTransaction, field: TransactionEvidenceField) => field === 'accountNumber' ? owner(row) : value(row, field);
  const ownerDate = (row: StandardTransaction) => anchor({ ...row, accountNumber: owner(row) });
  const rowKey = (row: StandardTransaction) => JSON.stringify(comparedFields.map(field => comparable(row, field)));
  const left = primary.transactions.map(rowKey);
  const right = recovery.transactions.map(rowKey);
  const agrees = left.length === right.length && left.every((key, index) => key === right[index]);
  // Original-page recovery is a separate candidate, never an authoritative truth.
  // Prefer its intact sequence when it contains more observations, keeping the
  // disagreement explicit and both full candidates in the page checkpoint.
  const selected = recovery.transactions.length > primary.transactions.length
    && (damagedPrimary || primary.countComplete !== true) ? recovery : primary;
  const result = structuredClone(selected);
  const alternative = selected === primary ? recovery : primary;
  const indexRows = (rows: StandardTransaction[], getKey = ownerDate) => {
    const index = new Map<string, StandardTransaction[]>();
    for (const row of rows) {
      const key = getKey(row);
      if (key) index.set(key, [...(index.get(key) || []), row]);
    }
    return index;
  };
  const ownIndex = indexRows(selected.transactions);
  const alternativeIndex = indexRows(alternative.transactions);
  const precise = (row: StandardTransaction) => /\d{2}:\d{2}:\d{2}$/.test(row.transactionTime)
    ? `${owner(row)}|${row.transactionTime}` : '';
  const ownTimes = indexRows(selected.transactions, precise);
  const otherTimes = indexRows(alternative.transactions, precise);
  const singleOwner = new Set(selected.transactions.map(row => row.accountNumber)).size === 1
    && new Set(alternative.transactions.map(row => row.accountNumber)).size === 1;
  const date = (row: StandardTransaction) => row.transactionTime.slice(0, 10);
  const ownDates = indexRows(selected.transactions, date), otherDates = indexRows(alternative.transactions, date);
  const aligned = new Set<StandardTransaction>();
  result.transactions = result.transactions.map(original => {
    const row = preserveExtraction(original);
    if (agrees) return row;
    const key = ownerDate(row);
    let ownMatches = ownIndex.get(key) || [];
    let matches = alternativeIndex.get(key) || [];
    if (ownTimes.get(precise(row))?.length === 1 && otherTimes.get(precise(row))?.length === 1) {
      ownMatches = ownTimes.get(precise(row))!; matches = otherTimes.get(precise(row))!;
    } else if (!matches.length && singleOwner && /^\d{4}-\d{2}-\d{2}$/.test(date(row))
      && ownDates.get(date(row))?.length === 1 && otherDates.get(date(row))?.length === 1) {
      // Single-owner pages with a unique date can expose an account discrepancy;
      // this links candidates for review only, it does NOT change an identity.
      ownMatches = ownDates.get(date(row))!; matches = otherDates.get(date(row))!;
    }
    const unique = ownMatches.length === 1 && matches.length === 1;
    if (unique) aligned.add(matches[0]);
    const differences = unique ? comparedFields.filter(field => comparable(row, field) !== comparable(matches[0], field))
      .map(field => ({ field, selected: value(row, field), alternative: value(matches[0], field) })) : [];
    if (unique && !differences.length) return row;
    row.candidateReview = {
      kind: unique ? 'FIELD_CONFLICT' : key && ownMatches.length === 1 && !matches.length ? 'UNMATCHED_ROW' : 'AMBIGUOUS_ROW',
      differences, status: 'PENDING'
    };
    row.reviewStatus = 'PENDING';
    return row;
  });
  const rowsAligned = agrees || (selected.transactions.length === alternative.transactions.length
    && aligned.size === selected.transactions.length);
  const complete = rowsAligned && (primary.countComplete === true || recovery.countComplete === true);
  result.countComplete = complete;
  result.warnings = [...new Set([
    ...(primary.warnings || []), ...(recovery.warnings || []),
    ...(!agrees ? [rowsAligned
      ? `第 ${page} 页两次读取字段存在差异，已逐行对应全部 ${result.transactions.length} 笔；只需核对标出的具体字段，完整候选均已保留`
      : `第 ${page} 页两次读取结果不同（${primary.transactions.length} / ${recovery.transactions.length} 笔）；已保留完整候选并标出有差异或无法对应的行。请清点原件行数，未自动拼接或调整年份`] : [])
  ])];
  result.pageQuality = [{
    page,
    expectedCount: complete ? result.transactions.length : Number.NaN,
    extractedCount: result.transactions.length,
    status: complete ? 'COMPLETE' : 'NEEDS_REVIEW',
    pageType: selected.pageQuality?.[0]?.pageType || 'TRANSACTIONS'
  }];
  return result;
}
