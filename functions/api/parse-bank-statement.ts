import { parseBankStatementWithQwen } from '../lib/qwenBankStatement';

export async function onRequestPost(context: any) {
  try {
    const formData = await context.request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return json({ error: '缺少页面文件' }, 400);
    const pageStart = positive(formData.get('pageStart'), 1);
    const pageEnd = positive(formData.get('pageEnd'), pageStart);
    const contextBefore = formData.get('contextBefore');
    const contextAfter = formData.get('contextAfter');
    const result = await parseBankStatementWithQwen(file, context.env, undefined, {
      sourceFileName: String(formData.get('sourceFileName') || file.name),
      pageStart,
      pageEnd,
      totalPages: positive(formData.get('totalPages'), pageEnd),
      chunkId: String(formData.get('chunkId') || `P${pageStart}-${pageEnd}`),
      contextBefore: contextBefore instanceof File ? contextBefore : undefined,
      contextAfter: contextAfter instanceof File ? contextAfter : undefined,
      auditHint: String(formData.get('auditHint') || ''),
      isPageSlice: String(formData.get('isPageSlice') || '') === 'true',
      signal: context.request.signal
    });
    const { model: _internalModel, ...publicResult } = result;
    return json({ status: 'success', ...publicResult }, 200);
  } catch (error: any) {
    return json({ error: publicErrorMessage(error) }, 502);
  }
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  return message
    .replace(/Qwen/gi, '智能解析服务')
    .replace(/DASHSCOPE_[A-Z_]+/g, '服务配置')
    .replace(/北京地域\s*/g, '');
}

function positive(value: FormDataEntryValue | null, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function onRequestOptions() {
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' } });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
}
