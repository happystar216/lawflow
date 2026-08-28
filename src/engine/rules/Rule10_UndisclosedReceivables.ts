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

      const isLending = /借款|借出|借给|借支|出借|押金|保证金|代垫|暂借/.test(tx.summary || '');
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
          aiReasoning: `被执行人于 ${tx.transactionDate} 向【${tx.counterpartyName || '第三方'}】转出 ¥${tx.amount.toLocaleString()} 元（摘要标注：${tx.summary}）。该笔款项表明被执行人对该第三方享有确定性的到期借款债权/押金返还请求权，申请执行人有权申请执行法院向该次债务人发出《履行到期债务通知书》。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: true
        });
      }
    });

    return matches;
  }
}
