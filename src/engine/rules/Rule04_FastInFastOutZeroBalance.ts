import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule04_FastInFastOutZeroBalance extends BaseRule {
  readonly ruleId = 'RULE_FAST_IN_FAST_OUT';
  readonly name = '快进快出·账面余额归零';
  readonly category: RuleCategory = 'ABILITY_PROOF';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '大额款项到账后 24-48 小时内即刻全额转出，账面余额常年归零应对查控。';
  readonly statutoryBasis = [
    '《民事诉讼法》第253条',
    '法释〔2024〕13号第3条（有履行能力而拒不履行）',
    '《最高人民法院关于限制被执行人高消费及有关消费的若干规定》'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];
    const txList = context.allTransactions.filter(t => !t.isInternalTransfer);

    for (let i = 0; i < txList.length; i++) {
      const inTx = txList[i];
      if (inTx.direction !== 'IN' || inTx.amount < 30000) continue;

      // Look for outgoing transactions within 2 days matching close to the incoming amount
      const tIn = new Date(inTx.transactionDate).getTime();
      const outTx = txList.find((other, idx) => {
        if (idx <= i || other.direction !== 'OUT') return false;
        const tOut = new Date(other.transactionDate).getTime();
        const diffHours = (tOut - tIn) / (1000 * 3600);
        if (diffHours < 0 || diffHours > 48) return false;
        return Math.abs(other.amount - inTx.amount) / inTx.amount <= 0.15; // Within 15%
      });

      if (outTx) {
        matches.push({
          matchId: `${this.ruleId}_${inTx.id}_${outTx.id}`,
          ruleId: this.ruleId,
          ruleName: this.name,
          category: this.category,
          severity: 'L1',
          matchType: 'GROUP',
          transactionIds: [inTx.id, outTx.id],
          totalAmount: inTx.amount,
          timePhase: inTx.timePhaseTag || '执行关联期间',
          counterpartyName: `${inTx.counterpartyName || '未知来源'} -> ${outTx.counterpartyName || '未知去向'}`,
          aiReasoning: `被执行人账户于 ${inTx.transactionDate} 收到大额进账 ¥${inTx.amount.toLocaleString()} 元，并在 48 小时内于 ${outTx.transactionDate} 转出 ¥${outTx.amount.toLocaleString()} 元至【${outTx.counterpartyName || '案外人'}】。该“快进快出”特征提示其具有相应资金调度能力，但资金用途及是否存在规避执行目的仍需结合合同、对手方关系和完整流水核实。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: false
        });
      }
    }

    return matches;
  }
}
