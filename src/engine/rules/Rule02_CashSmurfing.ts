import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule02_CashSmurfing extends BaseRule {
  readonly ruleId = 'RULE_CASH_SMURFING';
  readonly name = '拆分取现/临界规避监管';
  readonly category: RuleCategory = 'ASSET_TRANSFER';
  readonly defaultSeverity: SeverityLevel = 'L0';
  readonly description = '连续多日或单日多笔 4.5万~5万元临界现金取现，或频繁ATM/柜台取现让资金去向无法追查。';
  readonly statutoryBasis = [
    '《刑法》第313条',
    '法释〔2024〕13号第3条第(一)项（隐匿、转移财产）',
    '《金融机构大额交易和可疑交易报告管理办法》'
  ];

  constructor() {
    super();
    this.params = {
      minThreshold: 45000,
      maxThreshold: 50000
    };
  }

  evaluate(context: RuleContext): AnomalyMatch[] {
    const min = Number(this.params.minThreshold) || 45000;
    const max = Number(this.params.maxThreshold) || 50000;
    const matches: AnomalyMatch[] = [];

    // Filter cash withdrawals
    const cashWithdrawals = context.allTransactions.filter(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'OUT') return false;
      const isCash = /取现|现金|ATM|柜面取款|支取现金/.test(tx.summary || '') || 
                     /现金|ATM|柜员机|自动取款机/.test(tx.counterpartyName || '');
      const isSmurfingAmount = tx.amount >= min && tx.amount <= max;
      return isCash && isSmurfingAmount;
    });

    if (cashWithdrawals.length >= 2) {
      const total = cashWithdrawals.reduce((sum, t) => sum + t.amount, 0);
      matches.push({
        matchId: `${this.ruleId}_GROUP_ALL`,
        ruleId: this.ruleId,
        ruleName: this.name,
        category: this.category,
        severity: 'L0',
        matchType: 'GROUP',
        transactionIds: cashWithdrawals.map(t => t.id),
        totalAmount: total,
        timePhase: cashWithdrawals[0].timePhaseTag || '执行关联期间',
        counterpartyName: '【现金取现/ATM】',
        aiReasoning: `被执行人存在 ${cashWithdrawals.length} 笔临界大额现金拆分取现行为（每笔金额介于 ¥${min} ~ ¥${max} 元之间），累计提取现金 ¥${total.toLocaleString()} 元。该手法具有典型的规避金融监管、切断资金流向追踪的转移隐匿特征。`,
        statutoryBasis: this.statutoryBasis,
        lawyerAdopted: true
      });
    }

    return matches;
  }
}
