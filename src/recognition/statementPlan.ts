export interface PlanningPage {
  page: number;
  blocks: Array<{ order: number; type: string; content: string }>;
}
export interface SourceQuote { page: number; block: number; quote: string }
export interface QuotedValue { value: string; evidence: SourceQuote }
export interface StatementPage {
  page: number;
  type: 'TRANSACTIONS' | 'ACCOUNT_LIST' | 'ACCOUNT_INFO' | 'DOCUMENT' | 'BLANK' | 'UNKNOWN';
  bank: QuotedValue | null;
  accounts: QuotedValue[];
  headers: SourceQuote[];
  relation: 'START' | 'CONTINUE' | 'UNKNOWN';
  continuation: SourceQuote[];
  confidence: number;
  issues: string[];
  /** Raw structured proposal retained before evidence checks or boundary vetoes. */
  proposal?: Record<string, unknown>;
}
export interface StatementGroup {
  id: string;
  pages: number[];
  bank: string;
  accounts: string[];
  needsReview: boolean;
}
export interface StatementPagePlan {
  descriptor: StatementPage;
  group: StatementGroup;
}

export function unknownStatementPage(page: number, reason: string): StatementPage {
  return { page, type: 'UNKNOWN', bank: null, accounts: [], headers: [], relation: 'UNKNOWN',
    continuation: [], confidence: 0, issues: [reason] };
}

/** Quotes must refer to text actually supplied on the claimed page and block. */
export function validSourceQuote(value: unknown, pages: PlanningPage[]): value is SourceQuote {
  if (!value || typeof value !== 'object') return false;
  const quote = value as SourceQuote;
  return Number.isInteger(quote.page) && Number.isInteger(quote.block)
    && typeof quote.quote === 'string' && quote.quote.trim().length >= 2 && quote.quote.length <= 2000
    && Boolean(pages.find(page => page.page === quote.page)?.blocks
      .find(block => block.order === quote.block)?.content.includes(quote.quote));
}

export function validateStatementPages(raw: unknown, pages: PlanningPage[], targets: number[]): StatementPage[] {
  const items: any[] = Array.isArray(raw) ? raw : [];
  return targets.map(page => {
    const matches = items.filter(item => item?.page === page);
    if (matches.length !== 1) return unknownStatementPage(page, '分组结果缺页或重复，本页独立处理');
    const item = matches[0];
    const issues: string[] = (Array.isArray(item.issues) ? item.issues : [])
      .filter((value: unknown) => typeof value === 'string').slice(0, 4).map((value: string) => value.slice(0, 200));
    if (!Array.isArray(item.accounts) || !Array.isArray(item.headers) || !Array.isArray(item.continuation)
      || (item.bank !== null && (!item.bank || typeof item.bank !== 'object'))) issues.push('分组返回字段结构不完整');
    const valueWithEvidence = (value: any): QuotedValue | null => {
      if (!value) return null;
      if (typeof value.value !== 'string' || !value.value.trim() || value.value.length > 100
        || !validSourceQuote(value.evidence, pages) || value.evidence.page !== page
        || !value.evidence.quote.replace(/\s/g, '').includes(value.value.replace(/\s/g, ''))) {
        issues.push('分组字段缺少可定位的原文依据');
        return null;
      }
      return { value: value.value.trim(), evidence: value.evidence };
    };
    const bank = valueWithEvidence(item.bank);
    const headers: SourceQuote[] = (Array.isArray(item.headers) ? item.headers : []).filter((quote: unknown) =>
      validSourceQuote(quote, pages) && quote.page === page).slice(0, 4);
    const accountCandidates = (Array.isArray(item.accounts) ? item.accounts.slice(0, 100) : [])
      .map(valueWithEvidence).filter((value: QuotedValue | null): value is QuotedValue => Boolean(value))
      .filter((value: QuotedValue) => {
        if (!/^[0-9][0-9 -]{7,39}$/.test(value.value)) return false;
        const block = pages.find(source => source.page === page)?.blocks.find(block => block.order === value.evidence.block);
        if ((block?.type === 'table' || /<table\b/i.test(block?.content || ''))
          && !headers.some(header => header.block === value.evidence.block)) {
          issues.push('表格账号缺少同表的有效表头证据');
          return false;
        }
        return true;
      });
    // Repeated rows are observations of one account, not additional accounts.
    // Only identical digits are deduplicated; suffixes and similar IDs stay distinct.
    const accounts: QuotedValue[] = [...new Map<string, QuotedValue>(accountCandidates.map((value: QuotedValue) =>
      [value.value.replace(/[\s-]/g, ''), value])).values()];
    const continuation = (Array.isArray(item.continuation) ? item.continuation : []).filter((quote: unknown) =>
      validSourceQuote(quote, pages) && (quote.page === page || quote.page === page - 1)).slice(0, 4);
    const type = /^(TRANSACTIONS|ACCOUNT_LIST|ACCOUNT_INFO|DOCUMENT|BLANK)$/.test(item.type) ? item.type : 'UNKNOWN';
    if ((type === 'ACCOUNT_LIST' || type === 'ACCOUNT_INFO') && !accounts.length) {
      issues.push('已判为账户资料，但没有可验证的账号，不用于账户归属');
    }
    let relation: StatementPage['relation'] = item.relation === 'START' ? 'START' : item.relation === 'CONTINUE' ? 'CONTINUE' : 'UNKNOWN';
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(1, item.confidence)) : 0;
    if (relation === 'CONTINUE' && (confidence < 0.9 || type === 'UNKNOWN' || issues.length
      || !continuation.some((quote: SourceQuote) => quote.page === page)
      || !continuation.some((quote: SourceQuote) => quote.page === page - 1))) {
      relation = 'UNKNOWN';
      issues.push('续页关系缺少两页原文依据，本页独立处理');
    }
    const proposal = item.proposal && typeof item.proposal === 'object' ? item.proposal : {
      page: item.page, type: item.type, bank: item.bank, accounts: item.accounts, headers: item.headers,
      relation: item.relation, continuation: item.continuation, confidence: item.confidence
    };
    return { page, type, bank, accounts, headers, relation, continuation, confidence, issues: [...new Set(issues)], proposal };
  });
}

const accountKey = (value: string) => value.replace(/[\s-]/g, '');
const bankKey = (value: string) => value.replace(/中国|股份有限公司|\s/g, '');

/** The model proposes links; deterministic constraints veto contradictions and gaps. */
export function buildStatementPlan(descriptors: StatementPage[], totalPages: number): Map<number, StatementPagePlan> {
  const output = new Map<number, StatementPagePlan>();
  let group: StatementGroup | undefined;
  let previous: StatementPage | undefined;
  for (let page = 1; page <= totalPages; page += 1) {
    const matches = descriptors.filter(item => item.page === page);
    const descriptor = matches.length === 1 ? structuredClone(matches[0]) : unknownStatementPage(page, '缺少分组信息');
    const accounts = [...new Set(descriptor.accounts.map(value => accountKey(value.value)))];
    const bank = descriptor.bank?.value || '';
    const conflict = Boolean(group && ((bank && group.bank && bankKey(bank) !== bankKey(group.bank))
      || (accounts.length && group.accounts.length && !accounts.every(account => group!.accounts.includes(account)))));
    // Account lists remain separate: they do not establish a unique ledger owner.
    const continues = group && previous && previous.page === page - 1 && descriptor.relation === 'CONTINUE'
      && descriptor.confidence >= 0.9 && !descriptor.issues.length && !conflict
      && previous.confidence >= 0.9 && !previous.issues.length
      && descriptor.continuation.some(quote => quote.page === page)
      && descriptor.continuation.some(quote => quote.page === page - 1)
      && descriptor.type === 'TRANSACTIONS'
      && (previous.type === 'TRANSACTIONS' || previous.type === 'ACCOUNT_INFO')
      && group.accounts.length <= 1 && accounts.length <= 1;
    if (!continues) {
      if (conflict && descriptor.relation === 'CONTINUE') descriptor.issues.push('银行或账号与前段冲突，已分开处理');
      group = { id: `STATEMENT_P${page}`, pages: [], bank, accounts, needsReview: descriptor.type === 'UNKNOWN' };
    }
    group!.pages.push(page);
    if (!group!.bank) group!.bank = bank;
    if (!group!.accounts.length) group!.accounts = accounts;
    if (!accounts.length || descriptor.issues.length) group!.needsReview = true;
    output.set(page, { descriptor, group: group! });
    previous = descriptor;
  }
  return output;
}

/** Metadata is bounded; full original blocks still go to the transaction extractor. */
export function planningPages(pages: PlanningPage[]): PlanningPage[] {
  return pages.map(page => {
    const blocks = page.blocks.length <= 8 ? page.blocks : [...page.blocks.slice(0, 4), ...page.blocks.slice(-4)];
    // A compact account-list table should remain whole. A fixed tiny block cap
    // cuts off its account column and makes even simple metadata unrecoverable.
    const budget = Math.min(8000, Math.floor(12000 / Math.max(1, blocks.length)));
    const head = Math.floor(budget * 0.7);
    const tail = Math.floor(budget * 0.25);
    return { page: page.page, blocks: blocks.map(block => ({ ...block,
      content: block.content.length <= budget ? block.content : block.content.slice(0, head) + '\n[中间内容未用于分组]\n' + block.content.slice(-tail)
    })) };
  });
}
