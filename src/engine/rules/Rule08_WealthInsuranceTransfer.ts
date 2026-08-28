import { BaseRule, RuleContext } from './BaseRule';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';

export class Rule08_WealthInsuranceTransfer extends BaseRule {
  readonly ruleId = 'RULE_WEALTH_INSURANCE_TRANSFER';
  readonly name = '保险、证券及理财隐形财产线索';
  readonly category: RuleCategory = 'ASSET_CLUE';
  readonly defaultSeverity: SeverityLevel = 'L1';
  readonly description = '识别冻结前后购买或缴费的保险、证券、基金、信托和理财，提示查询当前保单现金价值、持仓及赎回去向。';
  readonly statutoryBasis = [
    '《民事诉讼法》第253条',
    '《最高人民法院关于人民法院民事执行中查封、扣押、冻结财产的规定》',
    '《保监会、最高法关于规范人民法院查询、冻结、扣划保险业务的通知》'
  ];

  evaluate(context: RuleContext): AnomalyMatch[] {
    const matches: AnomalyMatch[] = [];

    const assetGroups = new Map<string, { type: string; transactions: typeof context.allTransactions }>();

    context.allTransactions.forEach(tx => {
      if (tx.isInternalTransfer || tx.direction !== 'OUT') return;

      const cp = tx.counterpartyName || '';
      const summary = tx.summary || '';
      const isInsurance = /保险|人寿|财险|养老|保险经纪|保险代理/.test(cp) ||
        /保费|投保|续保|续期|趸交|期交|年金|寿险|万能险|分红险|银保|保单/.test(summary);
      const isSecurities = /证券|基金|信托|期权|期货|财富|资产管理/.test(cp) ||
        /申购|认购|基金|第三方存管|银证转账|信托/.test(summary);
      const isWealth = /理财|大额存单/.test(cp) || /理财|大额存单/.test(summary);
      const assetType = isInsurance ? '保险保单' : isSecurities ? '证券/基金/信托' : isWealth ? '银行理财/大额存单' : '';
      const threshold = isInsurance ? 500 : 5000;
      if (!assetType || tx.amount < threshold) return;

      const key = `${assetType}::${cp || summary}`;
      const existing = assetGroups.get(key) || { type: assetType, transactions: [] };
      existing.transactions.push(tx);
      assetGroups.set(key, existing);
    });

    assetGroups.forEach(({ type, transactions }, key) => {
      const sorted = [...transactions].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
      const total = sorted.reduce((sum, tx) => sum + tx.amount, 0);
      const freezeDate = context.caseMeta.timeline.freezeDate;
      const preFreeze = freezeDate ? sorted.filter(tx => tx.transactionDate < freezeDate) : [];
      const counterparty = sorted[0].counterpartyName || '相关金融机构';
      const phase = freezeDate && preFreeze.length === sorted.length
        ? `冻结前购买/缴费（冻结日 ${freezeDate}）`
        : freezeDate && preFreeze.length > 0
        ? `冻结前后均有交易（冻结日 ${freezeDate}）`
        : sorted[0].timePhaseTag || '流水覆盖期间';
      const dateRange = sorted.length === 1
        ? sorted[0].transactionDate
        : `${sorted[0].transactionDate} 至 ${sorted[sorted.length - 1].transactionDate}`;
      const assetExplanation = type === '保险保单'
        ? '即使投保发生在冻结前，保单现金价值、退保金、生存金或保单贷款权益仍可能构成后续财产线索。建议向保险机构核验产品及保单号、投保人/被保险人/受益人、保单状态、现金价值、退保或保单贷款记录、领取账户及资金去向。'
        : '即使申购发生在冻结前，当前持仓、可赎回价值及赎回款仍可能构成后续财产线索。建议向相关金融机构核验产品名称、账户及持仓、可赎回价值、转托管或赎回记录、收款账户及资金去向。';

      matches.push({
        matchId: `${this.ruleId}_${encodeURIComponent(key)}`,
        ruleId: this.ruleId,
        ruleName: `${this.name}·${type}`,
        category: this.category,
        severity: 'L1',
        matchType: sorted.length > 1 ? 'GROUP' : 'SINGLE',
        transactionIds: sorted.map(tx => tx.id),
        totalAmount: total,
        timePhase: phase,
        counterpartyName: counterparty,
        aiReasoning: `流水显示被执行人在 ${dateRange} 向【${counterparty}】支付 ${sorted.length} 笔、合计 ¥${total.toLocaleString()} 元，交易特征指向${type}${preFreeze.length > 0 ? `；其中 ${preFreeze.length} 笔发生在账户冻结前` : ''}。${assetExplanation}`,
        statutoryBasis: this.statutoryBasis,
        lawyerAdopted: false,
        verificationChecklist: type === '保险保单' ? [
          '查询投保人、被保险人、受益人及保单号',
          '确认保单是否有效、失效、退保或发生保单贷款',
          '查询当前现金价值、退保金及生存金/年金领取账户',
          '核对冻结前购买资金来源及冻结后续期缴费情况',
          '核对是否已退保、变更投保人或将领取账户改至第三方'
        ] : [
          '查询当前产品名称、份额、持仓及可赎回价值',
          '核对申购后赎回、转托管或转出记录',
          '追踪赎回资金最终入账账户及是否流向第三方'
        ]
      });
    });

    return matches;
  }
}
