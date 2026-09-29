import { guardParseRequest, secureResponseHeaders } from '../lib/requestSecurity';
import { decodeQualityRequest, missingQualityConfig, runQualityModel, qualityModelConfig } from '../lib/qualityModel';
import { QUALITY_POLICY_HEADER, type QualityRequest } from '../../src/recognition/qualityProtocol';

export async function onRequestGet(context: any): Promise<Response> {
  const rejected = guardParseRequest(context); if (rejected) return rejected;
  const missing = missingQualityConfig(context.env);
  return Response.json({ ...await qualityModelConfig(context.env), ready: !missing.length, missing
  }, { headers: secureResponseHeaders, status: missing.length ? 503 : 200 });
}

export async function onRequestPost(context: any): Promise<Response> {
  const rejected = guardParseRequest(context); if (rejected) return rejected;
  const expectedPolicy = context.request.headers.get(QUALITY_POLICY_HEADER);
  if (expectedPolicy && expectedPolicy !== (await qualityModelConfig(context.env)).policySHA256)
    return Response.json({ error: '识别配置已更新，请刷新网页后重试' }, { status: 409, headers: secureResponseHeaders });
  let input: QualityRequest;
  try {
    const body = await context.request.text();
    if (body.length > 72 * 1024 * 1024) return new Response('页面请求过大', { status: 413 });
    input = decodeQualityRequest(body, context.request.headers.get('Content-Type') || '');
  } catch { return new Response('识别请求格式错误', { status: 400 }); }
  const missing = missingQualityConfig(context.env);
  if (missing.length) return Response.json({ error: `识别服务缺少配置：${missing.join('、')}` }, { status: 503, headers: secureResponseHeaders });
  const abort = new AbortController();
  const cancel = () => abort.abort(); context.request.signal.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, input.stage === 'mapping' ? 20 * 60_000 : 5 * 60_000);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: unknown) => { if (open) { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { open = false; cancel(); } } };
      const heartbeat = setInterval(() => send({ type: 'progress', stage: input.stage }), 3000);
      send({ type: 'progress', stage: input.stage });
      runQualityModel(input, context.env, abort.signal).then(reply => send({ type: 'complete', ...reply }), error =>
        send({ type: 'error', message: abort.signal.aborted ? '识别请求超时，可继续已保存的进度' : error.message }))
        .finally(() => { clearInterval(heartbeat); clearTimeout(timeout); context.request.signal.removeEventListener('abort', cancel); if (open) { open = false; controller.close(); } });
    },
    cancel() { clearTimeout(timeout); cancel(); }
  });
  return new Response(stream, { headers: { ...secureResponseHeaders, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' } });
}
