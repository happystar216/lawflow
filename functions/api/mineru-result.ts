import { getMinerUResultStatus } from '../lib/mineru';
import { guardParseRequest, secureResponseHeaders } from '../lib/requestSecurity';

export async function onRequestGet(context: any) {
  const rejected = guardParseRequest(context);
  if (rejected) return rejected;
  try {
    const batchId = new URL(context.request.url).searchParams.get('batchId') || '';
    const result = await getMinerUResultStatus(batchId, context.env, context.request.signal);
    if (result.state === 'failed') return json({ status: 'failed', error: result.error || 'MinerU 解析失败' }, 200);
    if (result.state !== 'done') {
      return json({
        status: 'processing',
        state: result.state,
        extractedPages: result.extractedPages,
        totalPages: result.totalPages
      }, 200);
    }
    if (!result.zipUrl) throw new Error('MinerU 已完成，但没有返回结果包');
    return json({ status: 'done', downloadUrl: `/api/mineru-download?batchId=${encodeURIComponent(batchId)}` }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'MINERU_NOT_CONFIGURED') {
      return json({ error: 'MinerU 对照方案尚未配置', code: 'MINERU_NOT_CONFIGURED' }, 503);
    }
    return json({ error: message.replace(/MINERU_API_TOKEN/g, 'MinerU 服务配置') }, 502);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...secureResponseHeaders }
  });
}
