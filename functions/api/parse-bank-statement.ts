import { parsePdfWithGeminiStream } from '../lib/geminiBankStatement';
import { guardParseRequest, secureResponseHeaders, validateUploadedFile } from '../lib/requestSecurity';

export async function onRequestPost(context: any) {
  const rejected = guardParseRequest(context);
  if (rejected) return rejected;
  try {
    const formData = await context.request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return json({ error: '缺少页面文件' }, 400);
    const invalidFile = validateUploadedFile(file);
    if (invalidFile) return invalidFile;
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (!isPdf) return json({ error: '当前解析服务仅支持 PDF 文件' }, 400);
    if (!context.env?.GEMINI_API_KEY) return json({ error: '页面解析服务尚未完成配置' }, 503);
    const pageStart = positive(formData.get('pageStart'), 1);
    const pageEnd = positive(formData.get('pageEnd'), pageStart);
    const totalPages = positive(formData.get('totalPages'), pageEnd);
    const result = await parsePdfWithGeminiStream(file, context.env, undefined, context.request.signal, {
      respondentName: String(formData.get('respondentName') || '').trim(),
      sourceFileName: String(formData.get('sourceFileName') || file.name),
      pageStart,
      pageEnd,
      totalPages,
      auditHint: String(formData.get('auditHint') || ''),
      isPageSlice: String(formData.get('isPageSlice') || '') === 'true',
      verificationMode: verificationMode(formData.get('verificationMode'))
    });
    return json({
      status: 'success',
      account: result.account,
      accounts: result.accounts,
      transactions: result.transactions,
      totalTransactions: result.transactions.length,
      coveredPages: result.pagesCovered,
      totalPages,
      pageCount: totalPages,
      countComplete: result.countComplete,
      warnings: result.warnings,
      pageQuality: result.pageQuality
    }, 200);
  } catch (error: any) {
    return json({ error: publicErrorMessage(error) }, 502);
  }
}

function verificationMode(value: FormDataEntryValue | null): 'always' | 'auto' | 'skip' {
  return value === 'auto' || value === 'skip' ? value : 'always';
}

function publicErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  return message
    .replace(/Gemini/gi, '智能解析服务')
    .replace(/GEMINI_[A-Z_]+/g, '服务配置')
    .replace(/北京地域\s*/g, '');
}

function positive(value: FormDataEntryValue | null, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function onRequestOptions() {
  return new Response(null, { status: 405, headers: secureResponseHeaders });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...secureResponseHeaders } });
}
