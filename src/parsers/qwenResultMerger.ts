import { BankAccount, StandardTransaction } from '../types/transaction';
import { balanceContinuityIssues, chronologicalTransactions } from '../utils/transactionSequence';
import { isReliableAccountNumber, normalizeAccountIdentityPart } from '../utils/accountIdentity';
import { canInheritOwner, isEvidenceOnly, sameSource } from '../recognition/decisionPolicy';

export interface QwenChunkResult {
  account: BankAccount;
  accounts?: BankAccount[];
  transactions: StandardTransaction[];
  warnings?: string[];
  coveredPages: number[];
  pageStart: number;
  pageEnd: number;
  totalPages: number;
  expectedTransactionCount?: number;
  countComplete?: boolean;
  usageTokens?: number;
  pageQuality?: Array<{
    page: number;
    expectedCount: number;
    extractedCount: number;
    status: 'COMPLETE' | 'NEEDS_REVIEW';
    pageType?: 'TRANSACTIONS' | 'ACCOUNT_LIST' | 'ACCOUNT_INFO' | 'INVESTIGATION_ORDER' | 'BANK_REPLY' | 'COVER' | 'OTHER_DOCUMENT' | 'DOCUMENT' | 'BLANK' | 'UNKNOWN';
  }>;
}

export function mergeQwenChunkResults(
  input: QwenChunkResult[], sourceFileName: string, totalPages: number
): { account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] } {
  if (!input.length) throw new Error('没有可合并的 PDF 分片结果');
  const results = [...input].sort((a, b) => a.pageStart - b.pageStart);
  const coveredPages = [...new Set(results.flatMap(result => result.coveredPages))].sort((a, b) => a - b);
  const coveredSet = new Set(coveredPages);
  const missingPages = Array.from({ length: totalPages }, (_, index) => index + 1).filter(page => !coveredSet.has(page));
  if (missingPages.length) throw new Error(`PDF 解析不完整，缺少第 ${missingPages.join('、')} 页`);

  const deduped = new Map<string, StandardTransaction>();
  for (const result of results) {
    for (const transaction of result.transactions) {
      const key = sourceLocatorKey(transaction);
      const existing = deduped.get(key);
      if (!existing || (transaction.extractionConfidence || 0) > (existing.extractionConfidence || 0)) deduped.set(key, transaction);
    }
  }
  const evidenceAlignedTransactions = alignTransactionsWithAccountEvidence(
    [...deduped.values()].sort(compareSourceOrder), results
  );
  const inheritedTransactions = inheritMissingAccountIdentity(evidenceAlignedTransactions.map(transaction => ({
    ...transaction,
    rawSourceFile: sourceFileName,
    id: `TX_PDF_${stableHash(`${sourceFileName}|${sourceLocatorKey(transaction)}`)}`
  })));
  const reconciled = reconcileGlobalTransactions(inheritedTransactions);
  const transactions = reconciled.transactions;
  const pageQualityWarnings = results.flatMap(result => result.pageQuality || [])
    .filter(page => page.status === 'NEEDS_REVIEW'
      && Number.isFinite(page.expectedCount)
      && page.expectedCount !== page.extractedCount)
    .map(page => `第 ${page.page} 页页面行数报告为 ${page.expectedCount} 笔，逐笔提取为 ${page.extractedCount} 笔；两者尚未核实，请对照原件确认`);
  const invalidCountWarnings = results.flatMap(result => result.pageQuality || [])
    .filter(page => page.status === 'NEEDS_REVIEW' && !Number.isFinite(page.expectedCount))
    .map(page => `第 ${page.page} 页未能完成独立行数清点，当前已提取 ${page.extractedCount} 笔；请仅在发现日期、金额或余额异常时对照原件核对`);
  const warnings = [...new Set([
    ...results.flatMap(result => result.warnings || []).filter(warning => !/\bundefined\b/i.test(warning)),
    ...reconciled.warnings,
    ...pageQualityWarnings,
    ...invalidCountWarnings,
    ...(!transactions.length ? ['整份文件未提取到交易明细，请逐页对照原件确认是否为空白页、非流水页或读取失败'] : [])
  ])];
  const accounts = buildAccountSummaries(transactions, results, warnings, sourceFileName, totalPages);
  return { account: accounts[0], accounts, transactions };
}

function alignTransactionsWithAccountEvidence(
  transactions: StandardTransaction[], results: QwenChunkResult[]
): StandardTransaction[] {
  const pageAccounts = new Map<number, BankAccount>();
  for (const result of results) {
    const candidates = (result.accounts?.length ? result.accounts : [result.account])
      .filter(account => isReliableAccountNumber(account.accountNumber));
    const unique = [...new Map(candidates.map(account => [
      normalizeAccountIdentityPart(account.accountNumber), account
    ])).values()];
    if (unique.length !== 1) continue;
    for (const page of result.coveredPages) pageAccounts.set(page, unique[0]);
  }
  const listedAccounts = results
    .filter(result => result.pageQuality?.some(page => page.pageType === 'ACCOUNT_INFO' || page.pageType === 'ACCOUNT_LIST'))
    .flatMap(result => result.accounts?.length ? result.accounts : [result.account])
    .filter(account => isReliableAccountNumber(account.accountNumber));
  if (!listedAccounts.length && !pageAccounts.size) return transactions;
  const normalizedNumber = (value: string) => normalizeAccountIdentityPart(value);
  return transactions.map(transaction => {
    if (isEvidenceOnly(transaction)) return transaction;
    const transactionNumber = normalizedNumber(transaction.accountNumber);
    const listed = listedAccounts.find(account => {
      const accountNumber = normalizedNumber(account.accountNumber);
      return accountNumber === transactionNumber || (
        Math.min(accountNumber.length, transactionNumber.length) >= 12
        && (accountNumber.endsWith(transactionNumber) || transactionNumber.endsWith(accountNumber))
      );
    });
    const local = pageAccounts.get(transaction.rawPageNumber || 0);
    // A printed owner account on this exact page is stronger evidence than an
    // account-list match carried from another section of the same PDF. Without
    // this precedence, a stale model account can make `listed` match itself and
    // override the explicit page header/table identity.
    const compatibleListed = local && listed && (
      normalizedNumber(local.accountNumber) === normalizedNumber(listed.accountNumber)
      || (normalizedNumber(local.accountNumber).length >= 12
        && normalizedNumber(listed.accountNumber).endsWith(normalizedNumber(local.accountNumber)))
    ) ? listed : undefined;
    const evidence = compatibleListed || local || listed;
    if (!evidence) return transaction;
    return {
      ...transaction,
      accountNumber: evidence.accountNumber,
      accountName: evidence.accountName || transaction.accountName,
      bankName: isSpecificBankName(evidence.bankName) ? evidence.bankName : transaction.bankName
    };
  });
}

function isSpecificBankName(value: string): boolean {
  const normalized = value.replace(/\s+/g, '').trim();
  return Boolean(normalized && !/^(?:待核验银行|未知银行|商业银行|银行)$/.test(normalized));
}

function reconcileGlobalTransactions(input: StandardTransaction[]): { transactions: StandardTransaction[]; warnings: string[] } {
  const transactions = input.map(transaction => ({ ...transaction }));
  const warnings: string[] = [];
  const byAccount = new Map<string, StandardTransaction[]>();
  for (const transaction of transactions) {
    const key = ownerAccountKey(transaction);
    byAccount.set(key, [...(byAccount.get(key) || []), transaction]);
  }
  for (const accountTransactions of byAccount.values()) {
    if (accountTransactions.some(isEvidenceOnly)) continue;
    const ordered = [...accountTransactions].sort(compareSourceOrder);
    const pages = new Map<number, StandardTransaction[]>();
    for (const transaction of ordered) {
      const page = transaction.rawPageNumber || 0;
      pages.set(page, [...(pages.get(page) || []), transaction]);
    }
    for (const [page, pageTransactions] of pages) {
      const firstIndex = ordered.indexOf(pageTransactions[0]);
      const candidates = firstIndex > 0 ? [ordered[firstIndex - 1], ...pageTransactions] : pageTransactions;
      let comparisons = 0;
      let directExact = 0;
      let flippedExact = 0;
      for (let index = 1; index < candidates.length; index += 1) {
        const previous = candidates[index - 1];
        const current = candidates[index];
        if (previous.balanceAvailable === false || current.balanceAvailable === false || current.direction === 'UNKNOWN') continue;
        const direct = transactionBalanceError(previous, current, current.direction);
        const flipped = transactionBalanceError(previous, current, flipDirection(current.direction));
        comparisons += 1;
        if (direct < 1) directExact += 1;
        if (flipped < 1) flippedExact += 1;
      }
      if (comparisons >= 2 && flippedExact / comparisons >= 0.65 && directExact / comparisons <= 0.25) {
        for (const transaction of pageTransactions) {
          transaction.direction = flipDirection(transaction.direction);
          transaction.reviewStatus = 'CORRECTED';
          transaction.extractionConfidence = Math.min(transaction.extractionConfidence ?? 0.95, 0.9);
        }
        warnings.push(`第 ${page} 页经余额连续性校验，已自动纠正整页收支方向；请结合原件抽查`);
      }
      if (looksLikeColumnShift(pageTransactions)) {
        for (const transaction of pageTransactions) {
          transaction.reviewStatus = 'PENDING';
          transaction.extractionConfidence = Math.min(transaction.extractionConfidence ?? 0.95, 0.4);
        }
        warnings.push(`第 ${page} 页疑似发生额与余额列整体错位，系统已将该页列为待核对`);
      }
    }
  }
  return { transactions, warnings };
}

function looksLikeColumnShift(transactions: StandardTransaction[]): boolean {
  if (transactions.length < 3) return false;
  const zeroBalances = transactions.filter(transaction => transaction.balanceAvailable !== false && Math.abs(transaction.balance) < 0.005).length;
  const positiveAmounts = transactions.filter(transaction => transaction.amount > 10).length;
  return zeroBalances / transactions.length >= 0.8 && positiveAmounts / transactions.length >= 0.8;
}

function transactionBalanceError(
  previous: StandardTransaction,
  current: StandardTransaction,
  direction: StandardTransaction['direction']
): number {
  if (direction === 'UNKNOWN') return Number.POSITIVE_INFINITY;
  const expected = previous.balance + (direction === 'IN' ? current.amount : -current.amount);
  return Math.abs(expected - current.balance);
}

function flipDirection(direction: StandardTransaction['direction']): StandardTransaction['direction'] {
  return direction === 'IN' ? 'OUT' : direction === 'OUT' ? 'IN' : 'UNKNOWN';
}

function buildAccountSummaries(
  transactions: StandardTransaction[], results: QwenChunkResult[], warnings: string[], sourceFileName: string, totalPages: number
): BankAccount[] {
  const groups = new Map<string, StandardTransaction[]>();
  for (const transaction of transactions) {
    const key = ownerAccountKey(transaction);
    groups.set(key, [...(groups.get(key) || []), transaction]);
  }

  const groupedTransactions = [...groups.values()];
  const ownedPages = new Set(transactions.map(item => item.rawPageNumber).filter(Boolean));
  const orphanWarnings = warnings.filter(warning => {
    const page = warningPage(warning);
    return transactions.length === 0 || !page || !ownedPages.has(page);
  });
  const accountSummaries: BankAccount[] = groupedTransactions.map(accountTransactions => {
    const sourceOrdered = [...accountTransactions].sort(compareSourceOrder);
    const chronological = chronologicalTransactions(sourceOrdered);
    const firstTransactionIdentity = sourceOrdered[0];
    const matchingResult = results.find(result => ownerAccountKey(result.account) === ownerAccountKey(firstTransactionIdentity));
    const pages = [...new Set(sourceOrdered.map(item => item.rawPageNumber).filter((page): page is number => Boolean(page)))].sort((a, b) => a - b);
    const pageSet = new Set(pages);
    const accountWarnings = warnings.filter(warning => {
      const page = warningPage(warning);
      return Boolean(page && pageSet.has(page));
    });
    const continuityIssues = findBalanceContinuityIssues(sourceOrdered);
    const lowConfidence = sourceOrdered.filter(item => (item.extractionConfidence ?? 1) < 0.8);
    const parseWarnings = [...new Set([
      ...accountWarnings
    ])];
    const totalIn = sourceOrdered.filter(item => item.direction === 'IN').reduce((sum, item) => sum + item.amount, 0);
    const totalOut = sourceOrdered.filter(item => item.direction === 'OUT').reduce((sum, item) => sum + item.amount, 0);
    const dates = sourceOrdered.map(item => item.transactionDate).filter(Boolean).sort();
    const balanceAvailable = sourceOrdered.some(item => item.balanceAvailable !== false);
    const firstWithBalance = chronological.find(item => item.balanceAvailable !== false);
    const lastWithBalance = [...chronological].reverse().find(item => item.balanceAvailable !== false);
    const startBalance = firstWithBalance
      ? firstWithBalance.direction === 'UNKNOWN' ? Number(matchingResult?.account.startBalance || 0)
        : firstWithBalance.balance + (firstWithBalance.direction === 'IN' ? -firstWithBalance.amount : firstWithBalance.amount)
      : Number(matchingResult?.account.startBalance || 0);
    const endBalance = lastWithBalance?.balance ?? Number(matchingResult?.account.endBalance || 0);
    const balanceDiff = balanceAvailable ? Math.abs(startBalance + totalIn - totalOut - endBalance) : 0;
    return {
      ...(matchingResult?.account || {} as BankAccount),
      accountNumber: firstTransactionIdentity.accountNumber,
      accountName: firstTransactionIdentity.accountName,
      bankName: firstTransactionIdentity.bankName,
      ownerType: matchingResult?.account.ownerType || 'DEBTOR_MAIN',
      fileName: sourceFileName,
      fileType: 'pdf',
      totalIn, totalOut, transactionCount: sourceOrdered.length,
      startDate: dates[0] || '', endDate: dates[dates.length - 1] || '',
      startBalance, endBalance, balanceAvailable,
      isBalanced: balanceAvailable && Math.round(balanceDiff * 100) === 0,
      balanceDiff,
      parseStatus: parseWarnings.length || lowConfidence.length || continuityIssues.length ? 'NEEDS_REVIEW' : 'COMPLETE',
      parseWarnings,
      coveredPages: pages,
      totalPages,
      balanceContinuityIssueCount: continuityIssues.length
    };
  });

  // Account-list pages are evidence even when a listed account has no rows in
  // this statement period. Preserve those entities instead of silently losing
  // them when the segmented response is flattened into per-page chunks.
  const listedAccounts = results.flatMap(result => {
    const accounts = result.accounts?.length ? result.accounts : (result.transactions.length ? [result.account] : []);
    return accounts.map(account => ({ account, result }));
  });
  for (const { account: listed, result } of listedAccounts) {
    if (!isReliableAccountNumber(listed.accountNumber)) continue;
    if (accountSummaries.some(existing => sameAccountIdentity(existing, listed))) continue;
    const pages = [...new Set(listed.coveredPages?.length ? listed.coveredPages : result.coveredPages)]
      .filter(page => Number.isInteger(page) && page > 0)
      .sort((a, b) => a - b);
    const pageSet = new Set(pages);
    const parseWarnings = [...new Set([
      ...(listed.parseWarnings || []),
      ...warnings.filter(warning => {
        const page = warningPage(warning);
        return Boolean(page && pageSet.has(page));
      })
    ])];
    accountSummaries.push({
      ...listed,
      fileName: sourceFileName,
      fileType: 'pdf',
      totalIn: 0,
      totalOut: 0,
      transactionCount: 0,
      startDate: '',
      endDate: '',
      startBalance: 0,
      endBalance: 0,
      balanceAvailable: false,
      isBalanced: false,
      balanceDiff: 0,
      parseStatus: parseWarnings.length ? 'NEEDS_REVIEW' : 'COMPLETE',
      parseWarnings,
      coveredPages: pages,
      totalPages,
      balanceContinuityIssueCount: 0
    });
  }
  const actionableOrphanWarnings = orphanWarnings.filter(w => !/空白|留白/.test(w) || /缺少|漏|失败|错误/.test(w));
  if (actionableOrphanWarnings.length) {
    const orphanPages = actionableOrphanWarnings.map(warningPage).filter((page): page is number => Boolean(page));
    const hasHardFailure = actionableOrphanWarnings.some(warning => /连续识别失败|服务暂时不可用|未能完整获取/.test(warning));
    accountSummaries.push({
      accountNumber: `待归属页面-${sourceFileName}`, accountName: '待归属页面', bankName: '待核对',
      ownerType: 'UNKNOWN', fileName: sourceFileName, fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0,
      startDate: '', endDate: '', startBalance: 0, endBalance: 0, isBalanced: false, balanceDiff: 0,
      balanceAvailable: false, parseStatus: hasHardFailure ? 'INCOMPLETE' : 'NEEDS_REVIEW', parseWarnings: [...new Set(actionableOrphanWarnings)],
      coveredPages: [...new Set(orphanPages)].sort((a, b) => a - b), totalPages, balanceContinuityIssueCount: 0
    });
  }
  return accountSummaries;
}

function sameAccountIdentity(left: BankAccount, right: BankAccount): boolean {
  const leftNumber = normalizeAccountIdentityPart(left.accountNumber);
  const rightNumber = normalizeAccountIdentityPart(right.accountNumber);
  if (!leftNumber || !rightNumber) return false;
  const sameNumber = leftNumber === rightNumber
    || (Math.min(leftNumber.length, rightNumber.length) >= 12
      && (leftNumber.endsWith(rightNumber) || rightNumber.endsWith(leftNumber)));
  if (!sameNumber) return false;
  const leftBank = normalizeAccountIdentityPart(left.bankName).replace(/中国|股份有限公司|有限责任公司|银行/g, '');
  const rightBank = normalizeAccountIdentityPart(right.bankName).replace(/中国|股份有限公司|有限责任公司|银行/g, '');
  return !leftBank || !rightBank || leftBank === rightBank || leftBank.includes(rightBank) || rightBank.includes(leftBank);
}

function inheritMissingAccountIdentity(transactions: StandardTransaction[]): StandardTransaction[] {
  const isKnown = (transaction: StandardTransaction) => isReliableAccountNumber(transaction.accountNumber);
  const inherited = transactions.map((transaction, index) => {
    if (!canInheritOwner(transaction)) return transaction;
    const previous = [...transactions.slice(0, index)].reverse().find(item => isKnown(item) && sameSource(item, transaction));
    const next = transactions.slice(index + 1).find(item => isKnown(item) && sameSource(item, transaction));
    const previousKey = previous ? ownerAccountKey(previous) : '';
    const nextKey = next ? ownerAccountKey(next) : '';
    const cleanBank = (name: string) => name.replace(/中国|银行|个人|活期|结算|账户/g, '').trim();
    const matchesPreviousBank = Boolean(
      previous && (
        !transaction.bankName ||
        transaction.bankName.includes('待核验') ||
        transaction.bankName.includes(previous.bankName) ||
        previous.bankName.includes(transaction.bankName) ||
        (cleanBank(transaction.bankName) && cleanBank(transaction.bankName) === cleanBank(previous.bankName))
      )
    );
    const inherited = previous && next && previousKey === nextKey && matchesPreviousBank
      ? previous : undefined;
    return inherited ? {
      ...transaction,
      accountNumber: inherited.accountNumber,
      accountName: inherited.accountName,
      bankName: inherited.bankName
    } : transaction;
  });
  const pages = new Map<number, StandardTransaction[]>();
  for (const transaction of inherited) {
    if (!transaction.rawPageNumber) continue;
    pages.set(transaction.rawPageNumber, [...(pages.get(transaction.rawPageNumber) || []), transaction]);
  }
  const pageNumbers = [...pages.keys()].sort((a, b) => a - b);
  for (const page of pageNumbers) {
    const pageTransactions = pages.get(page) || [];
    const identities = new Set(pageTransactions.map(ownerAccountKey));
    if (pageTransactions.length < 2 || identities.size !== pageTransactions.length
      || pageTransactions.some(item => !canInheritOwner(item))) continue;
    const previous = [...inherited].reverse().find(item => (item.rawPageNumber || 0) < page && isReliableAccountNumber(item.accountNumber));
    const next = inherited.find(item => (item.rawPageNumber || 0) > page && isReliableAccountNumber(item.accountNumber));
    if (!previous || !next || ownerAccountKey(previous) !== ownerAccountKey(next)) continue;
    for (const transaction of pageTransactions) {
      transaction.accountNumber = previous.accountNumber;
      transaction.accountName = previous.accountName;
      transaction.bankName = previous.bankName;
    }
  }
  return inherited;
}

function findBalanceContinuityIssues(transactions: StandardTransaction[]): Array<{ page: number; row: number }> {
  return balanceContinuityIssues(transactions).map(({ transaction }, index) => ({
    page: transaction.rawPageNumber || 1, row: transaction.rawRowIndex || index + 1
  }));
}

function sourceLocatorKey(transaction: StandardTransaction): string {
  return [ownerAccountKey(transaction), transaction.rawPageNumber || 0, transaction.rawRowIndex || 0, transaction.transactionTime,
    transaction.direction, transaction.amount.toFixed(2),
    transaction.balanceAvailable === false ? '' : transaction.balance.toFixed(2),
    transaction.counterpartyAccount || transaction.counterpartyName || ''].join('|');
}

function ownerAccountKey(value: Pick<BankAccount, 'bankName' | 'accountNumber'> | Pick<StandardTransaction, 'bankName' | 'accountNumber'>): string {
  const accountNumber = normalizeAccountIdentityPart(value.accountNumber);
  return isReliableAccountNumber(value.accountNumber)
    ? `account|${accountNumber}`
    : `unverified|${normalizeAccountIdentityPart(value.bankName)}|${accountNumber}`;
}

function warningPage(warning: string): number | undefined {
  const match = warning.match(/第\s*(\d+)\s*页/);
  return match ? Number(match[1]) : undefined;
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase();
}
