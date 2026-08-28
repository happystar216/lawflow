import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule09_ContinuousStableIncome extends BaseRule {
  readonly ruleId = 'RULE_CONTINUOUS_STABLE_INCOME';
  readonly name = '持续稳定经营/工资收入提取';
  readonly category: RuleCategory = 'ABILITY_PROOF';
  readonly defaultSeverity: SeverityLevel = 'L2';
  readonly description = '每月固定工资、经营回款或租金入账，证明被执行人具备履行能力，可申请法院扣留提取劳动收入并对抗“终本”。';
  readonly statutoryBasis = [
    '《民事诉讼法》第254条（扣留、提取被执行人的收入）',
    '《最高人民法院关于严格规范终结本次执行程序的规定》',
    '法释〔2024〕13号第3条'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];

    const executionDate = context.caseMeta.timeline.executionFilingDate;
    const candidates = context.allTransactions.filter(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'IN') return false;
      if (executionDate && tx.transactionDate < executionDate) return false;
      return /工资|薪酬|代发|奖金|劳务费|租金|分红|结息|货款/.test(tx.summary || '') || tx.amount >= 5000;
    });

    const byPayer = new Map<string, typeof candidates>();
    candidates.forEach(tx => {
      const payer = tx.counterpartyName?.trim();
      if (!payer) return;
      byPayer.set(payer, [...(byPayer.get(payer) || []), tx]);
    });

    const incomeTx = Array.from(byPayer.values()).flatMap(group => {
      const months = new Set(group.map(tx => tx.transactionDate.slice(0, 7)));
      return months.size >= 2 ? group : [];
    });

    if (incomeTx.length >= 2) {
      const totalIncome = incomeTx.reduce((sum, t) => sum + t.amount, 0);
      matches.push({
        matchId: `${this.ruleId}_GROUP_ALL`,
        ruleId: this.ruleId,
        ruleName: this.name,
        category: this.category,
        severity: 'L2',
        matchType: 'GROUP',
        transactionIds: incomeTx.map(t => t.id),
        totalAmount: totalIncome,
        timePhase: '全执行周期',
        counterpartyName: '【持续性收入来源方】',
        aiReasoning: `被执行人在已导入流水期间存在疑似收入入账记录共 ${incomeTx.length} 笔，累计 ¥${totalIncome.toLocaleString()} 元。该结果可作为核查收入来源和阶段性履行能力的线索；是否属于稳定、可持续且可供执行的收入，仍需核对付款主体、入账周期、款项性质及必要生活费用。`,
        statutoryBasis: this.statutoryBasis,
        lawyerAdopted: false
      });
    }

    return matches;
  }
}
