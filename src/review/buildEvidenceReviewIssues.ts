import { BankAccount, EvidenceReviewIssue, StandardTransaction } from '../types/transaction';
import { transactionBelongsToAccount } from '../utils/accountIdentity';
import { balanceContinuityIssues } from '../utils/transactionSequence';

export function buildEvidenceReviewIssues(
  account: BankAccount,
  allTransactions: StandardTransaction[]
): EvidenceReviewIssue[] {
  const transactions = allTransactions
    .filter(transaction => transactionBelongsToAccount(transaction, account))
    .sort(compareSourceOrder);
  const generated: EvidenceReviewIssue[] = [];
  const unscopedWarnings: string[] = [];

  for (const warning of account.parseWarnings || []) {
    if (isLegacyDerivedWarning(warning)) continue;
    let pageNumber = numberFrom(warning, /第\s*(\d+)\s*页/) || numberFrom(warning, /原PDF第\s*(\d+)\s*页/);
    const isBlank = /空白|扫描残页|未识别到交易/.test(warning);
    const isIntegrity = /汇总|缺少|漏|不完整|页面覆盖|识别失败|独立清点|独立行数复核/.test(warning);
    const countComparison = parseCountComparison(warning);
    if (!pageNumber && countComparison) pageNumber = inferUniquePageByCount(transactions, countComparison.detailCount);
    if (!pageNumber) {
      unscopedWarnings.push(warning);
      continue;
    }
    generated.push({
      id: stableIssueId(countComparison
        ? `${account.accountNumber}|count|${pageNumber}|${countComparison.summaryCount}|${countComparison.detailCount}`
        : `${account.accountNumber}|warning|${warning}`),
      category: isBlank ? 'BLANK_PAGE' : isIntegrity ? 'PAGE_INTEGRITY' : 'DATA_WARNING',
      severity: isBlank || isIntegrity ? 'REQUIRED' : 'ADVISORY',
      title: isBlank ? `第 ${pageNumber || '?'} 页疑似空白` : countComparison ? `第 ${pageNumber || '?'} 页两次计数不一致（${countComparison.summaryCount} / ${countComparison.detailCount}）` : isIntegrity ? `第 ${pageNumber || '?'} 页完整性核对` : '解析结果核对',
      description: countComparison
        ? `系统一次页面计数为 ${countComparison.summaryCount} 笔，逐笔提取为 ${countComparison.detailCount} 笔；两者均尚未经过律师确认，应以原始页面实际交易行数为准。`
        : warning,
      instructions: isBlank
        ? ['查看完整原始页面', '确认该页是否确实没有交易明细', '如存在交易，请补录遗漏记录']
        : isIntegrity
        ? countComparison
          ? [`直接清点原始页面实际交易行数`, `如原件为 ${countComparison.detailCount} 笔，确认保留全部明细`, `如原件少于 ${countComparison.detailCount} 笔，勾选并删除重复或误识别记录`, `如原件更多，补录遗漏记录`]
          : ['核对该页实际交易行数', '检查日期是否跳跃及余额是否无法衔接', '发现漏行时按原件补录']
        : ['对照原件核实提示内容', '记录确认结果或无法确认的原因'],
      pageNumber,
      transactionIds: pageNumber ? transactions.filter(transaction => transaction.rawPageNumber === pageNumber).map(transaction => transaction.id) : [],
      status: 'PENDING'
    });
  }

  if (unscopedWarnings.length) {
    const unique = [...new Set(unscopedWarnings)];
    generated.push({
      id: stableIssueId(`${account.accountNumber}|unscoped|${unique.join('|')}`),
      category: 'DATA_WARNING', severity: 'ADVISORY', title: `文件级读取提示（${unique.length} 条）`,
      description: unique.slice(0, 8).join('；') + (unique.length > 8 ? `；另有 ${unique.length - 8} 条提示` : ''),
      instructions: ['结合原始文件整体浏览', '如提示影响交易明细，再定位相关页面处理'],
      transactionIds: [], status: 'PENDING'
    });
  }

  appendTransactionIssueGroup(generated, account, transactions, 'LOW_CONFIDENCE',
    transaction => (transaction.extractionConfidence ?? 1) < 0.8,
    '识别结果待核对', '本页有交易字段读取把握较低，需与原件逐字段核对。',
    ['核对交易日期和收支方向', '核对金额及交易后余额', '核对对手方和摘要']);
  appendTransactionIssueGroup(generated, account, transactions, 'INVALID_AMOUNT',
    transaction => transaction.amount <= 0,
    '交易金额异常', '本页有交易金额为零或未能可靠读取。',
    ['核对原件发生额', '确认相关行是否属于交易明细', '修正金额或说明无法确认的原因']);
  appendTransactionIssueGroup(generated, account, transactions, 'INVALID_DATE',
    transaction => !transaction.transactionDate || Boolean(transaction.dataQualityIssues?.includes('INVALID_DATE')),
    '交易日期待核对', '本页有交易日期未能可靠读取。',
    ['对照原件补全交易日期和时间', '确认相关行确属于交易明细']);
  appendTransactionIssueGroup(generated, account, transactions, 'INVALID_DIRECTION',
    transaction => transaction.direction === 'UNKNOWN' || Boolean(transaction.dataQualityIssues?.includes('UNKNOWN_DIRECTION')),
    '收支方向待核对', '本页有交易的收入或支出方向尚未确认，目前不计入资金流向汇总。',
    ['核对原件借贷标识或收支栏', '确认为收入或支出并保存']);

  const balanceByPage = new Map<number, ReturnType<typeof balanceContinuityIssues>>();
  for (const issue of balanceContinuityIssues(transactions)) {
    const page = issue.transaction.rawPageNumber || 0;
    balanceByPage.set(page, [...(balanceByPage.get(page) || []), issue]);
  }
  for (const [pageNumber, pageIssues] of balanceByPage) {
    const transactionIds = [...new Set(pageIssues.flatMap(({ previous, transaction }) => [previous.id, transaction.id]))];
    generated.push({
        id: stableIssueId(`${account.accountNumber}|balance|${pageNumber}|${transactionIds.join('|')}`),
        category: 'BALANCE_BREAK', severity: 'REQUIRED',
        title: `第 ${pageNumber || '?'} 页余额不连续（${pageIssues.length} 处）`,
        description: `本页有 ${pageIssues.length} 处余额无法与相邻交易直接衔接，可能存在字段误读、漏行或跨账户分页。`,
        instructions: ['同时核对当前笔与上一笔', '确认金额、方向和余额是否识别正确', '检查两笔之间是否存在漏行'],
        pageNumber: pageNumber || undefined,
        transactionIds, status: 'PENDING'
      });
  }

  const existing = new Map((account.reviewIssues || []).map(issue => [issue.id, issue]));
  return deduplicate(generated).map(issue => {
    const saved = existing.get(issue.id);
    return saved ? { ...issue, status: saved.status, resolutionNote: saved.resolutionNote, reviewedAt: saved.reviewedAt } : issue;
  });
}

function appendTransactionIssueGroup(
  target: EvidenceReviewIssue[], account: BankAccount, transactions: StandardTransaction[],
  category: EvidenceReviewIssue['category'], matches: (transaction: StandardTransaction) => boolean,
  title: string, description: string, instructions: string[]
): void {
  const groups = groupByPage(transactions.filter(matches));
  for (const [pageNumber, affected] of groups) {
    target.push({
      id: stableIssueId(`${account.accountNumber}|${category}|${pageNumber}|${affected.map(item => item.id).join('|')}`),
      category, severity: 'REQUIRED',
      title: `第 ${pageNumber || '?'} 页${title}（${affected.length} 笔）`, description, instructions,
      pageNumber: pageNumber || undefined, transactionIds: affected.map(item => item.id), status: 'PENDING'
    });
  }
}

function groupByPage<T extends { rawPageNumber?: number }>(items: T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const page = item.rawPageNumber || 0;
    groups.set(page, [...(groups.get(page) || []), item]);
  }
  return groups;
}

function isLegacyDerivedWarning(warning: string): boolean {
  return /第\s*\d+\s*页第\s*\d+\s*笔交易余额不连续/.test(warning)
    || /识别置信度低于\s*80%/.test(warning)
    || /第\s*\d+\s*页第\s*\d+\s*笔(?:收支方向|交易金额)无法确认/.test(warning);
}

function deduplicate(issues: EvidenceReviewIssue[]): EvidenceReviewIssue[] {
  return [...new Map(issues.map(issue => [issue.id, issue])).values()];
}

function compareSourceOrder(a: StandardTransaction, b: StandardTransaction): number {
  return (a.rawPageNumber || 0) - (b.rawPageNumber || 0) || (a.rawRowIndex || 0) - (b.rawRowIndex || 0);
}

function numberFrom(value: string, pattern: RegExp): number | undefined {
  const match = value.match(pattern);
  return match ? Number(match[1]) : undefined;
}

function parseCountComparison(value: string): { summaryCount: number; detailCount: number } | undefined {
  const match = value.match(/页面汇总为\s*(\d+)\s*笔.*?(?:当前)?逐笔明细(?:实际)?(?:为|仅有)\s*(\d+)\s*笔/)
    || value.match(/页面汇总为\s*(\d+)\s*笔.*?自动复核后最多识别\s*(\d+)\s*笔/)
    || value.match(/页面计数为\s*(\d+)\s*笔.*?逐笔提取为\s*(\d+)\s*笔/)
    || value.match(/独立清点为\s*(\d+)\s*笔.*?逐笔明细为\s*(\d+)\s*笔/);
  return match ? { summaryCount: Number(match[1]), detailCount: Number(match[2]) } : undefined;
}

function inferUniquePageByCount(transactions: StandardTransaction[], detailCount: number): number | undefined {
  const counts = new Map<number, number>();
  for (const transaction of transactions) {
    if (!transaction.rawPageNumber) continue;
    counts.set(transaction.rawPageNumber, (counts.get(transaction.rawPageNumber) || 0) + 1);
  }
  const candidates = [...counts.entries()].filter(([, count]) => count === detailCount).map(([page]) => page);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function stableIssueId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `REVIEW_${(hash >>> 0).toString(36).toUpperCase()}`;
}
