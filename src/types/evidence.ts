import { AnomalyMatch } from './rules';
import { CounterpartySummary } from './transaction';

export type DocumentPackageType = 
  | 'PACKAGE_CRIMINAL_REFUSAL'     // 方案A: 拒执罪自诉/公安移送材料
  | 'PACKAGE_RESUME_DETENTION'     // 方案B: 恢复执行/拘留罚款申请附件
  | 'PACKAGE_CREDITOR_REVOCATION'   // 方案C: 债权人撤销权起诉证据清单
  | 'PACKAGE_PIERCE_COMPANY'       // 方案D: 追加股东/公私财产混同证据册
  | 'PACKAGE_FALSE_REPORT_PUNISH'; // 方案E: 虚假报告财产处罚申请包

export interface ExportOptions {
  packageType: DocumentPackageType;
  includeWord: boolean;
  includeExcel: boolean;
  filterAdoptedOnly: boolean;
  minSeverity?: 'L0' | 'L1' | 'L2';
  customTitle?: string;
  lawyerSignature?: string;
}

export interface CaseEvaluationReport {
  totalRawTransactions: number;
  totalRawIn: number;
  totalRawOut: number;
  internalTransferCount: number;
  internalTransferAmount: number;
  netExternalIn: number;
  netExternalOut: number;
  
  // Timeline breakdown
  postExecutionTransferAmount: number;
  postReportOrderTransferAmount: number;
  
  // Solvency vs Debt
  targetDebtAmount: number;
  totalIncomeDuringExecution: number;
  solvencyCoverageRate: number; // e.g. 1.25 (125%)

  // Anomalies
  matches: AnomalyMatch[];
  counterpartySummaries: Record<string, CounterpartySummary>;
}
