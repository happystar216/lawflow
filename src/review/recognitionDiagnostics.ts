import { auditAccountBalance } from '../parsers/sanityChecker';
import { BankAccount, EvidenceReviewIssue, StandardTransaction } from '../types/transaction';
import { transactionBelongsToAccount } from '../utils/accountIdentity';
import { buildEvidenceReviewIssues } from './buildEvidenceReviewIssues';

export function formatRecognitionDiagnostics(
  accounts: BankAccount[],
  transactions: StandardTransaction[]
): string {
  const accountDetails = accounts.map(account => {
    const accountTransactions = transactions.filter(transaction => transactionBelongsToAccount(transaction, account));
    const issues = buildEvidenceReviewIssues(account, transactions).filter(issue => (
      issue.status !== 'CONFIRMED' || issue.severity === 'ADVISORY'
    ));
    const audit = auditAccountBalance(account, transactions);
    const issueByTransaction = new Map<string, EvidenceReviewIssue[]>();
    for (const issue of issues) {
      for (const id of issue.transactionIds) {
        issueByTransaction.set(id, [...(issueByTransaction.get(id) || []), issue]);
      }
    }
    const anomalousTransactions = accountTransactions.filter(transaction => (
      issueByTransaction.has(transaction.id)
      || transaction.reviewStatus === 'PENDING'
      || Boolean(transaction.dataQualityIssues?.length)
      || (transaction.extractionConfidence ?? 1) < 0.8
      || Boolean(transaction.correctionReason)
    ));
    return { account, accountTransactions, issues, audit, issueByTransaction, anomalousTransactions };
  });
  const fileNames = [...new Set(accounts.map(account => account.fileName).filter(Boolean))];
  const outstandingIssues = accountDetails.flatMap(detail => detail.issues)
    .filter(issue => issue.status === 'PENDING' || issue.status === 'UNRESOLVED');
  const unbalanced = accountDetails.filter(detail => detail.audit.isAuditable && !detail.audit.isBalanced);
  const anomalyIds = new Set(accountDetails.flatMap(detail => detail.anomalousTransactions.map(transaction => transaction.id)));
  const lines: string[] = [
    '# 银行流水识别异常汇总',
    '',
    '## 总览',
    `- 文件：${fileNames.length} 个`,
    `- 账户：${accounts.length} 个`,
    `- 流水：${transactions.length} 笔`,
    `- 待处理问题：${outstandingIssues.length} 项`,
    `- 未平账账户：${unbalanced.length} 个`,
    `- 涉及异常的流水：${anomalyIds.size} 笔`,
  ];

  for (const fileName of fileNames) {
    const details = accountDetails.filter(detail => detail.account.fileName === fileName);
    const warnings = [...new Set(details.flatMap(detail => detail.account.parseWarnings || []))];
    lines.push('', `## 文件：${fileName}`);
    if (warnings.length) {
      lines.push('', '### 文件整体提示');
      warnings.forEach((warning, index) => lines.push(`${index + 1}. ${warning}`));
    }
    for (const detail of details) appendAccount(lines, detail);
  }

  if (!fileNames.length) lines.push('', '未找到已导入文件。');
  if (!outstandingIssues.length && !unbalanced.length && !anomalyIds.size) {
    lines.push('', '## 结论', '', '当前没有发现需要复制的识别异常。');
  }
  return lines.join('\n');
}

function appendAccount(
  lines: string[],
  detail: {
    account: BankAccount;
    accountTransactions: StandardTransaction[];
    issues: EvidenceReviewIssue[];
    audit: ReturnType<typeof auditAccountBalance>;
    issueByTransaction: Map<string, EvidenceReviewIssue[]>;
    anomalousTransactions: StandardTransaction[];
  }
): void {
  const { account, accountTransactions, issues, audit, issueByTransaction, anomalousTransactions } = detail;
  const label = `${account.bankName}（尾号 ${account.accountNumber.slice(-4) || '未知'}）`;
  lines.push('', `### 账户：${label}`);
  lines.push(`- 户名：${account.accountName || '待核对'}`);
  lines.push(`- 完整账号：${account.accountNumber || '待核对'}`);
  lines.push(`- 识别状态：${account.parseStatus || '未标记'}`);
  lines.push(`- 流水数量：${accountTransactions.length} 笔`);
  lines.push(`- 时间跨度：${account.startDate || '待核对'} ～ ${account.endDate || '待核对'}`);
  if (audit.isAuditable) {
    lines.push(`- 平账状态：${audit.isBalanced ? '已平账' : `未平账，相差 ¥${money(audit.difference)}`}`);
    if (!audit.isBalanced) {
      lines.push(`- 平账公式：期初 ¥${money(account.startBalance)} + 收入 ¥${money(audit.totalIncome)} - 支出 ¥${money(audit.totalExpense)} = 系统期末 ¥${money(audit.calculatedEndBalance)}；原件期末 ¥${money(audit.statedEndBalance)}`);
    }
  } else {
    lines.push(`- 平账状态：${audit.unavailableReason === 'CREDIT_CARD_STATEMENT' ? '信用卡账单，不适用储蓄卡逐笔平账' : '缺少可靠余额，无法计算'}`);
  }

  if (issues.length) {
    lines.push('', '#### 页面／账户问题');
    issues.forEach((issue, index) => {
      lines.push(`${index + 1}. [${severity(issue)}｜${status(issue)}] ${issue.title}`);
      lines.push(`   - 说明：${issue.description}`);
      if (issue.instructions.length) lines.push(`   - 需要确认：${issue.instructions.join('；')}`);
      if (issue.pageNumber) lines.push(`   - 原件位置：第 ${issue.pageNumber} 页`);
      if (issue.transactionIds.length) lines.push(`   - 涉及流水：${issue.transactionIds.length} 笔`);
    });
  }

  if (anomalousTransactions.length) {
    lines.push('', `#### 单笔异常流水（${anomalousTransactions.length} 笔）`);
    anomalousTransactions.forEach((transaction, index) => {
      const related = issueByTransaction.get(transaction.id) || [];
      const reasons = transactionReasons(transaction, related);
      lines.push(`${index + 1}. 第 ${transaction.rawPageNumber || '?'} 页第 ${transaction.rawRowIndex || '?'} 行｜${transaction.transactionTime || '日期待核对'}｜${direction(transaction)}｜¥${money(transaction.amount)}｜余额 ${transaction.balanceAvailable === false ? '未读取' : `¥${money(transaction.balance)}`}`);
      lines.push(`   - 本方账户：${transaction.bankName} ${transaction.accountNumber}`);
      lines.push(`   - 对手方：${transaction.counterpartyName || '未识别'}${transaction.counterpartyAccount ? `（${transaction.counterpartyAccount}）` : ''}`);
      lines.push(`   - 摘要：${transaction.summary || '未识别'}`);
      lines.push(`   - 需要核对：${reasons.join('；') || '对照原件确认该行字段'}`);
      lines.push(`   - 识别把握度：${transaction.extractionConfidence === undefined ? '未提供' : `${Math.round(transaction.extractionConfidence * 100)}%`}`);
      if (transaction.originalAmount !== undefined) lines.push(`   - 金额原识别值：¥${money(transaction.originalAmount)}；当前值：¥${money(transaction.amount)}`);
      if (transaction.originalBalance !== undefined) lines.push(`   - 余额原识别值：¥${money(transaction.originalBalance)}；当前值：¥${money(transaction.balance)}`);
      if (transaction.originalDirection) lines.push(`   - 方向原识别值：${transaction.originalDirection}；当前值：${transaction.direction}`);
      if (transaction.rawText) lines.push(`   - 识别原文：${transaction.rawText}`);
    });
  }
}

function transactionReasons(transaction: StandardTransaction, issues: EvidenceReviewIssue[]): string[] {
  const reasons = issues.map(issue => issue.title);
  if ((transaction.extractionConfidence ?? 1) < 0.8) reasons.push('字段读取把握较低');
  if (transaction.dataQualityIssues?.includes('INVALID_DATE')) reasons.push('日期未能可靠读取');
  if (transaction.dataQualityIssues?.includes('INVALID_AMOUNT')) reasons.push('金额未能可靠读取');
  if (transaction.dataQualityIssues?.includes('UNKNOWN_DIRECTION') || transaction.direction === 'UNKNOWN') reasons.push('收入／支出方向未确认');
  if (transaction.correctionReason) reasons.push(transaction.correctionReason);
  return [...new Set(reasons)];
}

function money(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function direction(transaction: StandardTransaction): string {
  return transaction.direction === 'IN' ? '收入' : transaction.direction === 'OUT' ? '支出' : '方向待核对';
}

function severity(issue: EvidenceReviewIssue): string {
  return issue.severity === 'REQUIRED' ? '需处理' : '参考提示';
}

function status(issue: EvidenceReviewIssue): string {
  return issue.status === 'CONFIRMED' ? '已确认'
    : issue.status === 'CORRECTED' ? '已修正'
      : issue.status === 'UNRESOLVED' ? '无法确认' : '待核对';
}
