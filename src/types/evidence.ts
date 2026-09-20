import { AnomalyMatch } from './rules';
import { CounterpartySummary } from './transaction';
import { CaseAnalysisGraph } from './analysis';
import { AuditReport } from '../parsers/sanityChecker';

export interface CaseEvaluationReport {
  /** Identifies the exact canonical input used to produce this report. */
  analysisFingerprint?: string;
  generatedAt?: string;
  analysisGraph?: CaseAnalysisGraph;
  accountAudits?: Record<string, AuditReport>;
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
