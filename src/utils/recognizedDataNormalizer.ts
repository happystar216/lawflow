import { BankAccount, StandardTransaction } from '../types/transaction';
import { accountIdentityKey, isReliableAccountNumber, normalizeAccountIdentityPart } from './accountIdentity';
import { balanceContinuityIssues, chronologicalTransactions, isCreditCardStatement, isFeeWaiver } from './transactionSequence';

export interface NormalizedRecognizedData {
  accounts: BankAccount[];
  transactions: StandardTransaction[];
}

export function normalizeRecognizedData(
  inputAccounts: BankAccount[], inputTransactions: StandardTransaction[]
): NormalizedRecognizedData {
  const preparedTransactions = restoreUnsupportedBalanceCorrections(inputTransactions.map(upgradeLegacyGeminiReviewStatus));
  const stabilized = healSummaryOverriddenAmounts(stabilizePageAccountIdentities(preparedTransactions));
  const { transactions: deduped, mergedPagesByAccount } = deduplicateTransactions(stabilized);
  const calibrated = calibrateDirectionsByBalanceMath(deduped);
  const transactions = healOcrBalanceAndAmountDiscrepancies(calibrated);
  for (const transaction of transactions) {
    if (isFeeWaiver(transaction) && transaction.dataQualityIssues) {
      transaction.dataQualityIssues = transaction.dataQualityIssues.filter(q => q !== 'INVALID_AMOUNT');
      if (!transaction.dataQualityIssues.length && transaction.reviewStatus === 'PENDING') {
        transaction.extractionConfidence = Math.max(transaction.extractionConfidence ?? 0, 0.9);
        transaction.reviewStatus = 'AUTO_PASSED';
      }
    }
  }
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
  const assignedUnscopedWarningSet = new Set<string>();
  const keys = new Set([...transactionsByAccount.keys(), ...sourceAccounts.keys()]);
  const accounts: BankAccount[] = [];

  for (const key of keys) {
    const accountTransactions = [...(transactionsByAccount.get(key) || [])].sort(compareSourceOrder);
    const originals = sourceAccounts.get(key) || [];
    if (!accountTransactions.length) continue;
    const originalPages = accountTransactions.map(item => item.rawPageNumber).filter((page): page is number => Boolean(page));
    const mergedPages = mergedPagesByAccount.get(key) || new Set<number>();
    const pages = [...new Set([...originalPages, ...mergedPages])].sort((a, b) => a - b);
    const pageSet = new Set(pages);
    const scopedPageWarnings = pageWarnings.filter(warning => {
      const page = warningPage(warning);
      if (!page || !pageSet.has(page)) return false;
      coveredWarningSet.add(warning);
      return true;
    });
    // File-level parser warnings belong to a real account when one exists. Assign each
    // warning once so a shared parser caveat neither creates a fake zero-transaction
    // account nor appears repeatedly on every account extracted from the same file.
    const accountUnscopedWarnings = originals
      .flatMap(original => original.parseWarnings || [])
      .filter(warning => !isLegacyDerivedWarning(warning) && !warningPage(warning))
      .filter(warning => {
        if (assignedUnscopedWarningSet.has(warning)) return false;
        assignedUnscopedWarningSet.add(warning);
        return true;
      });
    const parseWarnings = [...new Set([...scopedPageWarnings, ...accountUnscopedWarnings])];
    const representative = bestOriginal(originals) || minimalAccount(accountTransactions[0]);
    const bankName = mostFrequent(accountTransactions.map(item => item.bankName).filter(isUsefulBankName))
      || representative.bankName || '待核验银行';
    const accountName = cleanAccountHolderName(mostFrequent(accountTransactions.map(item => item.accountName)) || representative.accountName);
    const totalIn = sum(accountTransactions.filter(item => item.direction === 'IN').map(item => item.amount));
    const totalOut = sum(accountTransactions.filter(item => item.direction === 'OUT').map(item => item.amount));
    const dates = accountTransactions.map(item => item.transactionDate).filter(Boolean).sort();
    const reviewIssues = [...new Map(originals.flatMap(item => item.reviewIssues || []).map(issue => [issue.id, issue])).values()];
    const continuityIssues = balanceContinuityIssues(accountTransactions);
    const hasDerivedIssues = accountTransactions.some(item => (item.extractionConfidence ?? 1) < 0.8
      || (item.amount <= 0 && !isFeeWaiver(item)) || !item.transactionDate || item.direction === 'UNKNOWN')
      || continuityIssues.length > 0;

    const balanceAvailable = accountTransactions.some(item => item.balanceAvailable !== false);
    const chronological = chronologicalTransactions(accountTransactions);
    const firstWithBalance = chronological.find(item => item.balanceAvailable !== false && item.balance != null);
    const lastWithBalance = [...chronological].reverse().find(item => item.balanceAvailable !== false && item.balance != null);

    let startBalance = representative.startBalance ?? 0;
    let endBalance = representative.endBalance ?? (lastWithBalance?.balance ?? 0);

    if (firstWithBalance && firstWithBalance.balance != null && firstWithBalance.amount > 0) {
      const inferredStart = firstWithBalance.direction === 'IN'
        ? firstWithBalance.balance - firstWithBalance.amount
        : firstWithBalance.direction === 'OUT'
        ? firstWithBalance.balance + firstWithBalance.amount
        : firstWithBalance.balance;
      startBalance = inferredStart;
    }
    if (lastWithBalance && lastWithBalance.balance != null) {
      endBalance = lastWithBalance.balance;
    }

    const balanceDiff = balanceAvailable ? Math.abs(startBalance + totalIn - totalOut - endBalance) : 0;

    accounts.push({
      ...representative,
      accountNumber: accountTransactions[0].accountNumber,
      accountName,
      bankName,
      ownerType: preferredOwnerType(originals),
      fileName: accountTransactions[0].rawSourceFile,
      totalIn, totalOut, transactionCount: accountTransactions.length,
      startDate: dates[0] || '', endDate: dates[dates.length - 1] || '',
      startBalance, endBalance, balanceAvailable,
      balanceDiff, isBalanced: balanceAvailable && balanceDiff < 1,
      parseWarnings, coveredPages: pages,
      parseStatus: parseWarnings.length || hasDerivedIssues ? 'NEEDS_REVIEW' : 'COMPLETE',
      balanceContinuityIssueCount: continuityIssues.length,
      reviewIssues
    });
  }

  const orphanWarnings = pageWarnings.filter(warning => !coveredWarningSet.has(warning));
  let unassignedUnscopedWarnings = unscopedWarnings.filter(warning => !assignedUnscopedWarningSet.has(warning));
  // Previously normalized browser data may already contain file-level warnings on a
  // synthetic review account. Migrate those warnings back to a real account from the
  // same source file so refreshing an existing import also removes the stale card.
  if (accounts.length && unassignedUnscopedWarnings.length) {
    for (const warning of unassignedUnscopedWarnings) {
      const sourceFile = inputAccounts.find(account => account.parseWarnings?.includes(warning))?.fileName;
      const target = accounts.find(account => sourceFile && account.fileName === sourceFile) || accounts[0];
      target.parseWarnings = [...new Set([...(target.parseWarnings || []), warning])];
      target.parseStatus = 'NEEDS_REVIEW';
      assignedUnscopedWarningSet.add(warning);
    }
    unassignedUnscopedWarnings = unscopedWarnings.filter(warning => !assignedUnscopedWarningSet.has(warning));
  }
  const documentWarnings = [...new Set([...unassignedUnscopedWarnings, ...orphanWarnings])];
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
    if (reliableKeys.size >= 1) {
      // Unify all rows on a single page to the dominant reliable account
      const counts = new Map<string, { item: StandardTransaction; count: number }>();
      for (const item of reliable) {
        const k = accountNumberKey(item);
        const curr = counts.get(k);
        counts.set(k, { item, count: (curr?.count || 0) + 1 });
      }
      const primary = [...counts.values()].sort((a, b) => b.count - a.count)[0].item;
      for (const transaction of pageTransactions) {
        copyIdentity(transaction, primary);
      }
      continue;
    }
    const previous = [...transactions].reverse().find(item => (item.rawPageNumber || 0) < page && isReliableAccountNumber(item.accountNumber));
    const next = transactions.find(item => (item.rawPageNumber || 0) > page && isReliableAccountNumber(item.accountNumber));
    if (previous && next && accountNumberKey(previous) === accountNumberKey(next)) {
      for (const transaction of pageTransactions) copyIdentity(transaction, previous);
    } else if (previous) {
      for (const transaction of pageTransactions) copyIdentity(transaction, previous);
    }
  }

  // Cross-page account aliasing / bridging for interleaved statements
  return unifyInterleavedStatementAccounts(transactions);
}

function unifyInterleavedStatementAccounts(transactions: StandardTransaction[]): StandardTransaction[] {
  const accountsByBank = new Map<string, Set<string>>();
  for (const t of transactions) {
    if (!isReliableAccountNumber(t.accountNumber)) continue;
    const b = normalizeAccountIdentityPart(t.bankName || '');
    const acc = normalizeAccountIdentityPart(t.accountNumber);
    const set = accountsByBank.get(b) || new Set();
    set.add(acc);
    accountsByBank.set(b, set);
  }

  for (const [, accSet] of accountsByBank) {
    if (accSet.size < 2) continue;
    const accList = [...accSet];
    for (let i = 0; i < accList.length; i++) {
      for (let j = i + 1; j < accList.length; j++) {
        const acc1 = accList[i];
        const acc2 = accList[j];
        const combined = transactions
          .filter(t => {
            const a = normalizeAccountIdentityPart(t.accountNumber);
            return a === acc1 || a === acc2;
          })
          .sort((a, b) => (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0));

        let transitions = 0;
        let continuousHits = 0;
        for (let k = 1; k < combined.length; k++) {
          const prev = combined[k - 1];
          const curr = combined[k];
          const prevAcc = normalizeAccountIdentityPart(prev.accountNumber);
          const currAcc = normalizeAccountIdentityPart(curr.accountNumber);
          if (prevAcc !== currAcc) {
            transitions++;
            if (prev.balance != null && curr.balance != null && curr.direction !== 'UNKNOWN') {
              const delta = curr.direction === 'IN' ? curr.amount : -curr.amount;
              if (Math.abs(prev.balance + delta - curr.balance) < 1) {
                continuousHits++;
              }
            }
          }
        }

        if (continuousHits > 0 || transitions >= 2) {
          const count1 = combined.filter(t => normalizeAccountIdentityPart(t.accountNumber) === acc1).length;
          const count2 = combined.filter(t => normalizeAccountIdentityPart(t.accountNumber) === acc2).length;
          const targetAcc = count1 >= count2 ? acc1 : acc2;
          const sourceAcc = count1 >= count2 ? acc2 : acc1;
          const targetItem = combined.find(t => normalizeAccountIdentityPart(t.accountNumber) === targetAcc)!;

          for (const t of transactions) {
            if (normalizeAccountIdentityPart(t.accountNumber) === sourceAcc) {
              t.accountNumber = targetItem.accountNumber;
              if (targetItem.accountName) t.accountName = targetItem.accountName;
            }
          }
        }
      }
    }
  }

  return transactions;
}

function healSummaryOverriddenAmounts(transactions: StandardTransaction[]): StandardTransaction[] {
  const sorted = [...transactions].sort((a, b) => (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0));
  const creditCardKeys = creditCardAccountKeys(sorted);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (creditCardKeys.has(accountIdentityKey(curr))) continue;
    if (
      prev.balanceAvailable === false ||
      curr.balanceAvailable === false ||
      curr.direction === 'UNKNOWN' ||
      prev.balance == null ||
      curr.balance == null
    ) {
      continue;
    }

    const delta = curr.direction === 'IN' ? curr.amount : -curr.amount;
    const diff = Math.abs(prev.balance + delta - curr.balance);
    if (diff >= 1) {
      const impliedAmount = curr.direction === 'OUT' ? prev.balance - curr.balance : curr.balance - prev.balance;
      if (impliedAmount > 0) {
        const impliedRounded = Math.round(impliedAmount * 100) / 100;
        const impliedStr = impliedRounded.toFixed(2);
        const currAmtStr = curr.amount.toFixed(2);
        const summaryHasCurrAmt = curr.summary && (curr.summary.includes(currAmtStr) || curr.summary.includes(String(curr.amount)));
        const rawTextHasImplied = curr.rawText && (curr.rawText.includes(impliedStr) || curr.rawText.includes(String(impliedRounded)));
        if (summaryHasCurrAmt && rawTextHasImplied) {
          recordCorrection(curr, '摘要金额与交易列冲突，系统依据原始行及余额关系提出修正');
          curr.amount = impliedRounded;
        }
      }
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

function upgradeLegacyGeminiReviewStatus(transaction: StandardTransaction): StandardTransaction {
  const isLegacyBlanketPending = transaction.extractionMethod === 'GEMINI_DIRECT_PDF'
    && transaction.reviewStatus === 'PENDING'
    && transaction.extractionConfidence === 0.75
    && !transaction.dataQualityIssues?.length
    && !transaction.correctionReason;
  return isLegacyBlanketPending
    ? { ...transaction, extractionConfidence: 0.9, reviewStatus: 'AUTO_PASSED' }
    : transaction;
}

function restoreUnsupportedBalanceCorrections(transactions: StandardTransaction[]): StandardTransaction[] {
  const creditCardKeys = creditCardAccountKeys(transactions);
  return transactions.map(transaction => {
    const reason = transaction.correctionReason || '';
    const isBridgeCorrection = reason === '系统依据前后余额桥接关系提出金额及余额修正';
    const isTwoRowCorrection = reason === '系统依据相邻余额关系提出金额修正';
    if (!isBridgeCorrection && !isTwoRowCorrection) return transaction;

    const strictDigitBridge = isBridgeCorrection
      && transaction.originalAmount !== undefined
      && transaction.originalBalance !== undefined
      && isOcrDigitVariant(transaction.originalAmount.toFixed(2), transaction.amount.toFixed(2))
      && isOcrDigitVariant(transaction.originalBalance.toFixed(2), transaction.balance.toFixed(2));
    if (!creditCardKeys.has(accountIdentityKey(transaction)) && strictDigitBridge) {
      return {
        ...transaction,
        reviewStatus: !transaction.dataQualityIssues?.length && (transaction.extractionConfidence ?? 0) >= 0.8
          ? 'AUTO_PASSED'
          : transaction.reviewStatus
      };
    }
    if (!creditCardKeys.has(accountIdentityKey(transaction)) && isTwoRowCorrection) return transaction;

    return {
      ...transaction,
      amount: transaction.originalAmount ?? transaction.amount,
      balance: transaction.originalBalance ?? transaction.balance,
      reviewStatus: transaction.dataQualityIssues?.length ? 'PENDING' : 'AUTO_PASSED',
      correctionReason: undefined,
      originalAmount: undefined,
      originalBalance: undefined,
      originalDirection: undefined
    };
  });
}

function creditCardAccountKeys(transactions: StandardTransaction[]): Set<string> {
  const groups = new Map<string, StandardTransaction[]>();
  for (const transaction of transactions) {
    const key = accountIdentityKey(transaction);
    groups.set(key, [...(groups.get(key) || []), transaction]);
  }
  return new Set([...groups].filter(([, rows]) => isCreditCardStatement(rows)).map(([key]) => key));
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

export interface DeduplicateTransactionsResult {
  transactions: StandardTransaction[];
  mergedPagesByAccount: Map<string, Set<number>>;
}

export function deduplicateTransactions(transactions: StandardTransaction[]): DeduplicateTransactionsResult {
  const result: StandardTransaction[] = [];
  const mergedPagesByAccount = new Map<string, Set<number>>();
  const matchedTargetsByPage = new Map<number, Set<number>>();

  const sorted = [...transactions].sort(compareSourceOrder);

  for (const candidate of sorted) {
    const accKey = accountIdentityKey(candidate);
    const candPage = candidate.rawPageNumber || 0;
    const pageMatched = matchedTargetsByPage.get(candPage) || new Set<number>();
    let matchedIdx = -1;

    for (let i = 0; i < result.length; i++) {
      if (pageMatched.has(i)) continue;
      const target = result[i];
      if (areTransactionsDuplicate(target, candidate)) {
        matchedIdx = i;
        break;
      }
    }

    if (matchedIdx !== -1) {
      const target = result[matchedIdx];
      mergeDuplicateTransactions(target, candidate);
      pageMatched.add(matchedIdx);
      matchedTargetsByPage.set(candPage, pageMatched);

      if (candidate.rawPageNumber) {
        const pages = mergedPagesByAccount.get(accKey) || new Set<number>();
        pages.add(candidate.rawPageNumber);
        mergedPagesByAccount.set(accKey, pages);
      }
    } else {
      result.push({ ...candidate });
    }
  }

  return { transactions: result, mergedPagesByAccount };
}

function areTransactionsDuplicate(a: StandardTransaction, b: StandardTransaction): boolean {
  // 1. Account matching
  const accA = normalizeAccountIdentityPart(a.accountNumber);
  const accB = normalizeAccountIdentityPart(b.accountNumber);
  if (accA && accB && accA !== accB) return false;

  // 2. Date matching (YYYY-MM-DD)
  const dateA = (a.transactionDate || '').slice(0, 10);
  const dateB = (b.transactionDate || '').slice(0, 10);
  if (!dateA || !dateB || dateA !== dateB) return false;

  // 3. Direction matching
  if (a.direction !== 'UNKNOWN' && b.direction !== 'UNKNOWN' && a.direction !== b.direction) {
    return false;
  }

  // 4. Amount matching
  if (Math.abs(a.amount - b.amount) >= 0.01) {
    return false;
  }

  // 5. Time-of-day compatibility
  const timeA = extractTimeOfDay(a.transactionTime);
  const timeB = extractTimeOfDay(b.transactionTime);
  if (timeA && timeB && !timesCompatible(timeA, timeB)) {
    return false;
  }

  // 6. Balance checking
  const hasBalA = a.balanceAvailable !== false && a.balance != null;
  const hasBalB = b.balanceAvailable !== false && b.balance != null;

  if (hasBalA && hasBalB) {
    if (Math.abs(a.balance - b.balance) >= 0.01) {
      return false;
    }

    // Both have identical balance, date, direction, amount, and compatible time
    if (a.rawPageNumber && b.rawPageNumber && a.rawPageNumber !== b.rawPageNumber) {
      const sA = cleanSummaryForMatch(a.summary);
      const sB = cleanSummaryForMatch(b.summary);
      const cpA = cleanSummaryForMatch(a.counterpartyName);
      const cpB = cleanSummaryForMatch(b.counterpartyName);
      const pageDiff = Math.abs(a.rawPageNumber - b.rawPageNumber);

      // 1. If both have granular time, they must match
      if (timeA && timeB) {
        return timeA === timeB;
      }

      // 2. If both have non-empty summary, they must match/overlap
      if (sA && sB) {
        return sA.includes(sB) || sB.includes(sA);
      }

      // 3. If non-adjacent pages (|pageDiff| >= 2, e.g. cross-template reprints like Page 4 vs Page 13)
      if (pageDiff >= 2) {
        if (cpA && cpB && (cpA.includes(cpB) || cpB.includes(cpA))) {
          return true;
        }
        if (sA || sB) {
          return true;
        }
      }

      // 4. For adjacent pages without time and without summary, do not assume duplicate
      return false;
    }

    // Same page duplicate: require time match or summary match
    const sA = cleanSummaryForMatch(a.summary);
    const sB = cleanSummaryForMatch(b.summary);
    if ((timeA && timeB && timeA === timeB) || (sA && sB && sA === sB) || (!sA && !sB)) {
      return true;
    }
    return false;
  }

  // 7. Balance not available on at least one side
  if (a.rawPageNumber && b.rawPageNumber && a.rawPageNumber === b.rawPageNumber) {
    if (a.rawText && b.rawText && a.rawText === b.rawText) return true;
    return false;
  }

  // Cross-page without balance
  if (timeA && timeB && timeA === timeB && timeA.split(':').length === 3) {
    return true;
  }

  const sA = cleanSummaryForMatch(a.summary);
  const sB = cleanSummaryForMatch(b.summary);
  if (sA && sB && (sA.includes(sB) || sB.includes(sA))) {
    return true;
  }

  const cpA = cleanSummaryForMatch(a.counterpartyName);
  const cpB = cleanSummaryForMatch(b.counterpartyName);
  if (cpA && cpB && (cpA.includes(cpB) || cpB.includes(cpA))) {
    return true;
  }

  return false;
}

function extractTimeOfDay(timeStr?: string): string {
  if (!timeStr) return '';
  const trimmed = timeStr.trim();
  const match = trimmed.match(/(\d{2}:\d{2}(?::\d{2})?)/);
  if (match) {
    return match[1];
  }
  return '';
}

function timesCompatible(t1: string, t2: string): boolean {
  if (!t1 || !t2) return true;
  const parts1 = t1.split(':');
  const parts2 = t2.split(':');
  if (parts1[0] !== parts2[0]) return false;
  if (parts1[1] !== parts2[1]) return false;
  if (parts1[2] !== undefined && parts2[2] !== undefined) {
    return parts1[2] === parts2[2];
  }
  return true;
}

function cleanSummaryForMatch(str?: string): string {
  if (!str) return '';
  return str.replace(/[\s\-_@#*|/\\.,:;，。、：；]/g, '').trim().toLowerCase();
}

function mergeDuplicateTransactions(kept: StandardTransaction, dup: StandardTransaction): StandardTransaction {
  if ((!kept.summary || kept.summary.length < (dup.summary?.length || 0)) && dup.summary) {
    kept.summary = dup.summary;
  }
  if (!kept.counterpartyName && dup.counterpartyName) {
    kept.counterpartyName = dup.counterpartyName;
  }
  if (!kept.counterpartyAccount && dup.counterpartyAccount) {
    kept.counterpartyAccount = dup.counterpartyAccount;
  }
  if (!kept.counterpartyBank && dup.counterpartyBank) {
    kept.counterpartyBank = dup.counterpartyBank;
  }
  if (dup.transactionTime && dup.transactionTime.length > (kept.transactionTime?.length || 0)) {
    kept.transactionTime = dup.transactionTime;
  }
  if ((kept.balance == null || kept.balanceAvailable === false) && dup.balance != null && dup.balanceAvailable !== false) {
    kept.balance = dup.balance;
    kept.balanceAvailable = true;
  }
  if ((dup.extractionConfidence || 0) > (kept.extractionConfidence || 0)) {
    kept.extractionConfidence = dup.extractionConfidence;
  }
  return kept;
}

export function calibrateDirectionsByBalanceMath(transactions: StandardTransaction[]): StandardTransaction[] {
  const byAccount = new Map<string, StandardTransaction[]>();
  for (const tx of transactions) {
    const key = accountIdentityKey(tx);
    byAccount.set(key, [...(byAccount.get(key) || []), tx]);
  }

  for (const [, accTxs] of byAccount) {
    const sourceOrdered = [...accTxs].sort(compareSourceOrder);
    let forwardDatePairs = 0;
    let reverseDatePairs = 0;
    for (let i = 1; i < sourceOrdered.length; i++) {
      const prevDate = (sourceOrdered[i - 1].transactionDate || '').trim();
      const currDate = (sourceOrdered[i].transactionDate || '').trim();
      if (prevDate && currDate && prevDate !== currDate) {
        if (prevDate < currDate) forwardDatePairs++;
        else if (prevDate > currDate) reverseDatePairs++;
      }
    }
    const isReverseStatement = reverseDatePairs > forwardDatePairs && reverseDatePairs >= 1;
    const physicalChronological = isReverseStatement ? [...sourceOrdered].reverse() : sourceOrdered;

    for (let i = 1; i < physicalChronological.length; i++) {
      const prev = physicalChronological[i - 1];
      const curr = physicalChronological[i];

      if (
        prev.balanceAvailable === false ||
        curr.balanceAvailable === false ||
        prev.balance == null ||
        curr.balance == null ||
        curr.amount <= 0
      ) {
        continue;
      }

      const diffIn = Math.abs(prev.balance + curr.amount - curr.balance);
      const diffOut = Math.abs(prev.balance - curr.amount - curr.balance);

      if (diffIn < 0.05 && diffOut >= 0.05 && curr.direction !== 'IN') {
        recordCorrection(curr, '系统依据相邻余额关系修正收支方向');
        curr.direction = 'IN';
        if (curr.reviewStatus === 'AUTO_PASSED') {
          curr.reviewStatus = 'CORRECTED';
        }
      } else if (diffOut < 0.05 && diffIn >= 0.05 && curr.direction !== 'OUT') {
        recordCorrection(curr, '系统依据相邻余额关系修正收支方向');
        curr.direction = 'OUT';
        if (curr.reviewStatus === 'AUTO_PASSED') {
          curr.reviewStatus = 'CORRECTED';
        }
      }
      if (
        curr.correctionReason === '系统依据相邻余额关系修正收支方向'
        && curr.originalAmount === curr.amount
        && curr.originalBalance === curr.balance
        && !curr.dataQualityIssues?.length
        && (curr.extractionConfidence ?? 0) >= 0.8
        && ((curr.direction === 'IN' && diffIn < 0.05) || (curr.direction === 'OUT' && diffOut < 0.05))
      ) {
        curr.reviewStatus = 'AUTO_PASSED';
      }
    }
  }

  return transactions;
}

/**
 * Mathematically heals single-transaction OCR digit errors (e.g. faint dot-matrix printer font
 * where '4' was misrecognized as '1', or comma shifts) by reconciling the balance bridge between T_{i-1}, T_i, and T_{i+1}.
 */
export function healOcrBalanceAndAmountDiscrepancies(transactions: StandardTransaction[]): StandardTransaction[] {
  const byAccount = new Map<string, StandardTransaction[]>();
  for (const tx of transactions) {
    const key = accountIdentityKey(tx);
    byAccount.set(key, [...(byAccount.get(key) || []), tx]);
  }

  for (const [, accTxs] of byAccount) {
    if (accTxs.length < 2) continue;
    if (isCreditCardStatement(accTxs)) continue;

    const ordered = chronologicalTransactions(accTxs);

    // Pass 1: Bridge healing across three consecutive transactions (T_{i-1}, T_i, T_{i+1})
    // Where T_i has OCR digit misreads in amount and/or balance, but T_{i-1} and T_{i+1} have solid balances.
    for (let i = 1; i < ordered.length - 1; i++) {
      const prev = ordered[i - 1];
      const curr = ordered[i];
      const next = ordered[i + 1];

      if (
        prev.balanceAvailable === false || curr.balanceAvailable === false || next.balanceAvailable === false ||
        prev.balance == null || curr.balance == null || next.balance == null ||
        curr.direction === 'UNKNOWN' || next.direction === 'UNKNOWN'
      ) {
        continue;
      }

      // Check current discontinuity around curr
      const deltaCurr = curr.direction === 'IN' ? curr.amount : -curr.amount;
      const errPrevCurr = Math.abs(prev.balance + deltaCurr - curr.balance);

      const deltaNext = next.direction === 'IN' ? next.amount : -next.amount;
      const errCurrNext = Math.abs(curr.balance + deltaNext - next.balance);

      // If there is a break around curr (either before or after)
      if (errPrevCurr >= 0.5 || errCurrNext >= 0.5) {
        // Implied balance of curr deduced from next
        const impliedBalCurr = Math.round((next.direction === 'OUT' ? next.balance + next.amount : next.balance - next.amount) * 100) / 100;
        // Implied amount of curr deduced from prev and impliedBalCurr
        const impliedAmtCurr = Math.round(Math.abs(curr.direction === 'IN' ? impliedBalCurr - prev.balance : prev.balance - impliedBalCurr) * 100) / 100;

        // Verify that this implied state is directionally consistent and positive
        const impliedDelta = curr.direction === 'IN' ? impliedAmtCurr : -impliedAmtCurr;
        const testErrPrev = Math.abs(prev.balance + impliedDelta - impliedBalCurr);
        const testErrNext = Math.abs(impliedBalCurr + deltaNext - next.balance);

        if (testErrPrev < 0.05 && testErrNext < 0.05 && impliedAmtCurr > 0) {
          const currAmtStr = curr.amount.toFixed(2);
          const impliedAmtStr = impliedAmtCurr.toFixed(2);
          const currBalStr = curr.balance.toFixed(2);
          const impliedBalStr = impliedBalCurr.toFixed(2);

          const isAmtPlausible =
            curr.amount === impliedAmtCurr ||
            isOcrDigitVariant(currAmtStr, impliedAmtStr) ||
            (curr.rawText && (curr.rawText.includes(impliedAmtStr) || curr.rawText.includes(String(impliedAmtCurr)))) ||
            (curr.summary && (curr.summary.includes(impliedAmtStr) || curr.summary.includes(String(impliedAmtCurr))));

          const isBalPlausible =
            curr.balance === impliedBalCurr ||
            isOcrDigitVariant(currBalStr, impliedBalStr);

          if (isAmtPlausible && isBalPlausible) {
            recordCorrection(curr, '系统依据前后余额桥接关系提出金额及余额修正');
            curr.amount = impliedAmtCurr;
            curr.balance = impliedBalCurr;
            if (
              isOcrDigitVariant(currAmtStr, impliedAmtStr)
              && isOcrDigitVariant(currBalStr, impliedBalStr)
              && !curr.dataQualityIssues?.length
              && (curr.extractionConfidence ?? 0) >= 0.8
            ) {
              curr.reviewStatus = 'AUTO_PASSED';
            }
          }
        }
      }
    }

    // Pass 2: Two-transaction balance or amount healing (T_{i-1} and T_i)
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const curr = ordered[i];

      if (
        prev.balanceAvailable === false || curr.balanceAvailable === false ||
        prev.balance == null || curr.balance == null ||
        curr.direction === 'UNKNOWN'
      ) {
        continue;
      }

      const delta = curr.direction === 'IN' ? curr.amount : -curr.amount;
      const diff = Math.abs(prev.balance + delta - curr.balance);

      if (diff >= 0.5) {
        const impliedAmt = Math.round(Math.abs(curr.direction === 'IN' ? curr.balance - prev.balance : prev.balance - curr.balance) * 100) / 100;
        if (impliedAmt > 0) {
          const impliedStr = impliedAmt.toFixed(2);
          const currAmtStr = curr.amount.toFixed(2);

          if (
            isOcrDigitVariant(currAmtStr, impliedStr) ||
            (curr.rawText && (curr.rawText.includes(impliedStr) || curr.rawText.includes(String(impliedAmt)))) ||
            (curr.summary && (curr.summary.includes(impliedStr) || curr.summary.includes(String(impliedAmt))))
          ) {
            recordCorrection(curr, '系统依据相邻余额关系提出金额修正');
            curr.amount = impliedAmt;
            if (curr.reviewStatus === 'AUTO_PASSED') {
              curr.reviewStatus = 'CORRECTED';
            }
          }
        }
      }
    }
  }

  return transactions;
}

function isOcrDigitVariant(strA: string, strB: string): boolean {
  if (strA === strB) return true;
  if (Math.abs(strA.length - strB.length) > 1) return false;
  if (strA.length === strB.length) {
    let diffCount = 0;
    for (let i = 0; i < strA.length; i++) {
      if (strA[i] !== strB[i]) {
        diffCount++;
      }
    }
    if (diffCount <= 1) return true;
  }
  return false;
}

function recordCorrection(transaction: StandardTransaction, reason: string): void {
  if (transaction.originalAmount === undefined) transaction.originalAmount = transaction.amount;
  if (transaction.originalBalance === undefined && transaction.balance != null) transaction.originalBalance = transaction.balance;
  if (transaction.originalDirection === undefined) transaction.originalDirection = transaction.direction;
  transaction.correctionReason = transaction.correctionReason
    ? `${transaction.correctionReason}；${reason}`
    : reason;
  transaction.reviewStatus = 'CORRECTED';
}
