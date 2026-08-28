import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule10_UndisclosedReceivables extends BaseRule {
  readonly ruleId = 'RULE_UNDISCLOSED_RECEIVABLES';
  readonly name = '隐性对外到期债权/借出款项';
  readonly category: RuleCategory = 'ASSET_CLUE';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '流水显示被执行人曾对外大额借款（借出给第三方）或支付大额押金/预付款，享有到期债权。';
  readonly statutoryBasis = [
    '《最高人民法院关于人民法院执行工作若干问题的规定（试行）》第61条（执行被执行人的到期债权）',
    '《民法典》第535条（债权人代位权）'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];

    context.allTransactions.forEach(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'OUT') return;
      if (tx.amount < 20000) return;

      const summary = tx.summary || '';
      const isRepayment = /还借款|还款|归还|偿还/.test(summary);
      const isLending = !isRepayment && /借出|借给|出借|押金|保证金|代垫|暂借/.test(summary);
      if (isLending) {
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
          counterpartyName: tx.counterpartyName,
          aiReasoning: `被执行人于 ${tx.transactionDate} 向【${tx.counterpartyName || '第三方'}】转出 ¥${tx.amount.toLocaleString()} 元（摘要：${tx.summary}）。该交易可能对应借出款、押金或代垫款，提示存在对外债权线索；债权是否成立、是否到期及是否已清偿，仍需结合合同、收据、聊天记录和后续回款核实。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: false
        });
      }
    });

    return matches;
  }
}
