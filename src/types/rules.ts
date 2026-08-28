export type SeverityLevel = 'L0' | 'L1' | 'L2';

export type RuleCategory = 
  | 'ASSET_TRANSFER'   // 转移/隐匿财产
  | 'ABILITY_PROOF'   // 有履行能力而拒不履行
  | 'ASSET_CLUE'      // 可供执行财产线索
  | 'FALSE_REPORT'    // 虚假报告财产比对
  | 'PIERCING_CLUE';  // 追加被执行人/财产混同

export interface AnomalyMatch {
  matchId: string;
  ruleId: string;
  ruleName: string;
  category: RuleCategory;
  severity: SeverityLevel;
  matchType: 'SINGLE' | 'GROUP';
  transactionIds: string[];
  totalAmount: number;
  timePhase: string;
  counterpartyName?: string;
  aiReasoning: string;
  statutoryBasis: string[]; // e.g. ["《民法典》第538条", "法释〔2024〕13号第3条"]
  lawyerAdopted: boolean;
  lawyerNotes?: string;
}

export interface RuleConfig {
  ruleId: string;
  name: string;
  category: RuleCategory;
  defaultSeverity: SeverityLevel;
  description: string;
  statutoryBasis: string[];
  enabled: boolean;
  params: Record<string, number | string | boolean>;
}
