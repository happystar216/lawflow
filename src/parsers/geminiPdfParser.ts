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
  let lastPercent = 5;

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
        const incomingPercent = Number(payload.percent) || 15;
        if (incomingPercent > lastPercent) {
          lastPercent = Math.min(98, incomingPercent);
        }
        onProgress?.({
          statusText: payload.statusText || (lastCapturedCount > 0 
            ? `Gemini 3.8 Flash 正在提取流水明细，已实时捕获 ${lastCapturedCount} 笔…`
            : 'Gemini 3.8 Flash 正在全量深度审查卷宗…'),
          totalTransactions: payload.totalTransactions || lastCapturedCount,
          percent: lastPercent,
          currentBank: payload.currentBank,
          isStreaming: true
        });
      } else if (payload.type === 'heartbeat') {
        const heartbeatPercent = Math.min(92, 15 + Math.floor(((payload.secondsElapsed || 0) / 100) * 75));
        if (heartbeatPercent > lastPercent) {
          lastPercent = heartbeatPercent;
        }
        // 如果已经捕获到交易明细，提示文案保留提取状态，不被保活心跳覆盖倒退
        const displayStatus = lastCapturedCount > 0
          ? `Gemini 3.8 Flash 正在提取流水明细，已实时捕获 ${lastCapturedCount} 笔 (耗时 ${payload.secondsElapsed || 0}s)…`
          : (payload.statusText || `Gemini 3.8 Flash 正在全量深度审查卷宗 (已耗时 ${payload.secondsElapsed || 0}s)…`);

        onProgress?.({
          statusText: displayStatus,
          totalTransactions: lastCapturedCount,
          percent: lastPercent,
          isStreaming: true
        });
      } else if (payload.type === 'complete') {
        lastPercent = 100;
        onProgress?.({
          statusText: `🎉 卷宗审查完成！已成功全量提取并验证 ${payload.totalTransactions || lastCapturedCount} 笔银行流水明细`,
          totalTransactions: payload.totalTransactions || lastCapturedCount,
          percent: 100,
          isStreaming: false
        });
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
