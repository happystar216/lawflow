import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType
} from 'docx';
import { saveAs } from 'file-saver';
import { CaseMetadata } from '../types/case';
import { CaseEvaluationReport } from '../types/evidence';
import { AnomalyMatch, RuleCategory, VerificationStatus } from '../types/rules';
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

export async function exportEvidenceAnalysisWord(
  caseMeta: CaseMetadata,
  report: CaseEvaluationReport,
  transactions: StandardTransaction[]
): Promise<void> {
  const txMap = new Map(transactions.map(transaction => [transaction.id, transaction]));
  const hiddenAssets = report.matches.filter(match => match.category === 'ASSET_CLUE');
  const repaymentChecks = report.matches.filter(match => match.ruleId === 'RULE_FABRICATED_REMARKS_BILATERAL');
  const otherMatches = report.matches.filter(match => match.category !== 'ASSET_CLUE' && match.ruleId !== 'RULE_FABRICATED_REMARKS_BILATERAL');
  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });

  const children: Array<Paragraph | Table> = [
    new Paragraph({
      children: [new TextRun({ text: '银行流水证据分析报告', bold: true, size: 36, color: '172033' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 }
    }),
    new Paragraph({
      children: [new TextRun({ text: `${caseMeta.caseNumber || '未填写案号'} · 被执行人：${caseMeta.respondentName || '未填写'}`, size: 20, color: '64748B' })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 320 }
    }),
    noticeParagraph('报告性质说明', '本报告仅对已导入银行流水进行结构化整理、资金流向计算和证据线索提示，不属于申请书、起诉状、法律意见书或刑事移送材料。流水备注不当然代表真实交易原因；所有结论均应与原始流水、合同及其他证据交叉核验。'),
    heading('一、案件与分析范围'),
    keyValueTable([
      ['执行案号', caseMeta.caseNumber || '未录入', '执行法院', caseMeta.courtName || '未录入'],
      ['申请执行人', caseMeta.applicantName || '未录入', '被执行人', caseMeta.respondentName || '未录入'],
      ['执行标的', currency(caseMeta.targetAmount), '分析交易数', `${report.totalRawTransactions} 笔`],
      ['流水期间', transactionRange(transactions), '报告生成时间', generatedAt],
      ['执行立案日', caseMeta.timeline.executionFilingDate || '未设置', '账户冻结日', caseMeta.timeline.freezeDate || '未设置'],
      ['报告财产令送达日', caseMeta.timeline.reportOrderServedDate || '未设置', '律师重点标记', `${report.matches.filter(match => match.lawyerAdopted).length} 项`]
    ]),
    heading('二、资金概览'),
    simpleTable(
      ['分析指标', '金额/数量', '说明'],
      [
        ['原始总流入', currency(report.totalRawIn), '已导入全部账户的贷方发生额'],
        ['原始总流出', currency(report.totalRawOut), '已导入全部账户的借方发生额'],
        ['本人账户内部互转核销', `${currency(report.internalTransferAmount)} / ${report.internalTransferCount}笔`, '仅核销本人账户间金额一致、方向相反、时间接近的双边记录'],
        ['核销后外部流入', currency(report.netExternalIn), '不等同于全部可供执行收入'],
        ['核销后外部流出', currency(report.netExternalOut), '需逐笔核实用途、对价及最终去向'],
        ['执行立案后对外转出', currency(report.postExecutionTransferAmount), `其中报告财产令后 ${currency(report.postReportOrderTransferAmount)}`],
        ['执行期间已识别入账', currency(report.totalIncomeDuringExecution), `约为执行标的的 ${(report.solvencyCoverageRate * 100).toFixed(1)}%，不直接等同于完整履行能力`]
      ],
      [32, 24, 44]
    ),
    heading('三、隐形财产线索：保险、证券、理财及对外债权'),
    new Paragraph({
      text: '本节同时保留账户冻结前发生的购买或缴费记录。冻结前购买不意味着当前财产线索消失，应继续核验保单现金价值、退保金、证券持仓、赎回款及对外债权是否仍然存在。',
      spacing: { after: 120 },
      style: 'Normal'
    }),
    matchesTable(hiddenAssets, txMap, true),
    heading('四、“还借款/还款”备注真实性核验'),
    new Paragraph({
      text: '银行备注仅为交易附言，不能单独证明借款合同、借款交付或还款事实。以下逐笔列示律师核验状态及待核材料。',
      spacing: { after: 120 }
    }),
    repaymentTable(repaymentChecks, txMap),
    heading('五、其他异常交易与财产申报差异'),
    matchesTable(otherMatches, txMap, false),
    heading('六、对手方资金汇总'),
    counterpartyTable(report),
    heading('七、待补证与核查事项'),
    ...buildEvidenceGapParagraphs(report.matches),
    noticeParagraph('使用提示', '本报告中的金额、页码、身份关系和核验结论应由承办律师与银行流水原件逐项复核。对外提交时，可从本报告中选取经核实的事实另行制作符合法院、公安机关或其他机构要求的具体法律文书。')
  ];

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: '宋体', size: 21 }, paragraph: { spacing: { line: 340 } } }
      },
      paragraphStyles: [
        { id: 'AnalysisHeading', name: 'Analysis Heading', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { bold: true, size: 26, color: '172033' }, paragraph: { spacing: { before: 280, after: 120 }, keepNext: true } }
      ]
    },
    sections: [{
      properties: { page: { margin: { top: 1080, right: 900, bottom: 1080, left: 900 } } },
      children
    }]
  });

  const blob = await Packer.toBlob(doc);
  saveAs(blob, `${caseMeta.respondentName || '被执行人'}_银行流水证据分析报告_${new Date().toISOString().slice(0, 10)}.docx`);
}

function heading(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1, style: 'AnalysisHeading' });
}

function noticeParagraph(title: string, content: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `【${title}】`, bold: true, color: '9A3412' }),
      new TextRun({ text: content, color: '475569' })
    ],
    shading: { type: ShadingType.CLEAR, fill: 'FFF7ED' },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'F59E0B' } },
    indent: { left: 160, right: 120 },
    spacing: { before: 120, after: 220 }
  });
}

function keyValueTable(rows: string[][]): Table {
  return simpleTable([], rows, [15, 35, 15, 35], true);
}

function simpleTable(headers: string[], rows: string[][], widths: number[], keyValue = false): Table {
  const tableRows: TableRow[] = [];
  if (headers.length > 0) {
    tableRows.push(new TableRow({
      tableHeader: true,
      children: headers.map((header, index) => cell(header, widths[index], true))
    }));
  }
  rows.forEach(row => tableRows.push(new TableRow({
    children: row.map((value, index) => cell(value, widths[index], keyValue && index % 2 === 0))
  })));
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: tableRows, margins: { top: 70, bottom: 70, left: 90, right: 90 } });
}

function cell(text: string, width: number, emphasized = false): TableCell {
  return new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    shading: emphasized ? { type: ShadingType.CLEAR, fill: 'E2E8F0' } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text, bold: emphasized, size: 18, color: emphasized ? '334155' : '1E293B' })] })]
  });
}

function matchesTable(matches: AnomalyMatch[], txMap: Map<string, StandardTransaction>, includeChecklist: boolean): Table {
  if (matches.length === 0) return emptyTable('当前已导入流水未识别到该类线索。');
  return simpleTable(
    ['序号', '类别/阶段', '金额及对手方', '证据分析与原件定位'],
    matches.map((match, index) => [
      String(index + 1),
      `${CATEGORY_LABELS[match.category]}\n${match.timePhase}${match.lawyerAdopted ? '\n【律师重点】' : ''}`,
      `${currency(match.totalAmount)}\n${match.counterpartyName || '未知对手方'}`,
      `${match.lawyerNotes || match.aiReasoning}\n原件：${sourceLocations(match, txMap)}${includeChecklist && match.verificationChecklist?.length ? `\n待核：${match.verificationChecklist.join('；')}` : ''}`
    ]),
    [7, 18, 18, 57]
  );
}

function repaymentTable(matches: AnomalyMatch[], txMap: Map<string, StandardTransaction>): Table {
  if (matches.length === 0) return emptyTable('当前已导入流水未识别到带有“还借款/还款”等备注的交易。');
  return simpleTable(
    ['序号', '交易事实', '律师核验状态', '分析、核验记录及原件'],
    matches.map((match, index) => {
      const transaction = txMap.get(match.transactionIds[0]);
      const status = match.verificationStatus || 'PENDING';
      return [
        String(index + 1),
        `${transaction?.transactionDate || ''}\n${match.counterpartyName || '未知对手方'}\n${currency(match.totalAmount)}\n备注：${transaction?.summary || '无'}`,
        VERIFICATION_LABELS[status],
        `${match.aiReasoning}\n律师记录：${match.verificationNotes || '尚未填写'}\n待核材料：${match.verificationChecklist?.join('；') || '无'}\n原件：${sourceLocations(match, txMap)}`
      ];
    }),
    [7, 22, 18, 53]
  );
}

function counterpartyTable(report: CaseEvaluationReport): Table {
  const rows = Object.values(report.counterpartySummaries)
    .sort((a, b) => b.netOut - a.netOut)
    .slice(0, 15)
    .map((counterparty, index) => [
      String(index + 1),
      counterparty.name,
      currency(counterparty.totalOut),
      currency(counterparty.totalIn),
      currency(counterparty.netOut),
      `${counterparty.transactionCount}笔${counterparty.roleTag ? ` / ${counterparty.roleTag}` : ''}`
    ]);
  return simpleTable(['序号', '对手方', '转出', '转入', '净流出', '笔数/身份标注'], rows, [7, 24, 17, 17, 17, 18]);
}

function buildEvidenceGapParagraphs(matches: AnomalyMatch[]): Paragraph[] {
  const gaps = Array.from(new Set(matches.flatMap(match => match.verificationChecklist || [])));
  if (gaps.length === 0) return [new Paragraph({ text: '暂无结构化待补证事项，请由承办律师结合案件情况补充。' })];
  return gaps.map((gap, index) => new Paragraph({
    children: [new TextRun({ text: `${index + 1}. `, bold: true, color: '2563EB' }), new TextRun({ text: gap })],
    indent: { left: 180 },
    spacing: { after: 60 }
  }));
}

function emptyTable(message: string): Table {
  return simpleTable(['说明'], [[message]], [100]);
}

function sourceLocations(match: AnomalyMatch, txMap: Map<string, StandardTransaction>): string {
  return Array.from(new Set(match.transactionIds.map(id => {
    const transaction = txMap.get(id);
    if (!transaction) return '';
    const location = transaction.rawPageNumber
      ? `第${transaction.rawPageNumber}页`
      : transaction.rawRowIndex
      ? `第${transaction.rawRowIndex}行`
      : '位置待核';
    return `${transaction.rawSourceFile} ${location}`;
  }).filter(Boolean))).join('；') || '原件位置待补充';
}

function currency(amount: number): string {
  return `¥${(amount || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function transactionRange(transactions: StandardTransaction[]): string {
  if (transactions.length === 0) return '无交易';
  const dates = transactions.map(transaction => transaction.transactionDate).filter(Boolean).sort();
  return `${dates[0]} 至 ${dates[dates.length - 1]}`;
}
