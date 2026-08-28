import { BankAccount, StandardTransaction } from '../types/transaction';

export interface OcrProgressInfo {
  currentPage: number;
  totalPages: number;
  percent: number;
  totalTransactions: number;
  statusText?: string;
}

export type OcrProgressCallback = (info: OcrProgressInfo) => void;

export const DEFAULT_ECS_HOST = '';

/**
 * Robust Real-time SSE Stream Consumer with AbortSignal support.
 */
export async function parsePdfWithAliyunEcs(
  file: File,
  ecsHost: string = DEFAULT_ECS_HOST,
  onProgress?: OcrProgressCallback,
  signal?: AbortSignal
): Promise<{
  account: BankAccount;
  transactions: StandardTransaction[];
}> {
  const formData = new FormData();
  formData.append('file', file);

  const cleanHost = ecsHost ? ecsHost.replace(/\/+$/, '') : '';
  const url = `${cleanHost}/api/parse-bank-statement-stream`;

  if (onProgress) {
    onProgress({
      currentPage: 0,
      totalPages: 0,
      percent: 0,
      totalTransactions: 0,
      statusText: '正在上传流水文件并初始化解析引擎...'
    });
  }

  const resp = await fetch(url, {
    method: 'POST',
    body: formData,
    signal
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`解析失败 (${resp.status}): ${errText || '请检查文件格式或网络连接'}`);
  }

  if (!resp.body) {
    throw new Error('未收到服务器流式数据响应');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let resultData: { account?: BankAccount; transactions?: StandardTransaction[] } = {};

  const processChunkLines = (linesToProcess: string[]) => {
    for (const line of linesToProcess) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr) continue;

      try {
        const payload = JSON.parse(jsonStr);
        if (payload.type === 'init') {
          if (onProgress) {
            onProgress({
              currentPage: 0,
              totalPages: payload.totalPages,
              percent: 0,
              totalTransactions: 0,
              statusText: `文件载入完成，共 ${payload.totalPages} 页，开始逐页智能识别与印章穿透...`
            });
          }
        } else if (payload.type === 'progress') {
          if (onProgress) {
            onProgress({
              currentPage: payload.currentPage,
              totalPages: payload.totalPages,
              percent: payload.percent,
              totalTransactions: payload.totalTransactions,
              statusText: `正在识别第 ${payload.currentPage} / ${payload.totalPages} 页 (已提取 ${payload.totalTransactions} 笔交易)...`
            });
          }
        } else if (payload.type === 'complete') {
          resultData = {
            account: payload.account,
            transactions: payload.transactions
          };
        }
      } catch (parseErr) {
        console.warn('Error parsing SSE event payload:', parseErr, jsonStr.slice(0, 80));
      }
    }
  };

  while (true) {
    if (signal?.aborted) {
      reader.cancel();
      throw new Error('用户已手动停止解析');
    }

    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        processChunkLines(buffer.split('\n'));
      }
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    processChunkLines(lines);
  }

  if (!resultData.account || !resultData.transactions) {
    throw new Error('未能完整获取流水结构化解析数据，请重试');
  }

  return {
    account: resultData.account,
    transactions: resultData.transactions
  };
}
