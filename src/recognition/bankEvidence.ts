import type { MinerUPageCheckpoint } from '../parsers/mineruBankStatementParser';
import { validSourceQuote } from './statementPlan';

export function canonicalBank(value: string): string {
  const compact = value.replace(/\s/g, '');
  if (/^(?:银行|商业银行|农村商业银行|信用社)$/.test(compact)) return '';
  const names = ['中国工商银行', '中国农业银行', '中国建设银行', '中国银行', '交通银行',
    '中国邮政储蓄银行', '中国光大银行', '招商银行', '中信银行', '兴业银行', '平安银行',
    '中国民生银行', '华夏银行', '浦发银行', '四川农信', '绵阳市商业银行'];
  for (const name of names) if (compact.includes(name)) return name;
  for (const [alias, name] of [['工商银行', '中国工商银行'], ['工行', '中国工商银行'],
    ['农业银行', '中国农业银行'], ['建设银行', '中国建设银行'], ['光大银行', '中国光大银行']] as const) {
    if (compact.includes(alias)) return name;
  }
  return compact.replace(/股份有限公司|有限责任公司/g, '');
}

export function pageBankEvidence(checkpoint: MinerUPageCheckpoint): string | undefined {
  const bank = checkpoint.statement?.descriptor.bank;
  const bankBlock = checkpoint.source.blocks.find(block => block.order === bank?.evidence.block);
  if (bank && bank.evidence.page === checkpoint.page && validSourceQuote(bank.evidence, [checkpoint.source])
    && bank.evidence.quote.replace(/\s/g, '').includes(bank.value.replace(/\s/g, ''))
    && !/对方|对手|收款|付款/.test(bank.evidence.quote)
    && (!(bankBlock?.type === 'table' || /<table\b/i.test(bankBlock?.content || ''))
      || /本方银行|开户银行[:：]/.test(bank.evidence.quote))) return canonicalBank(bank.value);
  // Planning is optional: retain independent printed headers, never filenames,
  // investigation-order addressees or counterparty bank cells.
  const found = new Set<string>();
  for (const block of checkpoint.source.blocks) {
    if (block.type === 'table' || block.type === 'source_page_text' || /<table\b/i.test(block.content)) continue;
    for (const line of block.content.split(/[\r\n]/)) {
      const text = line.trim();
      if (text.length > 90 || /对方|对手|收款|付款|法院|调查令|致[:：]|贵行/.test(text)) continue;
      // A printed servicing branch is direct evidence of the *own* bank on a
      // statement page. It is often the only institution label on ICBC pages.
      // Do not treat free-form narrative or a counterparty cell as a header.
      const branch = text.match(/^(?:网点名称|交易机构名称|开户机构名称|开户机构|打印机构名称|打印机构)[：:]\s*(.+)$/);
      if (branch && /(?:银行|农信|信用社|农商行|^工行|^农行)/.test(branch[1])) {
        const name = canonicalBank(branch[1]);
        if (name) found.add(name);
        continue;
      }
      const header = text.replace(/^(?:[A-Z]+\s+|开户银行[:：]\s*|开户行[:：]\s*|银行名称[:：]\s*)/, '').replace(/\s/g, '');
      if (/^[\u4e00-\u9fff]{2,35}(?:银行|农信|信用社|信用联社|农商行)(?:股份有限公司|有限责任公司|[\u4e00-\u9fff]*支行)?(?:交易明细|流水|账户|活期|历史|查询|清单|明细|账单|表|证明)*$/.test(header)) {
        const name = canonicalBank(header.replace(/(?:交易明细|流水|账户|活期|历史|查询|清单|明细|账单|表|证明).*$/, ''));
        if (name) found.add(name);
      }
    }
  }
  // A PDF model can guess an institution on a headerless continuation. Keep its
  // proposal in the checkpoint, but do not turn it into an evidenced bank name.
  return found.size === 1 ? [...found][0] : undefined;
}
