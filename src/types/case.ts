export interface TimelineNode {
  key: string;
  name: string;
  date: string; // YYYY-MM-DD
  description?: string;
  isCustom?: boolean;
}

export interface AssetDeclarationItem {
  id: string;
  category: 'bank_account' | 'real_estate' | 'vehicle' | 'income' | 'securities' | 'other';
  declaredContent: string;
  declaredValue: number; // In RMB
  notes?: string;
}

export interface CaseMetadata {
  id: string;
  caseNumber: string; // e.g. (2025)京01执123号
  courtName: string; // e.g. 北京市第一中级人民法院
  applicantName: string; // 申请执行人
  respondentName: string; // 被执行人（主要目标）
  respondentIdCard?: string; // 身份证/统一信用代码
  targetAmount: number; // 执行标的总额 (元)
  createdAt: string;
  updatedAt: string;
  
  // Key Timeline nodes
  timeline: {
    debtFormationDate?: string; // T0 债务形成日
    lawsuitFilingDate?: string; // T1 诉讼立案/保全日
    judgmentEffectiveDate?: string; // T2 判决生效日
    executionFilingDate?: string; // T3 执行立案日
    reportOrderServedDate?: string; // T4 报告财产令送达日
    freezeDate?: string; // T5 查封冻结日
    settlementDate?: string; // T6 和解协议签署日
    customNodes: TimelineNode[];
  };

  // Asset declaration filed by debtor to court
  declaredAssets: AssetDeclarationItem[];
}
