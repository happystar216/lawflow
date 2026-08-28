import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule06_AffiliatedCompanyTransfer extends BaseRule {
  readonly ruleId = 'RULE_AFFILIATED_COMPANY_TRANSFER';
  readonly name = '关联企业无贸易背景抽逃转移';
  readonly category: RuleCategory = 'PIERCING_CLUE';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '向关联企业转账并标注“货款/服务费”，但无真实业务发票与合同支撑，涉嫌公私财产混同或抽逃出资。';
  readonly statutoryBasis = [
    '《公司法》第23条（一人有限责任公司财产混同举证责任倒置）',
    '《最高人民法院关于民事执行中变更、追加当事人若干问题的规定》第20条',
    '《民法典》第538条'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];

    context.allTransactions.forEach(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'OUT') return;
      if (tx.amount < 20000) return;

      const cpName = tx.counterpartyName?.trim() || '';
      const cpSummary = context.counterpartySummaries[cpName];
      const isAffiliate = cpSummary?.isSuspectedAffiliate || cpSummary?.roleTag?.includes('关联') || cpSummary?.roleTag?.includes('独资');

      if (isAffiliate && /货款|服务费|借款|往来|工程款/.test(tx.summary || '')) {
        matches.push({
          matchId: `${this.ruleId}_${tx.id}`,
          ruleId: this.ruleId,
          ruleName: this.name,
          category: this.category,
          severity: 'L1',
          matchType: 'SINGLE',
          transactionIds: [tx.id],
          totalAmount: tx.amount,
          timePhase: tx.timePhaseTag || '执行关联期间',
          counterpartyName: cpName,
          aiReasoning: `被执行人于 ${tx.transactionDate} 向关联企业【${cpName}】转款 ¥${tx.amount.toLocaleString()} 元（附言：${tx.summary}）。该笔款项涉嫌在无实质贸易背景下通过关联交易转移责任财产，或构成股东与公司财产混同，可作为申请追加该企业/股东为被执行人的核心线索。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: true
        });
      }
    });

    return matches;
  }
}
