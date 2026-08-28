import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { parseImageBankStatementWithOcr, OcrProgressCallback } from './ocrParser';

// Configure Vite PDF.js worker
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
} catch (e) {
  // Ignore fallback
}

/**
 * Parses native text-based bank statement PDFs or automatically falls back
 * to OCR for scanned image-based PDFs (e.g. 128-page court scanned bank records).
 */
export async function parsePdfBankStatement(
  file: File,
  onProgress?: OcrProgressCallback,
  maxOcrPages: number = 6 // Default parse up to 6 pages for scanned PDFs to prevent memory limits
): Promise<{
  account: BankAccount;
  transactions: StandardTransaction[];
}> {
  if (onProgress) onProgress('正在加载并解析 PDF 文件...', 0.05);

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;

  let allText = '';
  const pageTexts: { pageNum: number; lines: string[] }[] = [];
  let totalTextItemsCount = 0;

  // First pass: try extracting vector text
  const pagesToCheck = Math.min(numPages, 10);
  for (let pageNum = 1; pageNum <= pagesToCheck; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      totalTextItemsCount += textContent.items.length;

      // Group text items by Y coordinate
      const items = textContent.items as any[];
      const lineMap: Record<number, string[]> = {};

      items.forEach(item => {
        const y = Math.round(item.transform[5]);
        if (!lineMap[y]) lineMap[y] = [];
        lineMap[y].push(item.str);
      });

      const sortedY = Object.keys(lineMap).map(Number).sort((a, b) => b - a);
      const lines = sortedY.map(y => lineMap[y].join('   ').trim()).filter(Boolean);

      pageTexts.push({ pageNum, lines });
      allText += lines.join('\n') + '\n';
    } catch (err) {
      console.warn(`Error reading vector text on page ${pageNum}:`, err);
    }
  }

  // DETECT IF THIS IS A SCANNED / IMAGE-BASED PDF (0 or very few vector text items)
  if (totalTextItemsCount < 5) {
    if (onProgress) onProgress(`检测到扫描件/图片型 PDF (共 ${numPages} 页)，正在启动 OCR 视觉表格提取...`, 0.1);

    const pagesToScan = Math.min(numPages, maxOcrPages);
    const ocrTransactions: StandardTransaction[] = [];
    let ocrTotalIn = 0;
    let ocrTotalOut = 0;
    let detectedBank = /建行|建设/.test(file.name) ? '中国建设银行' : '中国工商银行';
    let detectedName = file.name.replace(/\.pdf$/i, '');
    let detectedAccount = `PDF_OCR_${file.name.replace(/[^0-9]/g, '') || '621700' + Math.floor(Math.random() * 1000000)}`;

    for (let pageNum = 1; pageNum <= pagesToScan; pageNum++) {
      if (onProgress) {
        onProgress(`正在进行 OCR 页面扫描 (第 ${pageNum} / ${pagesToScan} 页)...`, 0.1 + (pageNum / pagesToScan) * 0.8);
      }

      try {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.5 }); // 1.5x scale for balanced speed and clarity

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        if (ctx) {
          // @ts-ignore
          await page.render({ canvasContext: ctx, viewport }).promise;
          const result = await parseImageBankStatementWithOcr(canvas);

          if (result.account.bankName !== '商业银行') detectedBank = result.account.bankName;
          if (result.account.accountName && result.account.accountName !== '扫描件流水') detectedName = result.account.accountName;
          if (result.account.accountNumber && !result.account.accountNumber.startsWith('OCR_ACC_')) detectedAccount = result.account.accountNumber;

          result.transactions.forEach((tx, idx) => {
            tx.id = `TX_PDF_OCR_P${pageNum}_${idx + 1}`;
            tx.rawPageNumber = pageNum;
            tx.rawRowIndex = idx + 1;
            tx.rawSourceFile = file.name;
            ocrTransactions.push(tx);
            if (tx.direction === 'IN') ocrTotalIn += tx.amount;
            else ocrTotalOut += tx.amount;
          });
        }
      } catch (pageErr) {
        console.warn(`Error scanning page ${pageNum} with OCR:`, pageErr);
      }
    }

    if (onProgress) onProgress('扫描件 PDF 结构化解析完成！', 1.0);

    const account: BankAccount = {
      accountNumber: detectedAccount,
      accountName: detectedName,
      bankName: detectedBank,
      ownerType: 'DEBTOR_MAIN',
      fileName: file.name,
      fileType: 'pdf',
      totalIn: ocrTotalIn,
      totalOut: ocrTotalOut,
      transactionCount: ocrTransactions.length,
      startDate: ocrTransactions.length > 0 ? ocrTransactions[0].transactionDate : '2023-01-01',
      endDate: ocrTransactions.length > 0 ? ocrTransactions[ocrTransactions.length - 1].transactionDate : '2024-12-31',
      startBalance: 0,
      endBalance: 0,
      isBalanced: true,
      balanceDiff: 0,
      balanceAvailable: false
    };

    return { account, transactions: ocrTransactions };
  }

  // --- VECTOR TEXT PDF PARSING ---
  let bankName = '商业银行';
  let accountName = file.name.replace(/\.pdf$/i, '');
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
  else accountNumber = `PDF_ACC_${file.name.replace(/[^0-9]/g, '') || Math.floor(Math.random() * 1000000)}`;

  const nameMatch = allText.match(/户名|客户姓名[：:\s]+([\u4e00-\u9fa5a-zA-Z0-9]+)/);
  if (nameMatch) accountName = nameMatch[1];

  const transactions: StandardTransaction[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let startBalance = 0;
  let endBalance = 0;
  let earliestDate = '9999-12-31';
  let latestDate = '1900-01-01';
  let balanceAvailable = false;

  // Parse transaction lines from pages
  pageTexts.forEach(({ pageNum, lines }) => {
    lines.forEach((line, lineIdx) => {
      // Look for date pattern YYYY-MM-DD or YYYYMMDD
      const dateMatch = line.match(/(20[12][0-9][-/.年]?[01]?[0-9][-/.月]?[0-3]?[0-9])/);
      if (!dateMatch) return;

      const rawDate = dateMatch[1];
      const formattedDate = formatPdfDate(rawDate);

      // Look for monetary numbers (e.g. 50,000.00 or 1234.56)
      const numMatches = line.match(/[-+]?[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|[-+]?[0-9]+\.[0-9]{2}/g);
      if (!numMatches || numMatches.length === 0) return;

      const amounts = numMatches.map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n));
      if (amounts.length === 0) return;

      let amount = Math.abs(amounts[0]);
      let balance = amounts.length > 1 ? amounts[amounts.length - 1] : 0;
      let direction: 'IN' | 'OUT' = 'OUT';

      if (/存入|进|贷|收|\+|汇入|转入/.test(line)) {
        direction = 'IN';
      } else if (/支|出|借|-|扣|转出|取现/.test(line)) {
        direction = 'OUT';
      } else if (amounts.length >= 2) {
        const diff = amounts[amounts.length - 1] - amounts[0];
        if (diff > 0) direction = 'IN';
      }

      if (amounts.length >= 2) {
        balanceAvailable = true;
      }

      // Extract Counterparty and Remarks
      const tokens = line.split(/[\s,，|]+/).map(t => t.trim()).filter(Boolean);
      let cpName = '';
      let summary = '';

      tokens.forEach(tok => {
        if (/^[\u4e00-\u9fa5]{2,8}$/.test(tok) && tok !== accountName && tok !== bankName && !/日期|金额|余额|借方|贷方|存入|支出|摘要/.test(tok)) {
          if (!cpName) cpName = tok;
        }
        if (/工资|还款|转账|消费|生活费|理财|分红|提现|ATM|现金|货款|借款|服务费|往来/.test(tok)) {
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
        id: `TX_PDF_${accountNumber}_P${pageNum}_L${lineIdx}`,
        accountNumber,
        accountName,
        bankName,
        transactionTime: formattedDate,
        transactionDate: formattedDate,
        direction,
        amount,
        balance,
        counterpartyName: cpName || '电子流水对手方',
        summary: summary || '银行交易流转',
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
    isBalanced: balanceAvailable ? Math.abs((startBalance + totalIn - totalOut) - endBalance) < 0.01 : false,
    balanceDiff: balanceAvailable ? Math.round(((startBalance + totalIn - totalOut) - endBalance) * 100) / 100 : 0,
    balanceAvailable
  };

  return { account, transactions };
}

function formatPdfDate(s: string): string {
  s = s.replace(/[\/\.年月]/g, '-').replace(/日/, '').replace(/-+/g, '-').trim();
  const parts = s.split('-');
  if (parts.length >= 3) {
    const y = parts[0].length === 4 ? parts[0] : `20${parts[0]}`;
    const m = parts[1].padStart(2, '0');
    const d = parts[2].padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return s;
}
