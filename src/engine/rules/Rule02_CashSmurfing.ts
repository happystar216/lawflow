import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule02_CashSmurfing extends BaseRule {
  readonly ruleId = 'RULE_CASH_SMURFING';
  readonly name = '连续临界金额现金支取';
  readonly category: RuleCategory = 'ASSET_TRANSFER';
  readonly defaultSeverity: SeverityLevel = 'L0';
  readonly description = '识别连续多笔特定金额区间的现金支取，提示补充核查现金用途和最终去向。';
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
        aiReasoning: `已识别 ${cashWithdrawals.length} 笔金额介于 ¥${min} 至 ¥${max} 元的现金支取，累计 ¥${total.toLocaleString()} 元。现金支取降低了银行流水对最终去向的可追溯性，但不能仅凭金额区间推定规避监管或转移财产；建议核对取现时间、用途凭证和相关人员。`,
        statutoryBasis: this.statutoryBasis,
        lawyerAdopted: false
      });
    }

    return matches;
  }
}
