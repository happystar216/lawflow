import { parseBankStatementWithQwen } from '../lib/qwenBankStatement';

export async function onRequestPost(context: any) {
  let formData: FormData;
  try {
    formData = await context.request.formData();
  } catch {
    return new Response('请求格式无效', { status: 400 });
  }
  const file = formData.get('file');
  if (!(file instanceof File)) return new Response('缺少页面文件', { status: 400 });
  const options = chunkOptions(formData, file);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      const heartbeat = setInterval(() => {
        send({ type: 'heartbeat', statusText: '正在逐页解析银行流水，连接保持中…' });
      }, 10_000);
      try {
        send({ type: 'init', totalPages: options.totalPages, pageStart: options.pageStart, pageEnd: options.pageEnd,
          parserVersion: 'page-image-v1' });
        const result = await parseBankStatementWithQwen(file, context.env, statusText => {
          send({ type: 'progress', currentPage: options.pageStart - 1, totalPages: options.totalPages,
            percent: 0, totalTransactions: 0, statusText });
        }, { ...options, signal: context.request.signal });
        send({
          type: 'progress', currentPage: result.pageCount, totalPages: result.pageCount, percent: 100,
          totalTransactions: result.transactions.length,
          statusText: `已完成 ${result.pageCount} 页核查，共提取 ${result.transactions.length} 笔交易`
        });
        const { model: _internalModel, ...publicResult } = result;
        send({ type: 'complete', ...publicResult });
      } catch (error: any) {
        send({ type: 'error', message: publicErrorMessage(error) });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    }
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Access-Control-Allow-Origin': '*' }
  });
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '页面解析失败');
  return message
    .replace(/Qwen/gi, '智能解析服务')
    .replace(/DASHSCOPE_[A-Z_]+/g, '服务配置')
    .replace(/北京地域\s*/g, '');
}

function chunkOptions(formData: FormData, file: File) {
  const number = (key: string, fallback: number) => {
    const value = Number.parseInt(String(formData.get(key) || ''), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const pageStart = number('pageStart', 1);
  const pageEnd = number('pageEnd', pageStart);
  const contextBefore = formData.get('contextBefore');
  const contextAfter = formData.get('contextAfter');
  return {
    sourceFileName: String(formData.get('sourceFileName') || file.name || '银行流水.pdf'),
    pageStart,
    pageEnd,
    totalPages: number('totalPages', pageEnd),
    chunkId: String(formData.get('chunkId') || `P${pageStart}-${pageEnd}`),
    contextBefore: contextBefore instanceof File ? contextBefore : undefined,
    contextAfter: contextAfter instanceof File ? contextAfter : undefined,
    auditHint: String(formData.get('auditHint') || ''),
    isPageSlice: String(formData.get('isPageSlice') || '') === 'true'
  };
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' } });
}
