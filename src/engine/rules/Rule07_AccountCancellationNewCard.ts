import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule07_AccountCancellationNewCard extends BaseRule {
  readonly ruleId = 'RULE_ACCOUNT_CANCELLATION_NEW_CARD';
  readonly name = '突发注销与换卡承接资金';
  readonly category: RuleCategory = 'ASSET_TRANSFER';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '原被执行账户突发停止使用或销户，资金转移并在新银行账户中承接。';
  readonly statutoryBasis = [
    '《民事诉讼法》第253条',
    '法释〔2024〕13号第3条（隐匿财产逃避执行）'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];
    // Search for cancellation remarks or transfer to other unknown card
    context.allTransactions.forEach(tx => {
      if (/销户|结清|转卡|换卡/.test(tx.summary || '')) {
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
          aiReasoning: `被执行人账户于 ${tx.transactionDate} 发生疑似销户/结清/换卡操作，涉及金额 ¥${tx.amount.toLocaleString()} 元（摘要：${tx.summary}）。涉嫌通过注销旧账户逃避法院网络查控，需申请法院向对应银行调取新开账户交易明细。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: true
        });
      }
    });

    return matches;
  }
}
