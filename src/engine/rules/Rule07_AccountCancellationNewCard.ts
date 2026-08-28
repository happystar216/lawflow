import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule07_AccountCancellationNewCard extends BaseRule {
  readonly ruleId = 'RULE_ACCOUNT_CANCELLATION_NEW_CARD';
  readonly name = '突发注销与换卡承接资金';
  readonly category: RuleCategory = 'ASSET_TRANSFER';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '流水摘要出现销户、结清或换卡关键词，提示核实账户状态及是否存在后续承接账户。';
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
          aiReasoning: `该账户于 ${tx.transactionDate} 出现“${tx.summary}”相关摘要，涉及金额 ¥${tx.amount.toLocaleString()} 元，提示可能发生销户、结清或换卡。建议向银行核实账户状态、余额处理方式及同期新开账户；摘要关键词本身不能证明存在逃避执行目的。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: false
        });
      }
    });

    return matches;
  }
}
