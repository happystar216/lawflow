import { createWorker } from 'tesseract.js';
import { BankAccount, StandardTransaction } from '../types/transaction';

export interface OcrProgressCallback {
  (status: string, progress: number): void;
}

/**
 * Parses scanned bank statement images (.png, .jpg, .jpeg, .webp, .bmp)
 * or rendered canvas from image-based PDFs using Tesseract OCR.
 */
export async function parseImageBankStatementWithOcr(
  fileOrCanvas: File | HTMLCanvasElement,
  onProgress?: OcrProgressCallback
): Promise<{
  account: BankAccount;
  transactions: StandardTransaction[];
}> {
  if (onProgress) onProgress('正在初始化本地 OCR 识别引擎...', 0.1);

  // Initialize Tesseract worker with Chinese and English/Numbers
  const worker = await createWorker(['chi_sim', 'eng']);

  let fileName = '扫描件流水.png';
  if (fileOrCanvas instanceof File) {
    fileName = fileOrCanvas.name;
  }

  if (onProgress) onProgress('正在进行版面表格 OCR 文字提取...', 0.3);

  const ret = await worker.recognize(fileOrCanvas);
  const text = ret.data.text;
  await worker.terminate();

  if (onProgress) onProgress('正在结构化清洗 OCR 识别数据...', 0.8);

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Determine Bank
  let bankName = '商业银行';
  let accountName = fileName.split('.')[0];
  let accountNumber = `OCR_ACC_${fileName.replace(/[^0-9]/g, '') || Math.floor(Math.random() * 1000000)}`;

  if (/建设银行|建行/.test(text)) bankName = '中国建设银行';
  else if (/工商银行|工行/.test(text)) bankName = '中国工商银行';
  else if (/农业银行|农行/.test(text)) bankName = '中国农业银行';
  else if (/中国银行|中行/.test(text)) bankName = '中国银行';
  else if (/招商银行|招行/.test(text)) bankName = '招商银行';
  else if (/交通银行|交行/.test(text)) bankName = '交通银行';
  else if (/邮储银行|邮政/.test(text)) bankName = '中国邮政储蓄银行';

  const accMatch = text.match(/账号|卡号[：:\s]+([0-9]{12,25})/);
  if (accMatch) accountNumber = accMatch[1];

  const nameMatch = text.match(/户名|客户姓名|客户名称[：:\s]+([\u4e00-\u9fa5a-zA-Z0-9]+)/);
  if (nameMatch) accountName = nameMatch[1];

  const transactions: StandardTransaction[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let startBalance = 0;
  let endBalance = 0;
  let earliestDate = '9999-12-31';
  let latestDate = '1900-01-01';

  lines.forEach((line, lineIdx) => {
    // 1. Detect Date
    const dateMatch = line.match(/(20[12][0-9][-/.年]?[01]?[0-9][-/.月]?[0-3]?[0-9])/);
    if (!dateMatch) return;

    const formattedDate = formatOcrDate(dateMatch[1]);
    if (!formattedDate) return;

    // 2. Detect Amounts
    const numMatches = line.match(/[-+]?[0-9]{1,3}(?:,[0-9]{3})*\.[0-9]{2}|[-+]?[0-9]+\.[0-9]{2}|[0-9]{3,8}\.00/g);
    if (!numMatches || numMatches.length === 0) return;

    const amounts = numMatches.map(n => parseFloat(n.replace(/,/g, ''))).filter(n => !isNaN(n) && n > 0);
    if (amounts.length === 0) return;

    let amount = amounts[0];
    let balance = amounts.length > 1 ? amounts[amounts.length - 1] : 0;
    let direction: 'IN' | 'OUT' = 'OUT';

    if (/存入|进|贷|收|\+|汇入|转入/.test(line)) {
      direction = 'IN';
    } else if (/支|出|借|-|扣|转出|取现/.test(line)) {
      direction = 'OUT';
    }

    // 3. Extract Counterparty and Remarks
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
      id: `TX_OCR_${accountNumber}_L${lineIdx}`,
      accountNumber,
      accountName,
      bankName,
      transactionTime: formattedDate,
      transactionDate: formattedDate,
      direction,
      amount,
      balance,
      counterpartyName: cpName || '扫描识别对手方',
      summary: summary || '银行业务流转',
      rawSourceFile: fileName,
      rawPageNumber: 1,
      rawRowIndex: lineIdx + 1
    });
  });

  if (onProgress) onProgress('OCR 解析完成！', 1.0);

  const account: BankAccount = {
    accountNumber,
    accountName,
    bankName,
    ownerType: 'DEBTOR_MAIN',
    fileName,
    fileType: 'ocr',
    totalIn,
    totalOut,
    transactionCount: transactions.length,
    startDate: earliestDate === '9999-12-31' ? '2023-01-01' : earliestDate,
    endDate: latestDate === '1900-01-01' ? '2024-12-31' : latestDate,
    startBalance,
    endBalance,
    isBalanced: true,
    balanceDiff: 0,
    balanceAvailable: endBalance > 0
  };

  return { account, transactions };
}

function formatOcrDate(s: string): string {
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
