import { BankAccount, StandardTransaction } from '../types/transaction';
import { OcrProgressCallback } from './ocrParser';

// Default Hugging Face Spaces OCR Endpoint or Custom URL
export const DEFAULT_OCR_ENDPOINT = 'https://happystar-lawflow-ocr.hf.space/api/parse-bank-statement';

/**
 * Uploads bank statement file (PDF or Image) to cloud PaddleOCR FastAPI backend.
 * Returns 100% genuine Baidu PP-Structure analyzed accounts & transactions.
 */
export async function parseWithCloudPaddleOcr(
  file: File,
  apiUrl: string = DEFAULT_OCR_ENDPOINT,
  onProgress?: OcrProgressCallback
): Promise<{
  account: BankAccount;
  transactions: StandardTransaction[];
}> {
  if (onProgress) onProgress('正在上传至云端 PaddleOCR 深度识别集群...', 0.15);

  const formData = new FormData();
  formData.append('file', file);

  if (onProgress) onProgress('云端 PaddleOCR 正在进行版面分析与印章分离...', 0.4);

  const response = await fetch(apiUrl, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`云端 PaddleOCR 识别失败 (${response.status}): ${errText || response.statusText}`);
  }

  if (onProgress) onProgress('正在下载并校验结构化对账流水...', 0.9);

  const result = await response.json();
  if (result.status !== 'success' || !result.account || !result.transactions) {
    throw new Error('云端服务返回数据格式不符合预期');
  }

  if (onProgress) onProgress(`云端识别完成，成功提取 ${result.transactions.length} 笔流水！`, 1.0);

  return {
    account: result.account,
    transactions: result.transactions
  };
}
