const DEFAULT_MAX_UPLOAD_BYTES = 75 * 1024 * 1024;

export function guardParseRequest(context: any): Response | null {
  const request = context.request as Request;
  const url = new URL(request.url);
  const configuredOrigin = String(context.env?.LAWFLOW_ALLOWED_ORIGIN || '').replace(/\/$/, '');
  const allowedOrigin = configuredOrigin || url.origin;
  const origin = request.headers.get('Origin');

  if (origin && origin !== allowedOrigin) {
    return new Response('不允许跨站调用解析服务', { status: 403 });
  }

  if (String(context.env?.LAWFLOW_REQUIRE_ACCESS || '').toLowerCase() === 'true'
    && !request.headers.get('Cf-Access-Jwt-Assertion')) {
    return new Response('需要通过 Cloudflare Access 身份验证', { status: 401 });
  }

  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > DEFAULT_MAX_UPLOAD_BYTES + 1024 * 1024) {
    return new Response('上传文件超过 75MB 限制', { status: 413 });
  }
  return null;
}

export function validateUploadedFile(file: File): Response | null {
  if (file.size > DEFAULT_MAX_UPLOAD_BYTES) return new Response('上传文件超过 75MB 限制', { status: 413 });
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const isImage = file.type.startsWith('image/') || /\.(?:png|jpe?g|webp)$/i.test(file.name);
  if (!isPdf && !isImage) return new Response('不支持的文件格式', { status: 415 });
  return null;
}

export const secureResponseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
