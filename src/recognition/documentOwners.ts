import type { QwenChunkResult } from '../parsers/qwenResultMerger';
import type { MinerUPageCheckpoint } from '../parsers/mineruBankStatementParser';
import { normalizeAccountIdentityPart, isReliableAccountNumber } from '../utils/accountIdentity';
import { preserveExtraction } from './decisionPolicy';
import { pageBankEvidence, canonicalBank } from './bankEvidence';
import { reconcileDocumentIdentities, sourceValidationRisks, requireSourceCheck } from './documentValidation';
import { selectPageCandidate } from './pageCandidates';

/** Resolve identities once using an explicit account inventory, never neighboring transactions. */
export function resolveDocumentOwners(checkpoints: MinerUPageCheckpoint[]): QwenChunkResult[] {
  // Bank identity needs a page-local quoted planning observation, not a filename,
  // model guess, product code, or another account's counterparty bank.
  const evidenced = checkpoints.map(checkpoint => {
    const copy = structuredClone(checkpoint);
    const supported = pageBankEvidence(copy);
    const chosenBank = supported || '待核验银行';
    const unsupported = !supported && [copy.selected.account, ...(copy.selected.accounts || []), ...copy.selected.transactions]
      .some(item => item.bankName && !/待核验|未知|待核对/.test(item.bankName));
    copy.selected.account.bankName = chosenBank;
    for (const account of copy.selected.accounts || []) account.bankName = chosenBank;
    for (const row of copy.selected.transactions) row.bankName = chosenBank;
    if (unsupported) copy.selected.warnings = [...(copy.selected.warnings || []),
      `第 ${copy.page} 页银行名称缺少可定位的原文依据，暂显示“待核验银行”；未采用文件名或无依据的模型名称`];
    return copy;
  });
  const inventory = evidenced.flatMap(checkpoint => {
    const inventoryPage = checkpoint.selected.pageQuality?.some(page => page.pageType === 'ACCOUNT_LIST' || page.pageType === 'ACCOUNT_INFO');
    const quoted = new Set(checkpoint.statement?.descriptor.accounts.map(item => normalizeAccountIdentityPart(item.value)) || []);
    const printed = explicitAccountLinks(checkpoint).numbers;
    if (!inventoryPage && checkpoint.selected.transactions.length) return [];
    const source = normalizeAccountIdentityPart(checkpoint.source.blocks.map(block => block.content.replace(/<[^>]*>/g, ' ')).join(' '));
    return (checkpoint.selected.accounts || []).filter(account =>
      isReliableAccountNumber(account.accountNumber) && source.includes(normalizeAccountIdentityPart(account.accountNumber))
      && (inventoryPage || quoted.has(normalizeAccountIdentityPart(account.accountNumber)) || printed.has(normalizeAccountIdentityPart(account.accountNumber)))
    ).map(account => ({ account, page: checkpoint.page }));
  });
  // Compare candidate rows AFTER resolving explicitly inventoried long/short
  // numbers for matching purposes. Otherwise a legitimate printed short number
  // makes every row look missing from the other reading on multi-account pages.
  for (const checkpoint of evidenced) {
    const primary = checkpoint.candidates.find(candidate => candidate.route === 'MINERU');
    const recovery = checkpoint.candidates.find(candidate => candidate.route === 'ORIGINAL_PDF');
    if (!primary || !recovery) continue;
    const aliases = new Map<string, string>();
    for (const row of [...primary.result.transactions, ...recovery.result.transactions]) {
      const number = normalizeAccountIdentityPart(row.accountNumber);
      const exact = inventory.filter(item => normalizeAccountIdentityPart(item.account.accountNumber) === number);
      const candidates = exact.length ? exact : inventory.filter(({ account }) => {
        const full = normalizeAccountIdentityPart(account.accountNumber);
        return /^\d{12,32}$/.test(number) && full.length > number.length && full.length - number.length <= 4
          && full.endsWith(number) && Boolean(row.accountName?.trim()) && !/待核|未知/.test(row.accountName)
          && account.accountName.trim() === row.accountName.trim();
      });
      const unique = new Set(candidates.map(item => normalizeAccountIdentityPart(item.account.accountNumber)));
      if (unique.size === 1) aliases.set(number, [...unique][0]);
    }
    const bank = pageBankEvidence(checkpoint) || '待核验银行';
    const extraWarnings = (checkpoint.selected.warnings || []).filter(warning => !/两次读取/.test(warning));
    const primaryOwners = new Set(primary.result.transactions.map(row => normalizeAccountIdentityPart(row.accountNumber)));
    const recoveryOwners = new Set(recovery.result.transactions.map(row => normalizeAccountIdentityPart(row.accountNumber)));
    if (primary.result.countComplete === true && primaryOwners.size > 0 && recoveryOwners.size > 0
      && [...primaryOwners].every(number => aliases.has(number))
      && [...recoveryOwners].every(number => !aliases.has(number))) {
      // An unusable rereading must not manufacture a task for every original
      // row. Its raw candidate stays available, but cannot supply field values.
      checkpoint.selected = structuredClone(primary.result);
      for (const item of [checkpoint.selected.account, ...(checkpoint.selected.accounts || []), ...checkpoint.selected.transactions]) item.bankName = bank;
      checkpoint.selected.warnings = [...new Set([...(checkpoint.selected.warnings || []), ...extraWarnings,
        `第 ${checkpoint.page} 页原页复读的账号无法与本方账户资料对应，本次复读未被采纳。原有流水已保留，数字疑点仍需对照原件核对`])];
      continue;
    }
    checkpoint.selected = selectPageCandidate(primary.result, recovery.result, checkpoint.page,
      !checkpoint.sourceValidation && checkpoint.source.blocks.some(block => /colspan\s*=\s*["']?(?:[4-9]|\d{2,})/i.test(block.content)), aliases);
    for (const item of [checkpoint.selected.account, ...(checkpoint.selected.accounts || []), ...checkpoint.selected.transactions]) item.bankName = bank;
    checkpoint.selected.warnings = [...new Set([...(checkpoint.selected.warnings || []), ...extraWarnings])];
  }
  const risks = sourceValidationRisks(evidenced);
  const results = evidenced.map(checkpoint => {
    const result = structuredClone(checkpoint.selected);
    const bankWarnings = new Set<string>();
    result.transactions = result.transactions.map(original => {
      const row = preserveExtraction(original);
      const risk = risks.get(checkpoint.page)?.get(row.id);
      if (risk) requireSourceCheck(row, ['amount', 'direction', 'balance'], risk);
      const number = normalizeAccountIdentityPart(row.accountNumber);
      if (!isReliableAccountNumber(number)) return row;
      const exact = inventory.filter(item => normalizeAccountIdentityPart(item.account.accountNumber) === number);
      const candidates = exact.length ? exact : inventory.filter(({ account }) => {
        const full = normalizeAccountIdentityPart(account.accountNumber);
        const difference = full.length - number.length;
        // A short printed identifier may be associated only with one explicitly
        // listed full identifier for the same named holder. Similar digits,
        // balances and page proximity provide no identity evidence here.
        return /^\d+$/.test(number) && number.length >= 12 && difference >= 1 && difference <= 4
          && full.endsWith(number)
          && Boolean(row.accountName?.trim()) && !/待核验|未知/.test(row.accountName)
          && row.accountName.trim() === account.accountName.trim();
      });
      const unique = new Map(candidates.map(item => [normalizeAccountIdentityPart(item.account.accountNumber), item]));
      if (unique.size !== 1) return row;
      const { account, page } = [...unique.values()][0];
      const previous = row.fieldEvidence!.accountNumber!;
      row.accountNumber = account.accountNumber;
      row.fieldEvidence!.accountNumber = {
        ...previous, currentValue: row.accountNumber,
        ...(number !== normalizeAccountIdentityPart(row.accountNumber) ? {
          origin: 'AUTO_NORMALIZATION', decision: 'SUGGESTED',
          reason: `与第 ${page} 页本方账户清单中同户名的唯一完整账号匹配；原始短账号保留在字段证据中`
        } as const : {})
      };
      if (number !== normalizeAccountIdentityPart(row.accountNumber) && row.reviewStatus !== 'PENDING') row.reviewStatus = 'CORRECTED';
      const bankKey = canonicalBank;
      const unknownBank = (name: string) => !name || /待核验|未知|^商业银行$|^银行$/.test(name);
      if (unknownBank(row.bankName) && !unknownBank(account.bankName)) row.bankName = account.bankName;
      else if (!unknownBank(row.bankName) && !unknownBank(account.bankName) && bankKey(row.bankName) !== bankKey(account.bankName)) {
        bankWarnings.add(`第 ${checkpoint.page} 页银行名称“${row.bankName}”与第 ${page} 页账户清单“${account.bankName}”不一致；账号关联已保留，银行名称请对照原件确认`);
        row.bankName = '待核验银行';
      }
      return row;
    });
    // Page-level aliases are not additional bank accounts. Keep the explicit
    // account-list entities; summaries for transaction pages are rebuilt below.
    const byOriginal = new Map(checkpoint.selected.transactions.map((row, i) => [row.accountNumber, result.transactions[i].accountNumber]));
    const update = (account: QwenChunkResult['account']) => ({ ...account,
      accountNumber: byOriginal.get(account.accountNumber) || account.accountNumber });
    result.account = update(result.account);
    result.accounts = result.accounts?.map(update);
    result.warnings = [...new Set([...(result.warnings || []), ...bankWarnings])];
    return result;
  });
  const aliases = evidenced.flatMap(checkpoint => explicitAccountLinks(checkpoint).aliases
    .filter(link => inventory.some(item => item.account.accountNumber === link.account))
    .map(link => ({ ...link, page: checkpoint.page })));
  return reconcileDocumentIdentities(results, inventory, aliases);
}

/** Explicit labels on account/query receipts survive metadata classification
 * failure. No transaction cells or counterparty labels participate. */
function explicitAccountLinks(checkpoint: MinerUPageCheckpoint) {
  const text = checkpoint.source.blocks.filter(block => block.type !== 'table' && block.type !== 'source_page_text'
    && !/<table\b/i.test(block.content)).map(block => block.content).join('\n');
  const numbers = new Set([...text.matchAll(/(?:^|\n)\s*(?:本方账号|账号|账\/卡号)\s*[:：]\s*(\d{8,32})(?!\d)/g)].map(match => match[1]));
  const aliases = [...text.matchAll(/(?:^|\n)\s*(?:本方账号|账号)\s*[:：]\s*(\d{8,32})\s*\n\s*对应卡号\s*[:：]\s*(\d{8,32})(?!\d)/g)]
    .map(match => ({ account: match[1], card: match[2] }));
  return { numbers, aliases };
}
