import type { MinerUPageCheckpoint } from '../parsers/mineruBankStatementParser';
import type { MinerUStructuredDocument } from '../parsers/mineruResultParser';
import type { StatementPage } from './statementPlan';
import { sourceValidationRisks } from './documentValidation';

// Bump when extraction prompts, model configuration, or page decisions change.
export const RECOGNITION_REVISION = 'evidence-document-validation-v6';
export const RESUME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecognitionResumeStore {
  loadDocument(): Promise<MinerUStructuredDocument | undefined>;
  saveDocument(document: MinerUStructuredDocument): Promise<void>;
  loadPage(page: number, inputKey: string): Promise<MinerUPageCheckpoint | undefined>;
  savePage(checkpoint: MinerUPageCheckpoint, inputKey: string): Promise<void>;
  loadPlanningBatch?(firstPage: number, inputKey: string): Promise<StatementPage[] | undefined>;
  savePlanningBatch?(firstPage: number, inputKey: string, pages: StatementPage[]): Promise<void>;
}

export function recognitionScopeKey(userId: string, caseId: string, documentId: string, respondent: string,
  revision = RECOGNITION_REVISION): string {
  return JSON.stringify([userId, caseId, documentId, respondent, revision]);
}

/** A finished request is not necessarily a reliable page. Never freeze review/failure candidates. */
export function reusablePage(checkpoint: MinerUPageCheckpoint | undefined, page: number): checkpoint is MinerUPageCheckpoint {
  if (!checkpoint || checkpoint.version !== 1 || checkpoint.page !== page || checkpoint.source.page !== page) return false;
  if (checkpoint.context?.basis === 'PROPOSED_CONTINUATION') return false;
  if (checkpoint.sourceValidation?.status === 'FAILED' || sourceValidationRisks([checkpoint]).size) return false;
  const result = checkpoint.selected;
  return result.countComplete === true && result.pageQuality?.length === 1
    && result.pageQuality[0].page === page && result.pageQuality[0].status === 'COMPLETE'
    && Boolean(result.pageQuality[0].pageType) && result.pageQuality[0].pageType !== 'UNKNOWN'
    && result.pageQuality[0].extractedCount === result.transactions.length
    && Number.isFinite(result.pageQuality[0].expectedCount)
    && result.pageQuality[0].expectedCount === result.transactions.length
    && result.transactions.every(row => row.rawPageNumber === page
      && (row.reviewStatus === 'AUTO_PASSED' || row.reviewStatus === 'CORRECTED' || row.reviewStatus === 'VERIFIED'));
}

export async function recognitionInputKey(input: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
