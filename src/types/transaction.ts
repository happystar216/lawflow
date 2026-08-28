export type FlowDirection = 'IN' | 'OUT'; // 资金方向: 转入 / 转出

export type AccountOwnerType = 
  | 'DEBTOR_MAIN'    // 被执行人本人
  | 'SPOUSE'         // 配偶账户
  | 'SOLE_CORP'      // 一人独资企业/名下公司
  | 'SUSPECT_PROXY'  // 疑似代持人/白手套
  | 'UNKNOWN';       // 未分配

export interface BankAccount {
  accountNumber: string;
  accountName: string;
  bankName: string;
  ownerType: AccountOwnerType;
  fileName: string;
  fileType: 'excel' | 'pdf' | 'csv' | 'ocr';
  totalIn: number;
  totalOut: number;
  transactionCount: number;
  startDate: string;
  endDate: string;
  startBalance: number;
  endBalance: number;
  isBalanced: boolean;
  balanceDiff: number;
}

export interface StandardTransaction {
  id: string;
  accountNumber: string;
  accountName: string;
  bankName: string;
  transactionTime: string; // YYYY-MM-DD or YYYY-MM-DD HH:mm:ss
  transactionDate: string; // YYYY-MM-DD
  direction: FlowDirection;
  amount: number;
  balance: number;
  counterpartyName: string;
  counterpartyAccount?: string;
  counterpartyBank?: string;
  summary: string; // 摘要 / 附言 / 备注
  rawSourceFile: string;
  rawPageNumber?: number; // 对应原始 PDF 或 Excel 行数
  rawRowIndex?: number;

  // Computed & Annotated attributes
  isInternalTransfer?: boolean; // 是否属于内部自有账户互转
  internalTransferPairId?: string; // 对应的对冲交易 ID
  timePhaseTag?: string; // e.g. "执行立案后", "报告财产令送达后", "生效至立案前"
  counterpartyRoleTag?: string; // 律师后标注身份: "被执行人胞弟", "空壳过账公司"
  lawyerNote?: string; // 律师批注
}

export interface CounterpartySummary {
  name: string;
  account?: string;
  totalIn: number; // 转入总额
  totalOut: number; // 转出总额
  netOut: number; // 净流出额 (转出 - 转入)
  transactionCount: number;
  earliestDate: string;
  latestDate: string;
  frequentSummaries: string[];
  roleTag?: string; // 律师手工标注角色
  isSuspectedRelative?: boolean;
  isSuspectedAffiliate?: boolean;
}
