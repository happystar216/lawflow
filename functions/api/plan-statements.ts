import { planStatementPages, validatePlanningInput } from '../lib/statementPlanner';
import { guardParseRequest, secureResponseHeaders } from '../lib/requestSecurity';

export async function onRequestPost(context: any) {
  const rejected = guardParseRequest(context);
  if (rejected) return rejected;
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), {
    status, headers: { ...secureResponseHeaders, 'Content-Type': 'application/json' }
  });
  let input;
  try {
    const raw = await context.request.text();
    if (raw.length > 150_000) return json({ error: '账单分组内容过大' }, 413);
    input = JSON.parse(raw);
    validatePlanningInput(input);
  } catch { return json({ error: '账单分组输入无效' }, 400); }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 45_000);
  context.request.signal.addEventListener('abort', abort, { once: true });
  if (context.request.signal.aborted) abort();
  try {
    return json({ pages: await planStatementPages(input, context.env, controller.signal) }, 200);
  } catch (error) {
    const detail = error as { status?: number; code?: string };
    return json({ error: controller.signal.aborted ? '账单分组超时或已停止'
      : error instanceof Error ? error.message : '账单分组失败',
      code: controller.signal.aborted ? 'TIMEOUT' : detail.code || 'INVALID_RESULT' },
      controller.signal.aborted ? 504 : detail.status || 502);
  } finally {
    clearTimeout(timer);
    context.request.signal.removeEventListener('abort', abort);
  }
}
