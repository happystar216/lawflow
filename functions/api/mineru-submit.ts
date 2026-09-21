import { submitMinerUPdf } from '../lib/mineru';
import { guardParseRequest, secureResponseHeaders, validateUploadedFile } from '../lib/requestSecurity';

export async function onRequestPost(context: any) {
  const rejected = guardParseRequest(context);
  if (rejected) return rejected;
  try {
    const formData = await context.request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return json({ error: '缺少 PDF 文件' }, 400);
    const invalid = validateUploadedFile(file);
    if (invalid) return invalid;
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      return json({ error: 'MinerU 对照方案仅接收 PDF' }, 415);
    }
    const batchId = await submitMinerUPdf(file, context.env, context.request.signal);
    return json({ status: 'submitted', batchId }, 202);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'MINERU_NOT_CONFIGURED') {
      return json({ error: 'MinerU 对照方案尚未配置', code: 'MINERU_NOT_CONFIGURED' }, 503);
    }
    return json({ error: publicMessage(message) }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 405, headers: secureResponseHeaders });
}

function publicMessage(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, '服务凭据').replace(/MINERU_API_TOKEN/g, 'MinerU 服务配置');
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...secureResponseHeaders }
  });
}
