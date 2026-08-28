import { CaseMetadata } from '../../types/case';
import { AnomalyMatch, RuleCategory, SeverityLevel } from '../../types/rules';
import { StandardTransaction, CounterpartySummary } from '../../types/transaction';

export interface RuleContext {
  caseMeta: CaseMetadata;
  allTransactions: StandardTransaction[];
  counterpartySummaries: Record<string, CounterpartySummary>;
  options?: Record<string, any>;
}

export abstract class BaseRule {
  abstract readonly ruleId: string;
  abstract readonly name: string;
  abstract readonly category: RuleCategory;
  abstract readonly defaultSeverity: SeverityLevel;
  abstract readonly description: string;
  abstract readonly statutoryBasis: string[];

  enabled: boolean = true;
  params: Record<string, number | string | boolean> = {};

  abstract evaluate(context: RuleContext): AnomalyMatch[];
}
