import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { CaseMetadata } from '../types/case';
import { CaseEvaluationReport } from '../types/evidence';
import { StandardTransaction } from '../types/transaction';

/**
 * Exports comprehensive multi-sheet Excel spreadsheet for court cross-examination.
 */
export function exportCourtEvidenceExcel(
  caseMeta: CaseMetadata,
  report: CaseEvaluationReport,
  transactions: StandardTransaction[]
): void {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Suspicious Transactions for Court
  const adoptedMatches = report.matches.filter(m => m.lawyerAdopted);
  const txMap = new Map<string, StandardTransaction>();
  transactions.forEach(t => txMap.set(t.id, t));

  const courtData = adoptedMatches.map((m, idx) => {
    const firstTx = m.transactionIds.length > 0 ? txMap.get(m.transactionIds[0]) : undefined;
    return {
      '序号': idx + 1,
      '法律时间阶段': m.timePhase,
      '交易日期': firstTx?.transactionDate || '',
      '转出账号/卡号': firstTx?.accountNumber || '',
      '转出金额(元)': m.totalAmount,
      '对手方户名': m.counterpartyName || '未知',
      '对手方身份标注': firstTx?.counterpartyRoleTag || '待补充',
      '转账附言/摘要': firstTx?.summary || '',
      '命中异常特征': m.ruleName,
      '严重等级': m.severity,
      '关联主要法条': m.statutoryBasis[0] || '',
      '事实说明与异常理由': m.lawyerNotes || m.aiReasoning,
      '原始凭证文件': firstTx?.rawSourceFile || '',
      '凭证页码/行号': firstTx?.rawPageNumber ? `第${firstTx.rawPageNumber}页` : `第${firstTx?.rawRowIndex || 1}行`
    };
  });
  const ws1 = XLSX.utils.json_to_sheet(courtData);
  XLSX.utils.book_append_sheet(wb, ws1, '可疑转移财产证据清单');

  // Sheet 2: All Structured Transactions (Filtered of self-transfers)
  const allData = transactions.map((t, idx) => ({
    '序号': idx + 1,
    '账号': t.accountNumber,
    '银行': t.bankName,
    '交易时间': t.transactionTime,
    '收支方向': t.direction === 'IN' ? '收入/贷方' : '支出/借方',
    '交易金额': t.amount,
    '交易后余额': t.balance,
    '对手方名称': t.counterpartyName,
    '对手方账号': t.counterpartyAccount || '',
    '附言/摘要': t.summary,
    '时间阶段标签': t.timePhaseTag || '常规',
    '是否内部自转': t.isInternalTransfer ? '是(已刚销)' : '否(外部真实)',
    '原始文件': t.rawSourceFile,
    '页码': t.rawPageNumber || t.rawRowIndex || 1
  }));
  const ws2 = XLSX.utils.json_to_sheet(allData);
  XLSX.utils.book_append_sheet(wb, ws2, '全量标准化明细');

  // Sheet 3: Counterparty Net Flow Summary
  const cpData = Object.values(report.counterpartySummaries)
    .sort((a, b) => b.netOut - a.netOut)
    .map((cp, idx) => ({
      '排名': idx + 1,
      '对手方名称': cp.name,
      '转入总额(元)': cp.totalIn,
      '转出总额(元)': cp.totalOut,
      '净流出(元)': cp.netOut,
      '交易频次': cp.transactionCount,
      '最早交易日': cp.earliestDate,
      '最晚交易日': cp.latestDate,
      '疑似关系特征': cp.roleTag || (cp.isSuspectedRelative ? '疑似近亲属' : (cp.isSuspectedAffiliate ? '疑似关联企业' : '常规对手')),
      '高频附言': cp.frequentSummaries.join('; ')
    }));
  const ws3 = XLSX.utils.json_to_sheet(cpData);
  XLSX.utils.book_append_sheet(wb, ws3, '对手方资金净流向排行');

  // Generate Excel
  const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const fileName = `${caseMeta.respondentName || '被执行人'}_银行流水证据质证表_${new Date().toISOString().slice(0, 10)}.xlsx`;
  saveAs(blob, fileName);
}
