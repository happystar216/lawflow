import { BankAccount, StandardTransaction } from '../types/transaction';

export interface GeminiProgressInfo {
  statusText: string;
  totalTransactions: number;
  percent: number;
  currentBank?: string;
  isStreaming?: boolean;
}

export async function parsePdfWithGemini(
  file: File,
  onProgress?: (info: GeminiProgressInfo) => void,
  signal?: AbortSignal
): Promise<{ account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] }> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    throw new Error('仅支持 PDF 格式文件直传 Gemini 解析');
  }

  onProgress?.({
    statusText: '⚡️ 正在直传卷宗 PDF 至 Gemini 3.8 Flash 引擎…',
    totalTransactions: 0,
    percent: 5,
    isStreaming: true
  });

  const formData = new FormData();
  formData.append('file', file);
  formData.append('sourceFileName', file.name);
  formData.append('pageStart', '1');
  formData.append('pageEnd', '128');
  formData.append('totalPages', '128');

  let response: Response;
  try {
    response = await fetch('/api/parse-bank-statement-stream', {
      method: 'POST',
      body: formData,
      signal
    });
  } catch (netErr: any) {
    if (signal?.aborted) {
      throw new Error('用户已手动停止解析');
    }
    throw new Error(`连接云端 Gemini 3.8 Flash 服务异常: ${netErr.message || '网络连接失败'}`);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Gemini 3.8 Flash 解析服务响应异常 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  if (!response.body) {
    throw new Error('解析服务未返回有效数据流');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completeResult: any = null;
  let serverError = '';
  let lastCapturedCount = 0;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr) return;

    try {
      const payload = JSON.parse(dataStr);
      if (payload.type === 'progress') {
        if (typeof payload.totalTransactions === 'number' && payload.totalTransactions > lastCapturedCount) {
          lastCapturedCount = payload.totalTransactions;
        }
        onProgress?.({
          statusText: payload.statusText || '正在进行司法级流水流式对账…',
          totalTransactions: payload.totalTransactions || lastCapturedCount,
          percent: payload.percent || 15,
          currentBank: payload.currentBank,
          isStreaming: true
        });
      } else if (payload.type === 'heartbeat') {
        onProgress?.({
          statusText: payload.statusText || `Gemini 3.8 Flash 深度审查中 (已持续 ${payload.secondsElapsed || 0} 秒)…`,
          totalTransactions: lastCapturedCount,
          percent: Math.min(92, 15 + Math.floor(((payload.secondsElapsed || 0) / 120) * 75)),
          isStreaming: true
        });
      } else if (payload.type === 'complete') {
        completeResult = payload;
      } else if (payload.type === 'error') {
        serverError = payload.message || 'Gemini 解析服务返回异常';
      }
    } catch {
      // 容错单个 SSE 帧格式波动
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const l of lines) handleLine(l);
    }

    if (buffer.trim()) {
      handleLine(buffer.trim());
    }
  } catch (streamErr: any) {
    if (signal?.aborted) {
      throw new Error('用户已手动停止解析');
    }
    throw new Error(`数据流传输中断: ${streamErr.message || '网络连接超时'}`);
  }

  if (serverError) {
    throw new Error(serverError);
  }

  if (!completeResult || !Array.isArray(completeResult.transactions)) {
    throw new Error('Gemini 3.8 Flash 未能返回有效结构化流水数据，请检查文档是否清晰或重新上传');
  }

  return {
    account: completeResult.account,
    accounts: completeResult.accounts || [completeResult.account],
    transactions: completeResult.transactions
  };
}
