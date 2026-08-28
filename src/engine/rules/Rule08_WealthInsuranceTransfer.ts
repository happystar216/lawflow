import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule08_WealthInsuranceTransfer extends BaseRule {
  readonly ruleId = 'RULE_WEALTH_INSURANCE_TRANSFER';
  readonly name = '隐性财产流向·证券/保单/理财';
  readonly category: RuleCategory = 'ASSET_CLUE';
  readonly defaultSeverity: SeverityLevel = 'L0';
  readonly description = '资金流向证券公司三方存管、保险公司趸交大额保单、大额存单或基金公司，对应现金价值可供执行。';
  readonly statutoryBasis = [
    '《民事诉讼法》第253条',
    '《最高人民法院关于人民法院民事执行中查封、扣押、冻结财产的规定》',
    '《保监会、最高法关于规范人民法院查询、冻结、扣划保险业务的通知》'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];

    context.allTransactions.forEach(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'OUT') return;
      if (tx.amount < 5000) return;

      const cp = tx.counterpartyName || '';
      const summary = tx.summary || '';
      const isSecuritiesOrInsurance = 
        /证券|基金|人寿|财险|保险|信托|理财|期权|期货|大额存单|财富/.test(cp) ||
        /保费|投保|申购|认购|理财|第三方存管|银证转账/.test(summary);

      if (isSecuritiesOrInsurance) {
        matches.push({
          matchId: `${this.ruleId}_${tx.id}`,
          ruleId: this.ruleId,
          ruleName: this.name,
          category: this.category,
          severity: 'L0',
          matchType: 'SINGLE',
          transactionIds: [tx.id],
          totalAmount: tx.amount,
          timePhase: tx.timePhaseTag || '执行关联期间',
          counterpartyName: cp,
          aiReasoning: `被执行人于 ${tx.transactionDate} 向【${cp}】转出资金 ¥${tx.amount.toLocaleString()} 元（摘要：${summary}）。该笔款项形成确定性理财产品、证券持仓或大额保单现金价值，系明确的可供执行财产线索，建议立即向法院申请调取持仓并采取冻结/扣划措施。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: true
        });
      }
    });

    return matches;
  }
}
