import { normalizeMinerUBankStatementStream } from '../lib/mineruBankStatementNormalizer';
import { guardParseRequest, secureResponseHeaders } from '../lib/requestSecurity';

export async function onRequestPost(context: any) {
  const rejected = guardParseRequest(context);
  if (rejected) return rejected;
  try {
    const contentLength = Number(context.request.headers.get('content-length') || 0);
    if (contentLength > 6_000_000) return json({ error: 'MinerU 完整结果过大' }, 413);
    const input = await context.request.json();
    const requestId = crypto.randomUUID();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const send = (payload: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
          } catch {
            closed = true;
          }
        };
        send({ type: 'init', requestId });
        const heartbeat = setInterval(() => send({ type: 'heartbeat', requestId }), 3_000);
        try {
          const result = await normalizeMinerUBankStatementStream(input, context.env, progress => {
            send({ type: 'progress', requestId, ...progress });
          }, context.request.signal);
          send({ type: 'complete', requestId, result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const diagnostic = diagnoseNormalizationError(message);
          send({
            type: 'error',
            requestId,
            error: publicMessage(message),
            diagnosticCode: diagnostic.code,
            diagnosis: diagnostic.diagnosis
          });
        } finally {
          clearInterval(heartbeat);
          if (!closed) controller.close();
        }
      }
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-LawFlow-Request-Id': requestId,
        ...secureResponseHeaders
      }
    });
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

function diagnoseNormalizationError(message: string): { code: string; diagnosis: string } {
  if (/MAX_TOKENS|输出上限/i.test(message)) {
    return {
      code: 'OUTPUT_LIMIT_REACHED',
      diagnosis: '整份识别结果已提取，但结构化整理返回内容达到单次输出长度上限'
    };
  }
  if (/JSON|结构化.*(?:无效|无法读取|不完整)|无法读取.*结构化/i.test(message)) {
    return {
      code: 'INVALID_STRUCTURED_OUTPUT',
      diagnosis: '结构化整理服务已返回内容，但返回格式不完整或无法解析'
    };
  }
  return {
    code: 'NORMALIZATION_FAILED',
    diagnosis: '整份识别结果在结构化整理阶段未能完成'
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...secureResponseHeaders }
  });
}
