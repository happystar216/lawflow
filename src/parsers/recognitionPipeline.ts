export type RecognitionPageType =
  | 'TRANSACTIONS'
  | 'ACCOUNT_LIST'
  | 'ACCOUNT_INFO'
  | 'INVESTIGATION_ORDER'
  | 'BANK_REPLY'
  | 'COVER'
  | 'OTHER_DOCUMENT'
  | 'DOCUMENT'
  | 'BLANK'
  | 'UNKNOWN';

export interface PageEvidence {
  page: number;
  pageType: RecognitionPageType;
  rotation: 0 | 90 | 180 | 270;
  bankName: string;
  accountName: string;
  accountNumbers: string[];
  density: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
  /** Model-proposed position inside the source bank-material section. */
  documentBoundary?: 'START' | 'CONTINUE' | 'UNCERTAIN';
  /** Human-readable section clue, usually the bank name. */
  documentLabel?: string;
  investigationOrderNo?: string;
  locallyBlank?: boolean;
  segmentId?: string;
  segmentStart?: number;
  segmentEnd?: number;
  segmentBankName?: string;
  segmentAccountNumbers?: string[];
}

export interface LogicalDocumentSegment {
  id: string;
  pageStart: number;
  pageEnd: number;
  pages: number[];
  bankName: string;
  accountNumbers: string[];
  rotation: 0 | 90 | 180 | 270;
}

export interface ExtractionBatchPlan {
  id: string;
  segmentId: string;
  bankName: string;
  accountNumbers: string[];
  pages: number[];
  pageStart: number;
  pageEnd: number;
  estimatedRows: number;
  rotation: 0 | 90 | 180 | 270;
}

export type RecognitionFailureKind = 'CAPACITY' | 'TIMEOUT' | 'TRANSIENT' | 'INVALID_OUTPUT' | 'UNKNOWN';

export type CompletenessIssue =
  | 'HARD_FAILURE'
  | 'MISSING_ROWS'
  | 'TRANSACTION_PAGE_EMPTY'
  | 'UNCERTAIN_FIELDS';

export interface PageCompletenessAssessment {
  page: number;
  issues: CompletenessIssue[];
  requiresRecovery: boolean;
  blocksAnalysis: boolean;
}

export interface PageResultForCompleteness {
  pageStart: number;
  transactions: Array<{ dataQualityIssues?: unknown[]; extractionConfidence?: number }>;
  warnings?: string[];
  expectedTransactionCount?: number;
  countComplete?: boolean;
  pageQuality?: Array<{
    expectedCount: number;
    extractedCount: number;
    status: 'COMPLETE' | 'NEEDS_REVIEW';
    pageType?: RecognitionPageType;
  }>;
}

const DEFAULT_TARGET_ROWS = 180;

export function buildLogicalDocumentSegments(pageMap: Map<number, PageEvidence>): LogicalDocumentSegment[] {
  const items = [...pageMap.values()].sort((left, right) => left.page - right.page);
  const segments: LogicalDocumentSegment[] = [];
  let current: LogicalDocumentSegment | undefined;
  let currentIdentity = '';

  const startSegment = (item: PageEvidence, identity: string) => {
    const accounts = reliableAccounts(item);
    const bankName = cleanIdentity(item.bankName);
    current = {
      id: `SEG_${item.page}_${stableHash(`${identity || 'unassigned'}|${item.page}`)}`,
      pageStart: item.page,
      pageEnd: item.page,
      pages: [item.page],
      bankName,
      accountNumbers: accounts,
      rotation: item.rotation
    };
    currentIdentity = identity;
    segments.push(current);
  };

  for (const item of items) {
    const identity = pageIdentity(item);
    if (!current) {
      startSegment(item, identity);
      continue;
    }
    if (identity && currentIdentity && identity !== currentIdentity) {
      startSegment(item, identity);
      continue;
    }
    current.pages.push(item.page);
    current.pageEnd = item.page;
    if (!currentIdentity && identity) {
      currentIdentity = identity;
      current.bankName = cleanIdentity(item.bankName);
      current.accountNumbers = reliableAccounts(item);
    }
  }
  return segments;
}

export function planExtractionBatches(
  segments: LogicalDocumentSegment[],
  pageMap: Map<number, PageEvidence>,
  pendingPages: Set<number>,
  targetRows = DEFAULT_TARGET_ROWS
): ExtractionBatchPlan[] {
  const plans: ExtractionBatchPlan[] = [];
  const safeTarget = Math.max(40, targetRows);

  for (const segment of segments) {
    let batchPages: number[] = [];
    let estimatedRows = 0;
    let part = 1;

    const flush = () => {
      if (!batchPages.length) return;
      if (batchPages.some(page => pendingPages.has(page))) {
        plans.push({
          id: `${segment.id}-PART${part}-P${batchPages[0]}-${batchPages.at(-1)}`,
          segmentId: segment.id,
          bankName: segment.bankName,
          accountNumbers: segment.accountNumbers,
          pages: batchPages,
          pageStart: batchPages[0],
          pageEnd: batchPages.at(-1)!,
          estimatedRows,
          rotation: segment.rotation
        });
        part += 1;
      }
      batchPages = [];
      estimatedRows = 0;
    };

    for (const page of segment.pages) {
      const pageCost = estimatePageRows(pageMap.get(page));
      if (batchPages.length && estimatedRows + pageCost > safeTarget) flush();
      batchPages.push(page);
      estimatedRows += pageCost;
    }
    flush();
  }
  return plans;
}

export function assessPageCompleteness(
  result: PageResultForCompleteness,
  mapped?: PageEvidence
): PageCompletenessAssessment {
  const quality = result.pageQuality?.[0];
  // The extraction pass has seen the original PDF page at full fidelity, while
  // the page map is deliberately built from small thumbnails. Let a definite
  // extraction classification override an earlier thumbnail guess. The map is
  // only a fallback when extraction could not classify the page.
  const resolvedPageType = quality?.pageType && quality.pageType !== 'UNKNOWN'
    ? quality.pageType
    : mapped?.pageType;
  const expected = result.expectedTransactionCount ?? quality?.expectedCount;
  const issues: CompletenessIssue[] = [];
  const hardFailure = Boolean(result.warnings?.some(warning => warning.includes('连续识别失败')));
  if (hardFailure) issues.push('HARD_FAILURE');
  if (expected !== undefined && expected > result.transactions.length) issues.push('MISSING_ROWS');
  if (!result.transactions.length && resolvedPageType === 'TRANSACTIONS') {
    issues.push('TRANSACTION_PAGE_EMPTY');
  }
  if (result.transactions.some(transaction =>
    Boolean(transaction.dataQualityIssues?.length) || (transaction.extractionConfidence ?? 1) < 0.8
  )) issues.push('UNCERTAIN_FIELDS');

  const requiresRecovery = issues.some(issue =>
    issue === 'HARD_FAILURE' || issue === 'MISSING_ROWS' || issue === 'TRANSACTION_PAGE_EMPTY'
  );
  return {
    page: result.pageStart,
    issues: [...new Set(issues)],
    requiresRecovery,
    blocksAnalysis: hardFailure || issues.includes('MISSING_ROWS') || issues.includes('TRANSACTION_PAGE_EMPTY')
  };
}

export function classifyRecognitionFailure(error: unknown): RecognitionFailureKind {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/OUTPUT_LIMIT|MAX_TOKENS|length limit|输出.{0,8}(上限|超限)|请求体.{0,8}(过大|超限)|\b413\b/i.test(message)) {
    return 'CAPACITY';
  }
  if (/timeout|超时|长时间没有|最长处理时间/i.test(message)) return 'TIMEOUT';
  if (/\b(429|502|503|504|1102)\b|resource limits|temporar|限流/i.test(message)) {
    return 'TRANSIENT';
  }
  if (/结构化|JSON|不完整|没有返回|结果为空|流在完成前中断/i.test(message)) return 'INVALID_OUTPUT';
  return 'UNKNOWN';
}

export function estimatePageRows(page?: PageEvidence): number {
  if (!page) return 12;
  if (page.pageType === 'BLANK') return 0;
  if (page.pageType === 'ACCOUNT_LIST' || page.pageType === 'ACCOUNT_INFO'
    || page.pageType === 'INVESTIGATION_ORDER' || page.pageType === 'BANK_REPLY'
    || page.pageType === 'COVER' || page.pageType === 'OTHER_DOCUMENT'
    || page.pageType === 'DOCUMENT') return 2;
  if (page.pageType === 'UNKNOWN') return 12;
  if (page.density === 'HIGH') return 40;
  if (page.density === 'MEDIUM') return 20;
  return 8;
}

function pageIdentity(item: PageEvidence): string {
  if (item.pageType === 'BLANK') return '';
  const bank = cleanIdentity(item.bankName).toLocaleLowerCase();
  const accounts = reliableAccounts(item);
  if (accounts.length > 1) return `meta|${bank}|${accounts.sort().join(',')}`;
  if (accounts.length === 1) return `account|${bank}|${accounts[0]}`;
  return bank ? `bank|${bank}` : '';
}

function reliableAccounts(item: PageEvidence): string[] {
  return [...new Set((item.accountNumbers || []).map(cleanIdentity)
    .filter(value => value && !value.startsWith('待核验')))];
}

function cleanIdentity(value: string | undefined): string {
  return String(value || '').replace(/[\s\-_—–·•]/g, '').trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).toUpperCase();
}
