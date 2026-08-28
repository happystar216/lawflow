import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, WidthType, AlignmentType } from 'docx';
import { saveAs } from 'file-saver';
import { CaseMetadata } from '../types/case';
import { CaseEvaluationReport, DocumentPackageType } from '../types/evidence';
import { StandardTransaction } from '../types/transaction';

/**
 * Generates court-grade Word documents (.docx) according to standard judicial brief styling.
 */
export async function exportCourtEvidenceWord(
  caseMeta: CaseMetadata,
  report: CaseEvaluationReport,
  transactions: StandardTransaction[],
  packageType: DocumentPackageType
): Promise<void> {
  const titles: Record<DocumentPackageType, string> = {
    PACKAGE_CRIMINAL_REFUSAL: '被执行人涉嫌拒不执行判决、裁定罪证据清单与事实说明书',
    PACKAGE_RESUME_DETENTION: '被执行人具备履行能力证据分析报告与强制措施申请书',
    PACKAGE_CREDITOR_REVOCATION: '债权人撤销权诉讼事实依据与涉嫌转移财产交易清单',
    PACKAGE_PIERCE_COMPANY: '被执行人公私财产混同/抽逃出资与追加股东证据清单',
    PACKAGE_FALSE_REPORT_PUNISH: '被执行人虚假报告财产差异核对报告与司法处罚申请书'
  };

  const docTitle = titles[packageType] || '被执行人银行流水资金穿透与可疑交易分析报告';
  const adoptedMatches = report.matches.filter(m => m.lawyerAdopted);

  // Build Document Sections
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // Title
          new Paragraph({
            text: docTitle,
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { after: 300 }
          }),

          // Disclaimer Alert
          new Paragraph({
            children: [
              new TextRun({
                text: '【合规提示与辅助性质声明】：',
                bold: true,
                color: '990000',
                size: 20
              }),
              new TextRun({
                text: '本证据清单系基于调取的银行流水数据经客观法律时间轴对齐、内部互转刚销及异常规则匹配生成，严格遵循《民诉法财产调查规定》第12条保密要求，仅供代理律师呈庭质证与司法追责使用。',
                italics: true,
                color: '666666',
                size: 20
              })
            ],
            spacing: { after: 200 }
          }),

          // Section 1: Basic Case Context
          new Paragraph({
            text: '一、 案件基本信息与法律时间轴',
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 120 }
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `执行案号：`, bold: true }),
              new TextRun({ text: `${caseMeta.caseNumber || '（未录入）'}    ` }),
              new TextRun({ text: `执行法院：`, bold: true }),
              new TextRun({ text: `${caseMeta.courtName || '（未录入）'}\n` }),
              new TextRun({ text: `申请执行人：`, bold: true }),
              new TextRun({ text: `${caseMeta.applicantName || '（未录入）'}    ` }),
              new TextRun({ text: `被执行人：`, bold: true }),
              new TextRun({ text: `${caseMeta.respondentName || '（未录入）'}\n` }),
              new TextRun({ text: `执行标的本息总额：`, bold: true }),
              new TextRun({ text: `¥ ${(caseMeta.targetAmount || 0).toLocaleString()} 元\n` }),
              new TextRun({ text: `执行立案日期：`, bold: true }),
              new TextRun({ text: `${caseMeta.timeline.executionFilingDate || '未设置'}    ` }),
              new TextRun({ text: `《报告财产令》送达日：`, bold: true }),
              new TextRun({ text: `${caseMeta.timeline.reportOrderServedDate || '未设置'}` })
            ],
            spacing: { after: 200 }
          }),

          // Section 2: Macro Solvency and Netting Summary
          new Paragraph({
            text: '二、 资金画像与净流向穿透审计',
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 120 }
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `1. 原始流水发生总额：总流入 ¥${report.totalRawIn.toLocaleString()} 元，总流出 ¥${report.totalRawOut.toLocaleString()} 元；\n` }),
              new TextRun({ text: `2. 内部对冲刚销：剔除自有账户间“左手倒右手”内部互转 ${report.internalTransferCount} 笔，共刚销金额 ¥${report.internalTransferAmount.toLocaleString()} 元；\n` }),
              new TextRun({ text: `3. 真实外部净流向：外部真实总收入 ¥${report.netExternalIn.toLocaleString()} 元，外部真实总支出 ¥${report.netExternalOut.toLocaleString()} 元；\n` }),
              new TextRun({ text: `4. 执行节点后涉嫌转移款项：立案后转出 ¥${report.postExecutionTransferAmount.toLocaleString()} 元，其中报告财产令后转出 ¥${report.postReportOrderTransferAmount.toLocaleString()} 元；\n` }),
              new TextRun({ text: `5. 履行能力覆盖率：执行期间确认进账收入 ¥${report.totalIncomeDuringExecution.toLocaleString()} 元，相当于执行标的总额的 ${(report.solvencyCoverageRate * 100).toFixed(1)}%，铁证其完全具备履行能力。` })
            ],
            spacing: { after: 200 }
          }),

          // Section 3: Suspicious Transaction Evidence List
          new Paragraph({
            text: '三、 涉嫌转移隐匿财产及可疑交易证据清单',
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 120 }
          }),
          new Paragraph({
            text: `经系统规则引擎与人工核查，共锁定 ${adoptedMatches.length} 项重点可疑交易与事实线索，清单如下：`,
            spacing: { after: 120 }
          }),

          // Table of Matches
          buildMatchesTable(adoptedMatches, transactions),

          // Section 4: Statutory Reasoning and Request
          new Paragraph({
            text: '四、 法律依据与处理请求',
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 300, after: 120 }
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: '综上所述，被执行人的上述资金划转与取现行为，均发生于债务形成、判决生效乃至执行立案、《报告财产令》送达之后。依据《中华人民共和国民法典》第538条、第539条，《中华人民共和国民事诉讼法》第114条、第248条、第253条以及最高人民法院、最高人民检察院《关于办理拒不执行判决、裁定刑事案件适用法律若干问题的解释》（法释〔2024〕13号）第3条之规定，其行为已构成有履行能力而拒不履行、隐匿转移财产及虚假报告财产。请求人民法院依法对被执行人采取罚款、司法拘留措施，并依法移送公安机关追究其拒执罪刑事责任。',
                bold: false
              })
            ],
            spacing: { after: 300 }
          }),

          new Paragraph({
            children: [
              new TextRun({ text: '申请人/代理人：____________________（签名/盖章）\n' }),
              new TextRun({ text: `出具日期：${new Date().toLocaleDateString('zh-CN')}` })
            ],
            alignment: AlignmentType.RIGHT
          })
        ]
      }
    ]
  });

  const blob = await Packer.toBlob(doc);
  const fileName = `${caseMeta.respondentName || '被执行人'}_银行流水资金穿透与呈庭证据说明_${new Date().toISOString().slice(0, 10)}.docx`;
  saveAs(blob, fileName);
}

function buildMatchesTable(matches: any[], allTx: StandardTransaction[]): Table {
  const txMap = new Map<string, StandardTransaction>();
  allTx.forEach(t => txMap.set(t.id, t));

  const rows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: [
        new TableCell({ width: { size: 8, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '序号', bold: true })] })] }),
        new TableCell({ width: { size: 14, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '时间/阶段', bold: true })] })] }),
        new TableCell({ width: { size: 14, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '金额 (元)', bold: true })] })] }),
        new TableCell({ width: { size: 18, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '对手方/身份', bold: true })] })] }),
        new TableCell({ width: { size: 18, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '异常特征/法条', bold: true })] })] }),
        new TableCell({ width: { size: 28, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: '事实说明与原件定位', bold: true })] })] })
      ]
    })
  ];

  matches.forEach((m, idx) => {
    const firstTx = m.transactionIds.length > 0 ? txMap.get(m.transactionIds[0]) : undefined;
    const pageInfo = firstTx?.rawPageNumber ? `第${firstTx.rawPageNumber}页` : (firstTx?.rawRowIndex ? `第${firstTx.rawRowIndex}行` : '流水原件');
    const sourceFile = firstTx?.rawSourceFile || '银行对账单';

    rows.push(
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ text: String(idx + 1) })] }),
          new TableCell({ children: [new Paragraph({ text: `${m.timePhase}\n${firstTx?.transactionDate || ''}` })] }),
          new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: `¥ ${m.totalAmount.toLocaleString()}`, bold: true })] })] }),
          new TableCell({ children: [new Paragraph({ text: `${m.counterpartyName || '未知'}` })] }),
          new TableCell({ children: [new Paragraph({ text: `【${m.ruleName}】\n${m.statutoryBasis[0] || ''}` })] }),
          new TableCell({ children: [new Paragraph({ text: `${m.lawyerNotes || m.aiReasoning}\n[原件定位: ${sourceFile} ${pageInfo}]` })] })
        ]
      })
    );
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows
  });
}
