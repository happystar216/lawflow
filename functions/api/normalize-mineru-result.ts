import { normalizeMinerUBankStatement } from '../lib/mineruBankStatementNormalizer';
import { guardParseRequest, secureResponseHeaders } from '../lib/requestSecurity';

export async function onRequestPost(context: any) {
  const rejected = guardParseRequest(context);
  if (rejected) return rejected;
  try {
    const contentLength = Number(context.request.headers.get('content-length') || 0);
    if (contentLength > 6_000_000) return json({ error: 'MinerU 完整结果过大' }, 413);
    const input = await context.request.json();
    const result = await normalizeMinerUBankStatement(input, context.env, context.request.signal);
    return json(result, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: publicMessage(message) }, /输入|批次|过大/.test(message) ? 400 : 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 405, headers: secureResponseHeaders });
}

function publicMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, '服务凭据')
    .replace(/GEMINI_API_KEY/gi, '结构化整理服务配置');
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...secureResponseHeaders }
  });
}
