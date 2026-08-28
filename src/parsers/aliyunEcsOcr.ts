import { BankAccount, StandardTransaction } from '../types/transaction';

export type OcrProgressCallback = (status: string) => void;

export const DEFAULT_ECS_HOST = 'https://registered-armor-lbs-married.trycloudflare.com';

export async function parsePdfWithAliyunEcs(
  file: File,
  ecsHost: string = DEFAULT_ECS_HOST,
  onProgress?: OcrProgressCallback
): Promise<{
  account: BankAccount;
  transactions: StandardTransaction[];
}> {
  if (onProgress) onProgress('正在上传并分析银行流水文件...');

  const formData = new FormData();
  formData.append('file', file);

  const cleanHost = ecsHost.replace(/\/+$/, '');
  const url = `${cleanHost}/api/parse-bank-statement`;

  if (onProgress) onProgress('AI 引擎正在逐页提取交易明细与印章穿透...');

  const resp = await fetch(url, {
    method: 'POST',
    body: formData
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`流水解析失败 (${resp.status}): ${errText || '请检查文件格式或网络连接'}`);
  }

  if (onProgress) onProgress('正在完成数据结构化与平账校验...');

  const data = await resp.json();
  if (data.status !== 'success' || !data.account) {
    throw new Error(data.detail || data.error || '流水数据提取异常');
  }

  if (onProgress) onProgress(`解析完成，共提取 ${data.transactions.length} 笔交易记录`);

  return {
    account: data.account,
    transactions: data.transactions
  };
}
