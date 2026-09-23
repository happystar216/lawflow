import type { CaseMetadata } from '../types/case';
import type { CaseEvaluationReport } from '../types/evidence';
import type { BankAccount, EvidenceReviewIssue, StandardTransaction } from '../types/transaction';
import type { MinerUPageCheckpoint } from '../parsers/mineruBankStatementParser';

export interface AutomationImportTask {
  id: string;
  fileName: string;
  status: string;
  title: string;
  message?: string;
  impact?: string;
  details?: string;
  transactionCount?: number;
  accountCount?: number;
  diagnosticCode?: string;
  diagnosis?: string;
}

export interface AutomationImportState {
  isProcessing: boolean;
  statusText: string | null;
  progress: {
    percent: number;
    totalTransactions: number;
    statusText: string;
    currentBank?: string;
  } | null;
  tasks: AutomationImportTask[];
  pdfSplitPlans?: Array<{
    fileName: string;
    totalPages: number;
    groups: Array<{ bankName: string; pageSelection: string }>;
    pages: Array<{ page: number; pageType: string; bankName: string; selectedForRecognition: boolean }>;
    validationErrors: string[];
  }>;
}

export interface AutomationAppState {
  ready: boolean;
  currentStep: number;
  caseMetadata: CaseMetadata;
  accounts: BankAccount[];
  transactions: StandardTransaction[];
  reviewIssues: EvidenceReviewIssue[];
  evaluationReport: CaseEvaluationReport | null;
}

export interface LawFlowAutomationSnapshot {
  version: 1;
  enabled: true;
  updatedAt: string;
  app?: AutomationAppState;
  import?: AutomationImportState;
  recognitionPages?: Array<MinerUPageCheckpoint & { documentId: string; runId: string; fileName: string; totalPages: number }>;
}

declare global {
  interface Window {
    __LAWFLOW_AUTOMATION__?: LawFlowAutomationSnapshot;
  }
}

function isAutomationRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('lawflowDebug') === '1';
}

function publish(partial: Partial<Pick<LawFlowAutomationSnapshot, 'app' | 'import'>>): void {
  if (!isAutomationRequested()) return;
  const current = window.__LAWFLOW_AUTOMATION__;
  window.__LAWFLOW_AUTOMATION__ = {
    ...current,
    version: 1,
    enabled: true,
    updatedAt: new Date().toISOString(),
    ...partial
  };
}

/**
 * Read-only bridge for the local black-box runner. It exposes the same state
 * rendered by the production application, but does not provide mutation hooks.
 */
export function publishAutomationAppState(state: AutomationAppState): void {
  publish({ app: state });
}

export function publishAutomationImportState(state: AutomationImportState): void {
  publish({ import: state });
}

export function publishRecognitionCheckpoint(
  checkpoint: MinerUPageCheckpoint,
  document: { documentId: string; runId: string; fileName: string; totalPages: number }
): void {
  if (!isAutomationRequested()) return;
  const snapshot = window.__LAWFLOW_AUTOMATION__;
  if (!snapshot) return;
  snapshot.recognitionPages ||= [];
  snapshot.recognitionPages.push(structuredClone({ ...checkpoint, ...document }));
}
