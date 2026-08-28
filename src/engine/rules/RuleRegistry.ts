import { BaseRule } from './BaseRule';
import { Rule01_PostEnforcementLargeTransfer } from './Rule01_PostEnforcementLargeTransfer';
import { Rule02_CashSmurfing } from './Rule02_CashSmurfing';
import { Rule03_AntMovingCloseRelatives } from './Rule03_AntMovingCloseRelatives';
import { Rule04_FastInFastOutZeroBalance } from './Rule04_FastInFastOutZeroBalance';
import { Rule05_FabricatedRemarksBilateral } from './Rule05_FabricatedRemarksBilateral';
import { Rule06_AffiliatedCompanyTransfer } from './Rule06_AffiliatedCompanyTransfer';
import { Rule07_AccountCancellationNewCard } from './Rule07_AccountCancellationNewCard';
import { Rule08_WealthInsuranceTransfer } from './Rule08_WealthInsuranceTransfer';
import { Rule09_ContinuousStableIncome } from './Rule09_ContinuousStableIncome';
import { Rule10_UndisclosedReceivables } from './Rule10_UndisclosedReceivables';
import { Rule11_FalseAssetDeclaration } from './Rule11_FalseAssetDeclaration';

export class RuleRegistry {
  private rules: Map<string, BaseRule> = new Map();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults() {
    this.register(new Rule01_PostEnforcementLargeTransfer());
    this.register(new Rule02_CashSmurfing());
    this.register(new Rule03_AntMovingCloseRelatives());
    this.register(new Rule04_FastInFastOutZeroBalance());
    this.register(new Rule05_FabricatedRemarksBilateral());
    this.register(new Rule06_AffiliatedCompanyTransfer());
    this.register(new Rule07_AccountCancellationNewCard());
    this.register(new Rule08_WealthInsuranceTransfer());
    this.register(new Rule09_ContinuousStableIncome());
    this.register(new Rule10_UndisclosedReceivables());
    this.register(new Rule11_FalseAssetDeclaration());
  }

  register(rule: BaseRule) {
    this.rules.set(rule.ruleId, rule);
  }

  getRule(ruleId: string): BaseRule | undefined {
    return this.rules.get(ruleId);
  }

  getAllRules(): BaseRule[] {
    return Array.from(this.rules.values());
  }

  toggleRule(ruleId: string, enabled: boolean) {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.enabled = enabled;
    }
  }

  updateParams(ruleId: string, params: Record<string, any>) {
    const rule = this.rules.get(ruleId);
    if (rule) {
      rule.params = { ...rule.params, ...params };
    }
  }
}
