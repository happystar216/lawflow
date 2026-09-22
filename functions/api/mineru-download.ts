import { getMinerUResultStatus } from '../lib/mineru';
import { guardParseRequest, secureResponseHeaders } from '../lib/requestSecurity';

export async function onRequestGet(context: any) {
  const rejected = guardParseRequest(context);
  if (rejected) return rejected;
  try {
    const batchId = new URL(context.request.url).searchParams.get('batchId') || '';
    const result = await getMinerUResultStatus(batchId, context.env, context.request.signal);
    if (result.state !== 'done' || !result.zipUrl) {
      return json({ error: result.error || 'MinerU 结果尚未生成' }, result.state === 'failed' ? 502 : 409);
    }
    const source = await fetch(result.zipUrl, { signal: context.request.signal });
    if (!source.ok || !source.body) return json({ error: `MinerU 结果下载失败（${source.status}）` }, 502);
    return new Response(source.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="mineru-result.zip"',
        ...secureResponseHeaders
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message === 'MINERU_NOT_CONFIGURED' ? 'MinerU 直接识别服务尚未配置' : message }, 502);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...secureResponseHeaders }
  });
}
