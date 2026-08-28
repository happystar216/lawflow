import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule11_FalseAssetDeclaration extends BaseRule {
  readonly ruleId = 'RULE_FALSE_ASSET_DECLARATION';
  readonly name = '《报告财产令》虚假申报交叉核验';
  readonly category: RuleCategory = 'FALSE_REPORT';
  readonly defaultSeverity: SeverityLevel = 'L0';
  readonly description = '将被执行人向法院申报的“无收入/无存款/零财产”与银行流水实际大额进出或隐秘卡号进行交叉核验。';
  readonly statutoryBasis = [
    '《民事诉讼法》第252条（拒绝报告或虚假报告财产的罚款拘留）',
    '法释〔2024〕13号第3条第(三)项（虚假报告财产经拘留罚款后仍拒不执行）',
    '《刑法》第313条'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];
    const declaredAssets = context.caseMeta.declaredAssets || [];

    // Check income declaration discrepancy
    const declaredIncomeItem = declaredAssets.find(a => a.category === 'income');
    if (!declaredIncomeItem) return matches;
    const declaredIncomeValue = declaredIncomeItem.declaredValue;

    // Calculate actual incoming after report order date
    const t4 = context.caseMeta.timeline.reportOrderServedDate || context.caseMeta.timeline.executionFilingDate;
    
    if (t4) {
      const postReportIncomeTx = context.allTransactions.filter(
        tx => !tx.isInternalTransfer && tx.direction === 'IN' && tx.transactionDate >= t4
      );

      const actualPostReportIncome = postReportIncomeTx.reduce((sum, t) => sum + t.amount, 0);

      // If declared income is much less than actual income
      if (actualPostReportIncome > declaredIncomeValue + 10000) {
        matches.push({
          matchId: `${this.ruleId}_INCOME_DISCREPANCY`,
          ruleId: this.ruleId,
          ruleName: this.name,
          category: this.category,
          severity: 'L0',
          matchType: 'GROUP',
          transactionIds: postReportIncomeTx.map(t => t.id),
          totalAmount: actualPostReportIncome,
          timePhase: '《报告财产令》送达后',
          counterpartyName: '【多方收入来源】',
          aiReasoning: `已录入财产申报中的收入金额为 ¥${declaredIncomeValue.toLocaleString()} 元；当前流水显示《报告财产令》送达后入账 ${postReportIncomeTx.length} 笔、累计 ¥${actualPostReportIncome.toLocaleString()} 元，二者存在差异。是否构成拒绝或虚假报告，仍需核对申报期间、申报口径、款项性质及报告财产令和申报表原件。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: false
        });
      }
    }

    return matches;
  }
}
