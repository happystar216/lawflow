import { BankAccount, StandardTransaction } from '../types/transaction';
import { getPdfPageCount } from './pdfPageImageRenderer';

export interface GeminiProgressInfo {
  statusText: string;
  totalTransactions: number;
  percent: number;
  currentBank?: string;
  isStreaming?: boolean;
}

export interface GeminiParserClientOptions {
  respondentName?: string;
  totalPages?: number;
  sourceContentHash?: string;
}

const DIRECT_PDF_MAX_PAGES = 20;

export function recognitionModeForPdf(totalPages: number): 'DIRECT' | 'PAGE_BY_PAGE' {
  return totalPages > DIRECT_PDF_MAX_PAGES ? 'PAGE_BY_PAGE' : 'DIRECT';
}

export class RecognitionImportError extends Error {
  constructor(
    message: string,
    public diagnosticCode: string,
    public diagnosis: string
  ) {
    super(message);
    this.name = 'RecognitionImportError';
  }
}

export async function parsePdfWithGemini(
  file: File,
  onProgress?: (info: GeminiProgressInfo) => void,
  signal?: AbortSignal,
  options?: GeminiParserClientOptions
): Promise<{ account: BankAccount; accounts: BankAccount[]; transactions: StandardTransaction[] }> {
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  if (!isPdf) {
    throw new Error('当前识别方式仅支持 PDF 文件');
  }

  // 校验文件体积（Cloudflare 单次请求推荐 75MB 以内）
  const maxBytes = 75 * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(`当前 PDF 文件体积约为 ${(file.size / (1024 * 1024)).toFixed(1)}MB，超过单次上传限制（75MB）。建议适度压缩扫描件，或拆分为上下分册后分别上传。`);
  }

  onProgress?.({
    statusText: '正在安全上传卷宗文件…',
    totalTransactions: 0,
    percent: 5,
    isStreaming: true
  });

  const formData = new FormData();
  const totalPages = options?.totalPages && options.totalPages > 0
    ? options.totalPages
    : await getPdfPageCount(file);
  if (recognitionModeForPdf(totalPages) === 'PAGE_BY_PAGE') {
    onProgress?.({
      statusText: `长卷宗共 ${totalPages} 页，正在启动逐页清点与断点保存…`,
      totalTransactions: 0,
      percent: 2,
      isStreaming: true
    });
    const { parsePdfWithQwen } = await import('./qwenPdfParser');
    return parsePdfWithQwen(file, info => onProgress?.({
      statusText: info.statusText || `正在逐页识别，已完成 ${info.currentPage}/${info.totalPages} 页…`,
      totalTransactions: info.totalTransactions,
      percent: info.percent,
      isStreaming: info.percent < 100
    }), signal, { cacheIdentity: options?.sourceContentHash });
  }
  formData.append('file', file);
  formData.append('sourceFileName', file.name);
  formData.append('pageStart', '1');
  formData.append('pageEnd', String(totalPages));
  formData.append('totalPages', String(totalPages));
  if (options?.respondentName) {
    formData.append('respondentName', options.respondentName.trim());
  }

  let response: Response;
  const startedAt = Date.now();
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
    throw new Error(`连接云端识别服务失败：${netErr.message || '网络连接异常'}`);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`智能识别服务响应异常（${response.status}）：${errorText.slice(0, 200)}`);
  }

  if (!response.body) {
    throw new Error('解析服务未返回有效数据流');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completeResult: any = null;
  let serverError: { message: string; diagnosticCode: string; diagnosis: string } | null = null;
  let lastCapturedCount = 0;
  let lastPercent = 5;
  let lastHeartbeatSeconds = 0;
  let parserVersion = '';
  let requestId = response.headers.get('X-LawFlow-Request-Id') || '';
  let eventCount = 0;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const dataStr = trimmed.slice(5).trim();
    if (!dataStr) return;

    try {
      const payload = JSON.parse(dataStr);
      eventCount += 1;
      if (payload.type === 'init') {
        parserVersion = String(payload.parserVersion || '');
        requestId = String(payload.requestId || requestId);
      } else if (payload.type === 'progress') {
        if (typeof payload.totalTransactions === 'number' && payload.totalTransactions > lastCapturedCount) {
          lastCapturedCount = payload.totalTransactions;
        }
        const incomingPercent = Number(payload.percent) || 15;
        if (incomingPercent > lastPercent) {
          lastPercent = Math.min(98, incomingPercent);
        }
        onProgress?.({
          statusText: payload.statusText || (lastCapturedCount > 0 
            ? `正在提取流水明细，已读取约 ${lastCapturedCount} 笔…`
            : '正在逐页识别卷宗内容…'),
          totalTransactions: payload.totalTransactions || lastCapturedCount,
          percent: lastPercent,
          currentBank: payload.currentBank,
          isStreaming: true
        });
      } else if (payload.type === 'heartbeat') {
        lastHeartbeatSeconds = Math.max(lastHeartbeatSeconds, Number(payload.secondsElapsed) || 0);
        const heartbeatPercent = Math.min(92, 15 + Math.floor(((payload.secondsElapsed || 0) / 100) * 75));
        if (heartbeatPercent > lastPercent) {
          lastPercent = heartbeatPercent;
        }
        // 如果已经捕获到交易明细，提示文案保留提取状态，不被保活心跳覆盖倒退
        const displayStatus = lastCapturedCount > 0
          ? `正在提取流水明细，已读取约 ${lastCapturedCount} 笔（已用时 ${payload.secondsElapsed || 0} 秒）…`
          : (payload.statusText || `正在逐页识别卷宗内容（已用时 ${payload.secondsElapsed || 0} 秒）…`);

        onProgress?.({
          statusText: displayStatus,
          totalTransactions: lastCapturedCount,
          percent: lastPercent,
          isStreaming: true
        });
      } else if (payload.type === 'complete') {
        lastPercent = 100;
        onProgress?.({
          statusText: `结构化提取完成，共识别 ${payload.totalTransactions || lastCapturedCount} 笔；请进入原件核对步骤复核`,
          totalTransactions: payload.totalTransactions || lastCapturedCount,
          percent: 100,
          isStreaming: false
        });
        completeResult = payload;
      } else if (payload.type === 'error') {
        const metrics = payload.diagnostics && typeof payload.diagnostics === 'object'
          ? Object.entries(payload.diagnostics).map(([key, value]) => `${diagnosticMetricLabel(key)}=${String(value)}`).join('，')
          : '';
        const diagnosticCode = String(payload.diagnosticCode || 'SERVER_PARSE_ERROR');
        const serverRequestId = String(payload.requestId || requestId || '无');
        serverError = {
          message: payload.message || '智能识别服务返回异常',
          diagnosticCode,
          diagnosis: `服务端已明确返回失败；${metrics || '没有附加指标'}；请求编号 ${serverRequestId}`
        };
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
    const elapsedSeconds = Math.max(lastHeartbeatSeconds, Math.round((Date.now() - startedAt) / 1000));
    throw new RecognitionImportError(
      `数据流传输中断：${streamErr.message || '浏览器与服务器的连接异常'}`,
      'STREAM_TRANSPORT_INTERRUPTED',
      `连接在收到完成结果前异常中断；已接收约 ${lastCapturedCount} 笔中间结果，耗时约 ${elapsedSeconds} 秒，请求编号 ${requestId || '无'}`
    );
  }

  const capturedServerError = serverError as { message: string; diagnosticCode: string; diagnosis: string } | null;
  if (capturedServerError) {
    throw new RecognitionImportError(capturedServerError.message, capturedServerError.diagnosticCode, capturedServerError.diagnosis);
  }

  if (!completeResult || !Array.isArray(completeResult.transactions)) {
    const elapsedSeconds = Math.max(lastHeartbeatSeconds, Math.round((Date.now() - startedAt) / 1000));
    throw new RecognitionImportError(
      '识别数据流提前结束，未收到最终完成结果',
      'STREAM_ENDED_BEFORE_COMPLETE',
      `服务器连接正常结束，但没有发送完成标记；已接收约 ${lastCapturedCount} 笔中间结果、${eventCount} 个状态事件，文件 ${totalPages} 页，耗时约 ${elapsedSeconds} 秒，处理方式 ${parserVersion || '未知'}，请求编号 ${requestId || '无'}。这通常表示单次长任务被托管平台终止，或上游输出在完成前结束。`
    );
  }

  return {
    account: completeResult.account,
    accounts: completeResult.accounts || [completeResult.account],
    transactions: completeResult.transactions
  };
}

function diagnosticMetricLabel(key: string): string {
  return ({
    receivedTransactions: '已接收中间流水数',
    responseFrames: '服务响应片段数',
    malformedFrames: '异常响应片段数',
    outputTokens: '输出用量',
    finishReason: '停止原因',
    responseCharacters: '响应字符数'
  } as Record<string, string>)[key] || key;
}
