import { BankAccount, StandardTransaction } from '../types/transaction';

export type OcrProgressCallback = (status: string, progress: number) => void;

export const DEFAULT_ECS_HOST = 'https://dale-rosa-island-tattoo.trycloudflare.com';

export async function parsePdfWithAliyunEcs(
  file: File,
  ecsHost: string = DEFAULT_ECS_HOST,
  onProgress?: OcrProgressCallback
): Promise<{
  account: BankAccount;
  transactions: StandardTransaction[];
}> {
  if (onProgress) onProgress('正在将流水文件上传至阿里云高并发 PaddleOCR 引擎...', 0.15);

  const formData = new FormData();
  formData.append('file', file);

  const cleanHost = ecsHost.replace(/\/+$/, '');
  const url = `${cleanHost}/api/parse-bank-statement`;

  if (onProgress) onProgress('阿里云服务器正在进行多进程并行切页与印章穿透识别...', 0.4);

  const resp = await fetch(url, {
    method: 'POST',
    body: formData
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`阿里云 OCR 解析失败 (${resp.status}): ${errText || '请检查服务器或网络'}`);
  }

  if (onProgress) onProgress('正在同步结构化流水并校验平账...', 0.9);

  const data = await resp.json();
  if (data.status !== 'success' || !data.account) {
    throw new Error(data.detail || data.error || '识别结果异常');
  }

  if (onProgress) onProgress(`阿里云极速识别完成！共提取 ${data.transactions.length} 笔证据流水`, 1.0);

  return {
    account: data.account,
    transactions: data.transactions
  };
}
