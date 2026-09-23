import type { StatementPagePlan } from './statementPlan';

export interface PageReference {
  page: number;
  matchedAccountNumbers: string[];
  blocks: Array<{ order: number; type: string; content: string }>;
}

export interface PageContext {
  version: 1;
  targetPage: number;
  references: PageReference[];
  basis?: 'EXACT_ACCOUNT' | 'PROPOSED_CONTINUATION';
  statementId?: string;
}

export function buildStatementContexts(plan: Map<number, StatementPagePlan>, source: ContextPage[]): Map<number, PageContext> {
  const contexts = new Map<number, PageContext>();
  const groups = new Map([...plan.values()].map(item => [item.group.id, item.group]));
  for (const group of groups.values()) {
    const members = source.filter(page => group.pages.includes(page.page));
    for (const [page, context] of buildPageContexts(members)) contexts.set(page, {
      ...context, basis: 'EXACT_ACCOUNT', statementId: group.id
    });
    if (group.accounts.length !== 1 || !/^\d{12,32}$/.test(group.accounts[0])) continue;
    const anchor = group.pages.map(page => plan.get(page)!).find(item => item.descriptor.accounts.length === 1
      && item.descriptor.accounts[0].value.replace(/[\s-]/g, '') === group.accounts[0]
      && item.descriptor.confidence >= 0.9 && !item.descriptor.issues.length);
    if (!anchor) continue;
    const descriptor = anchor.descriptor;
    const quotes = [...descriptor.accounts.map(account => account.evidence),
      ...(descriptor.bank ? [descriptor.bank.evidence] : []), ...descriptor.headers].slice(0, 6);
    for (const page of group.pages) {
      const target = plan.get(page)!.descriptor;
      const printedOwners = source.find(item => item.page === page)?.ownerAccounts || [];
      if (page === descriptor.page || contexts.has(page) || printedOwners.length || target.accounts.length
        || target.type !== 'TRANSACTIONS' || target.relation !== 'CONTINUE' || target.issues.length) continue;
      contexts.set(page, { version: 1, targetPage: page, basis: 'PROPOSED_CONTINUATION', statementId: group.id,
        references: [{ page: descriptor.page, matchedAccountNumbers: group.accounts,
          blocks: quotes.map(quote => ({ order: quote.block, type: 'statement_reference', content: quote.quote })) }] });
    }
  }
  return contexts;
}

export interface ContextPage {
  page: number;
  ownerAccounts: string[];
  bank: string;
  headers: PageReference['blocks'];
}

/** Context supplies evidence, never a guessed owner inherited from page proximity. */
export function buildPageContexts(pages: ContextPage[]): Map<number, PageContext> {
  const result = new Map<number, PageContext>();
  const bankKey = (bank: string) => bank.replace(/中国|股份有限公司|\s/g, '');
  for (const target of pages) {
    // A multi-owner page needs table-level context, not a page-wide schema.
    if (target.ownerAccounts.length !== 1) continue;
    const number = target.ownerAccounts[0];
    // Short identifiers can collide between institutions; they are not context keys.
    if (!/^\d{12,32}$/.test(number)) continue;
    const matches = pages.filter(page => page.page !== target.page
      && page.ownerAccounts.length === 1 && page.ownerAccounts[0] === number);
    const banks = new Set([target, ...matches].map(page => bankKey(page.bank)).filter(Boolean));
    if (banks.size > 1) continue;
    const references = matches.filter(page => page.headers.length)
      .sort((a, b) => Math.abs(a.page - target.page) - Math.abs(b.page - target.page) || a.page - b.page)
      .slice(0, 2)
      .map(page => ({ page: page.page, matchedAccountNumbers: [number], blocks: page.headers }));
    if (references.length) result.set(target.page, { version: 1, targetPage: target.page, references });
  }
  return result;
}
