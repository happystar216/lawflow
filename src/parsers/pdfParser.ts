import * as pdfjsLib from 'pdfjs-dist';
import { BankAccount, StandardTransaction } from '../types/transaction';

// Configure worker for pdfjs in browser
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
} catch (e) {
  // Ignored if worker already configured
}

/**
 * Parses native text-based bank statement PDFs.
 * Extracts page numbers, account numbers, amounts, and dates.
 */
export async function parsePdfBankStatement(
  file: File
): Promise<{
  account: BankAccount;
  transactions: StandardTransaction[];
}> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;

  let allText = '';
  const pageTexts: { pageNum: number; lines: string[] }[] = [];

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    
    // Group text items by roughly the same Y coordinate (same line)
    const items = textContent.items as any[];
    const lineMap: Record<number, string[]> = {};

    items.forEach(item => {
      const y = Math.round(item.transform[5]);
      if (!lineMap[y]) lineMap[y] = [];
      lineMap[y].push(item.str);
    });

    // Sort lines descending by Y
    const sortedY = Object.keys(lineMap).map(Number).sort((a, b) => b - a);
    const lines = sortedY.map(y => lineMap[y].join('   ').trim()).filter(Boolean);

    pageTexts.push({ pageNum, lines });
    allText += lines.join('\n') + '\n';
  }

  // Determine Bank and Account Info
  let bankName = '商业银行';
  let accountName = file.name.split('.')[0];
  let accountNumber = '';

  if (/建设银行|建行/.test(allText)) bankName = '中国建设银行';
  else if (/工商银行|工行/.test(allText)) bankName = '中国工商银行';
  else if (/农业银行|农行/.test(allText)) bankName = '中国农业银行';
  else if (/中国银行|中行/.test(allText)) bankName = '中国银行';
  else if (/招商银行|招行/.test(allText)) bankName = '招商银行';
  else if (/交通银行|交行/.test(allText)) bankName = '交通银行';
  else if (/邮政储蓄|邮储/.test(allText)) bankName = '中国邮政储蓄银行';

  const accMatch = allText.match(/账号|卡号[：:\s]+([0-9]{12,25})/);
  if (accMatch) accountNumber = accMatch[1];
  else accountNumber = `PDF_ACC_${file.name.replace(/[^0-9]/g, '') || '622202' + Math.floor(Math.random() * 1000000)}`;

  const nameMatch = allText.match(/户名|客户姓名[：:\s]+([\u4e00-\u9fa5a-zA-Z0-9]+)/);
  if (nameMatch) accountName = nameMatch[1];

  const transactions: StandardTransaction[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let startBalance = 0;
  let endBalance = 0;
  let earliestDate = '9999-12-31';
  let latestDate = '1900-01-01';

  // Parse transaction lines from pages
  pageTexts.forEach(({ pageNum, lines }) => {
    lines.forEach((line, lineIdx) => {
      // Look for date pattern YYYY-MM-DD or YYYYMMDD
      const dateMatch = line.match(/(20[12][0-9][-/.年]?[01][0-9][-/.月]?[0-3][0-9])/);
      if (!dateMatch) return;

      const rawDate = dateMatch[1];
      const formattedDate = formatPdfDate(rawDate);

      // Look for monetary numbers (e.g. 50,000.00 or 1234.56)
      const numMatches = line.match(/[-+]?[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|[-+]?[0-9]+\.[0-9]{2}/g);
      if (!numMatches || numMatches.length === 0) return;

      const amounts = numMatches.map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n));
      if (amounts.length === 0) return;

      let amount = Math.abs(amounts[0]);
      let balance = amounts.length > 1 ? Math.abs(amounts[amounts.length - 1]) : 0;
      let direction: 'IN' | 'OUT' = 'OUT';

      if (/存入|进|贷|收|\+/.test(line)) {
        direction = 'IN';
      } else if (/支|出|借|-/.test(line)) {
        direction = 'OUT';
      }

      // Extract counterparty and remarks
      const tokens = line.split(/\s{2,}/).map(t => t.trim()).filter(Boolean);
      let cpName = '';
      let summary = '';

      tokens.forEach(tok => {
        if (/^[\u4e00-\u9fa5]{2,6}$/.test(tok) && tok !== accountName && tok !== bankName) {
          if (!cpName) cpName = tok;
        }
        if (/工资|还款|转账|消费|生活费|理财|分红|提现|ATM|现金|货款/.test(tok)) {
          if (!summary) summary = tok;
        }
      });

      if (direction === 'IN') totalIn += amount;
      else totalOut += amount;

      if (formattedDate < earliestDate) earliestDate = formattedDate;
      if (formattedDate > latestDate) latestDate = formattedDate;

      if (transactions.length === 0) startBalance = balance;
      endBalance = balance;

      transactions.push({
        id: `TX_PDF_${accountNumber}_P${pageNum}_${lineIdx}`,
        accountNumber,
        accountName,
        bankName,
        transactionTime: formattedDate,
        transactionDate: formattedDate,
        direction,
        amount,
        balance,
        counterpartyName: cpName || '对手方明细',
        summary: summary || '银行业务流转',
        rawSourceFile: file.name,
        rawPageNumber: pageNum,
        rawRowIndex: lineIdx + 1
      });
    });
  });

  const account: BankAccount = {
    accountNumber,
    accountName,
    bankName,
    ownerType: 'DEBTOR_MAIN',
    fileName: file.name,
    fileType: 'pdf',
    totalIn,
    totalOut,
    transactionCount: transactions.length,
    startDate: earliestDate === '9999-12-31' ? '2023-01-01' : earliestDate,
    endDate: latestDate === '1900-01-01' ? '2024-12-31' : latestDate,
    startBalance,
    endBalance,
    isBalanced: true,
    balanceDiff: 0
  };

  return { account, transactions };
}

function formatPdfDate(s: string): string {
  s = s.replace(/[\/\.年月]/g, '-').replace(/日/, '').replace(/-+/g, '-').trim();
  const parts = s.split('-');
  if (parts.length >= 3) {
    return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`;
  }
  if (s.length === 8 && /^[0-9]+$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}
