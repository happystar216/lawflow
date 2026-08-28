import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule01_PostEnforcementLargeTransfer extends BaseRule {
  readonly ruleId = 'RULE_POST_ENFORCEMENT_LARGE_TRANSFER';
  readonly name = '执行节点后集中大额转出';
  readonly category: RuleCategory = 'ASSET_TRANSFER';
  readonly defaultSeverity: SeverityLevel = 'L0';
  readonly description = '在执行立案或《报告财产令》送达后，出现单笔或多笔大额整数转出，涉嫌恶意转移财产。';
  readonly statutoryBasis = [
    '《刑法》第313条（拒不执行判决、裁定罪）',
    '法释〔2024〕13号第3条（拒执罪“情节严重”认定标准）',
    '《民法典》第538条'
  ];

  constructor() {
    super();
    this.params = {
      largeAmountThreshold: 50000 // 默认5万元
    };
  }

  evaluate(context: RuleContext): AnomalyMatch[] {
    const threshold = Number(this.params.largeAmountThreshold) || 50000;
    const matches: AnomalyMatch[] = [];
    const t3 = context.caseMeta.timeline.executionFilingDate;
    const t4 = context.caseMeta.timeline.reportOrderServedDate;

    context.allTransactions.forEach(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'OUT') return;
      if (tx.amount < threshold) return;

      const d = tx.transactionDate;
      const isPostReport = t4 && d >= t4;
      const isPostExecution = t3 && d >= t3;

      if (isPostReport || isPostExecution) {
        const phase = isPostReport ? '《报告财产令》送达后' : '执行立案后';
        const severity: SeverityLevel = isPostReport ? 'L0' : 'L0';

        matches.push({
          matchId: `${this.ruleId}_${tx.id}`,
          ruleId: this.ruleId,
          ruleName: this.name,
          category: this.category,
          severity,
          matchType: 'SINGLE',
          transactionIds: [tx.id],
          totalAmount: tx.amount,
          timePhase: phase,
          counterpartyName: tx.counterpartyName,
          aiReasoning: `被执行人在${phase}（${tx.transactionDate}），向对手方【${tx.counterpartyName || '未知对手'}】单笔大额转出 ¥${tx.amount.toLocaleString()} 元（摘要：${tx.summary || '无'}）。该行为发生在法定执行/报告节点之后，直接导致责任财产减少，涉嫌恶意隐匿转移财产。`,
          statutoryBasis: this.statutoryBasis,
          lawyerAdopted: true
        });
      }
    });

    return matches;
  }
}
