import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';
import { CaseMetadata } from '../types/case';
import { CaseEvaluationReport } from '../types/evidence';
import { RuleCategory, VerificationStatus } from '../types/rules';
import { StandardTransaction } from '../types/transaction';

const CATEGORY_LABELS: Record<RuleCategory, string> = {
  ASSET_TRANSFER: '异常资金流出',
  ABILITY_PROOF: '收入及资金能力线索',
  ASSET_CLUE: '隐形财产线索',
  FALSE_REPORT: '财产申报差异',
  PIERCING_CLUE: '关联主体资金往来'
};

const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  PENDING: '待律师核验',
  SUPPORTED: '有证据支持真实还款',
  INCONCLUSIVE: '证据不足，暂无法判断',
  SUSPICIOUS: '存在虚构债务或转移迹象'
};

export async function exportEvidenceAnalysisExcel(
  caseMeta: CaseMetadata,
  report: CaseEvaluationReport,
  transactions: StandardTransaction[]
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '执析宝 LawFlow';
  workbook.subject = '银行流水证据分析工作底表';
  const txMap = new Map(transactions.map(transaction => [transaction.id, transaction]));

  appendObjectSheet(workbook, '分析概览', [
    { '项目': '执行案号', '内容': caseMeta.caseNumber || '未录入', '说明': '' },
    { '项目': '被执行人', '内容': caseMeta.respondentName || '未录入', '说明': '' },
    { '项目': '流水交易数', '内容': report.totalRawTransactions, '说明': '已导入并结构化的交易记录' },
    { '项目': '原始总流入', '内容': report.totalRawIn, '说明': '全部账户贷方发生额' },
    { '项目': '原始总流出', '内容': report.totalRawOut, '说明': '全部账户借方发生额' },
    { '项目': '内部互转核销', '内容': report.internalTransferAmount, '说明': `${report.internalTransferCount}笔本人账户双边匹配记录` },
    { '项目': '执行立案后对外转出', '内容': report.postExecutionTransferAmount, '说明': '款项用途及对价待逐笔核实' },
    { '项目': '报告财产令后对外转出', '内容': report.postReportOrderTransferAmount, '说明': '款项用途及对价待逐笔核实' },
    { '项目': '分析线索数', '内容': report.matches.length, '说明': '规则命中不等同于违法事实成立' },
    { '项目': '报告性质', '内容': '证据分析', '说明': '不属于申请书、起诉状、法律意见书或刑事移送材料' }
  ]);

  const allClues = report.matches.map((match, index) => {
    const firstTx = txMap.get(match.transactionIds[0]);
    return {
      '序号': index + 1,
      '分析类别': CATEGORY_LABELS[match.category],
      '线索名称': match.ruleName,
      '优先级': match.severity,
      '律师标记重点': match.lawyerAdopted ? '是' : '否',
      '时间阶段': match.timePhase,
      '首笔交易日期': firstTx?.transactionDate || '',
      '涉及金额(元)': match.totalAmount,
      '对手方': match.counterpartyName || '未知',
      '流水备注': firstTx?.summary || '',
      '证据分析': match.lawyerNotes || match.aiReasoning,
      '真实性核验状态': match.verificationStatus ? VERIFICATION_LABELS[match.verificationStatus] : '不适用',
      '律师核验记录': match.verificationNotes || '',
      '待补证事项': match.verificationChecklist?.join('；') || '',
      '原始凭证定位': sourceLocations(match.transactionIds, txMap)
    };
  });
  appendObjectSheet(workbook, '全部分析线索', allClues);

  appendObjectSheet(workbook, '隐形财产线索', allClues.filter(row => row['分析类别'] === '隐形财产线索'));
  appendObjectSheet(workbook, '还借款真实性核验', allClues.filter(row => row['线索名称'].includes('还借款') || row['线索名称'].includes('还款')));

  appendObjectSheet(workbook, '全量标准化流水', transactions.map((transaction, index) => ({
    '序号': index + 1,
    '账号': transaction.accountNumber,
    '银行': transaction.bankName,
    '交易时间': transaction.transactionTime,
    '收支方向': transaction.direction === 'IN' ? '收入/贷方' : '支出/借方',
    '交易金额': transaction.amount,
    '交易后余额': transaction.balance,
    '对手方名称': transaction.counterpartyName,
    '对手方账号': transaction.counterpartyAccount || '',
    '律师身份标注': transaction.counterpartyRoleTag || '',
    '附言/摘要': transaction.summary,
    '时间阶段': transaction.timePhaseTag || '常规期间',
    '内部自转': transaction.isInternalTransfer ? '是（双边匹配已核销）' : '否（外部流向/待核实）',
    '原始文件': transaction.rawSourceFile,
    '页码/行号': transaction.rawPageNumber ? `第${transaction.rawPageNumber}页` : `第${transaction.rawRowIndex || 1}行`
  })));

  appendObjectSheet(workbook, '对手方资金汇总', Object.values(report.counterpartySummaries)
    .sort((a, b) => b.netOut - a.netOut)
    .map((counterparty, index) => ({
      '排名': index + 1,
      '对手方名称': counterparty.name,
      '转入总额(元)': counterparty.totalIn,
      '转出总额(元)': counterparty.totalOut,
      '净流出(元)': counterparty.netOut,
      '交易频次': counterparty.transactionCount,
      '最早交易日': counterparty.earliestDate,
      '最晚交易日': counterparty.latestDate,
      '律师身份标注': counterparty.roleTag || '',
      '系统关系提示': counterparty.isSuspectedRelative ? '同姓或摘要提示可能存在亲属关系，待核实' : '',
      '高频附言': counterparty.frequentSummaries.join('；')
    })));

  const excelBuffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([new Uint8Array(excelBuffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  saveAs(blob, `${caseMeta.respondentName || '被执行人'}_银行流水证据分析底表_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function appendObjectSheet(workbook: ExcelJS.Workbook, name: string, rows: Record<string, unknown>[]): void {
  const worksheet = workbook.addWorksheet(name);
  if (rows.length === 0) {
    worksheet.addRow(['当前未识别到该类线索']);
    return;
  }

  const keys = Object.keys(rows[0]);
  worksheet.columns = keys.map(key => ({
    header: key,
    key,
    width: /分析|记录|事项|说明|定位/.test(key) ? 45 : Math.min(26, Math.max(12, key.length * 2 + 4))
  }));
  worksheet.addRows(rows);
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.autoFilter = { from: 'A1', to: `${worksheet.getColumn(keys.length).letter}1` };
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
  worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (rowNumber > 1 && rowNumber % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    }
  });
}

function sourceLocations(transactionIds: string[], txMap: Map<string, StandardTransaction>): string {
  return Array.from(new Set(transactionIds.map(id => {
    const transaction = txMap.get(id);
    if (!transaction) return '';
    return transaction.rawPageNumber
      ? `${transaction.rawSourceFile} 第${transaction.rawPageNumber}页`
      : `${transaction.rawSourceFile} 第${transaction.rawRowIndex || 1}行`;
  }).filter(Boolean))).join('；');
}
