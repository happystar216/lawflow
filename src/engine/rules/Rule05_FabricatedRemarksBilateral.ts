import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule05_FabricatedRemarksBilateral extends BaseRule {
  readonly ruleId = 'RULE_FABRICATED_REMARKS_BILATERAL';
  readonly name = '附言抗辩还款·双向核验不符';
  readonly category: RuleCategory = 'ASSET_TRANSFER';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '转账附言自造“还借款/归还欠款/还款”，但双向流水对账发现对手方从未有借款转入。';
  readonly statutoryBasis = [
    '《民法典》第538条、第539条',
    '最高法判例（2021）川01民终11323号裁判规则',
    '法释〔2024〕13号第3条'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];

    context.allTransactions.forEach(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'OUT') return;
      if (tx.amount < 10000) return;

      const isRepaymentRemark = /还款|还借款|归还|偿还|借款归还|还钱/.test(tx.summary || '');
      if (!isRepaymentRemark) return;

      // Check counterparty total incoming from this counterparty
      const cpName = tx.counterpartyName?.trim() || '';
      const cpSummary = context.counterpartySummaries[cpName];

      // If counterparty never transferred money in, or totalIn is far less than this out
      const totalIn = cpSummary ? cpSummary.totalIn : 0;
      if (totalIn < tx.amount * 0.3) {
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
          aiReasoning: `被执行人于 ${tx.transactionDate} 转出 ¥${tx.amount.toLocaleString()} 元，附言标注为“${tx.summary}”。但经全账户双向核验，对手方【${cpName}】在流水全周期内转入总额仅为 ¥${totalIn.toLocaleString()} 元，根本不存在对应的在先借款记录，涉嫌单向虚构债务自造抗辩理由转移资金。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: true
        });
      }
    });

    return matches;
  }
}
