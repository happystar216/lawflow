import { AnomalyMatch } from './rules';
import { CounterpartySummary } from './transaction';

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
