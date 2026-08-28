import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule03_AntMovingCloseRelatives extends BaseRule {
  readonly ruleId = 'RULE_ANT_MOVING_CLOSE_RELATIVES';
  readonly name = '近亲属“蚂蚁搬家”式高频转移';
  readonly category: RuleCategory = 'ASSET_TRANSFER';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '向同姓氏亲属或特定个人多笔、高频、小额转款，表面合理但累计数额巨大。';
  readonly statutoryBasis = [
    '《民法典》第538条（无偿处分财产权益的撤销权）',
    '《民法典》第539条（明显不合理低价/高价交易）',
    '法释〔2024〕13号第3条'
  ];

  constructor() {
    super();
    this.params = {
      minCount: 3,
      totalAmountThreshold: 30000
    };
  }

  evaluate(context: RuleContext): AnomalyMatch[] {
    const minCount = Number(this.params.minCount) || 3;
    const totalThreshold = Number(this.params.totalAmountThreshold) || 30000;
    const matches: AnomalyMatch[] = [];

    Object.values(context.counterpartySummaries).forEach(cp => {
      if (!cp.isSuspectedRelative && !cp.roleTag?.includes('亲属') && !cp.roleTag?.includes('配偶')) {
        return;
      }

      if (cp.transactionCount >= minCount && cp.netOut >= totalThreshold) {
        // Collect matching transactions
        const relatedTx = context.allTransactions.filter(
          tx => !tx.isInternalTransfer && tx.counterpartyName === cp.name && tx.direction === 'OUT'
        );

        matches.push({
          matchId: `${this.ruleId}_${cp.name}`,
          ruleId: this.ruleId,
          ruleName: this.name,
          category: this.category,
          severity: cp.netOut >= 100000 ? 'L0' : 'L1',
          matchType: 'GROUP',
          transactionIds: relatedTx.map(t => t.id),
          totalAmount: cp.netOut,
          timePhase: '多阶段累计',
          counterpartyName: cp.name,
          aiReasoning: `被执行人向疑似近亲属/关联人【${cp.name}】（已标注/推断：${cp.roleTag || '同姓近亲属'}）持续高频转出款项共 ${cp.transactionCount} 笔，累计净流出金额高达 ¥${cp.netOut.toLocaleString()} 元（平均每笔约 ¥${Math.round(cp.netOut / cp.transactionCount).toLocaleString()} 元）。该“蚂蚁搬家”行为涉嫌通过无偿或生活费名义向家庭成员稀释责任财产。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: true
        });
      }
    });

    return matches;
  }
}
