import { classifyBankPageSheet } from '../lib/qwenPageMap';
import { guardParseRequest, secureResponseHeaders, validateUploadedFile } from '../lib/requestSecurity';

export async function onRequestPost(context: any) {
  const rejected = guardParseRequest(context);
  if (rejected) return rejected;
  try {
    const formData = await context.request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return json({ error: '缺少页面缩略图' }, 400);
    const invalidFile = validateUploadedFile(file);
    if (invalidFile) return invalidFile;
    const pageNumbers = String(formData.get('pageNumbers') || '')
      .split(',').map(value => Number.parseInt(value, 10)).filter(value => Number.isInteger(value) && value > 0);
    const pages = await classifyBankPageSheet(file, pageNumbers, context.env, context.request.signal);
    return json({ status: 'success', pages }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || '页面分类失败');
    return json({ error: message.replace(/Gemini/gi, '智能分类服务').replace(/GEMINI_[A-Z_]+/g, '服务配置') }, 502);
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
