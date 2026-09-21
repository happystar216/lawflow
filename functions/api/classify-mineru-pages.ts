import { classifyMinerUPageTexts } from '../lib/mineruPageMap';
import { guardParseRequest, secureResponseHeaders } from '../lib/requestSecurity';

export async function onRequestPost(context: any) {
  const rejected = guardParseRequest(context);
  if (rejected) return rejected;
  try {
    const body = await context.request.json() as any;
    const inputs = Array.isArray(body?.pages) ? body.pages : [];
    if (!inputs.length || inputs.length > 12) return json({ error: 'MinerU 页面分类批次范围无效' }, 400);
    const pages = await classifyMinerUPageTexts(inputs, context.env, context.request.signal);
    return json({ status: 'success', pages }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || 'MinerU 页面分类失败');
    return json({ error: message.replace(/Qwen|Gemini/gi, '智能分类服务').replace(/[A-Z_]+API_KEY/g, '服务配置') }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 405, headers: secureResponseHeaders });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...secureResponseHeaders }
  });
}
