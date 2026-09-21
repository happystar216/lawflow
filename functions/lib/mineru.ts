const MINERU_API_ORIGIN = 'https://mineru.net';

export interface MinerUEnvironment {
  MINERU_API_TOKEN?: string;
}

export interface MinerUResultStatus {
  state: 'waiting-file' | 'pending' | 'running' | 'converting' | 'done' | 'failed';
  extractedPages?: number;
  totalPages?: number;
  error?: string;
  zipUrl?: string;
}

export function mineruToken(env: MinerUEnvironment): string {
  const token = String(env.MINERU_API_TOKEN || '').trim();
  if (!token) throw new Error('MINERU_NOT_CONFIGURED');
  return token;
}

export async function submitMinerUPdf(file: File, env: MinerUEnvironment, signal?: AbortSignal): Promise<string> {
  const token = mineruToken(env);
  const dataId = crypto.randomUUID();
  const response = await fetch(`${MINERU_API_ORIGIN}/api/v4/file-urls/batch`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      files: [{ name: safeMinerUFileName(file.name), data_id: dataId, is_ocr: true }],
      model_version: 'vlm',
      enable_table: true,
      enable_formula: false,
      language: 'ch'
    })
  });
  const payload = await readJson(response, 'MinerU 提交任务失败');
  const batchId = String(payload?.data?.batch_id || '').trim();
  const uploadUrl = String(payload?.data?.file_urls?.[0] || '').trim();
  if (!batchId || !uploadUrl) throw new Error('MinerU 未返回上传地址或任务编号');
  assertHttpsUrl(uploadUrl, 'MinerU 上传地址无效');

  // A File/Blob body makes fetch add Content-Type automatically. MinerU's
  // signed OSS URL is generated for a headerless PUT, so send raw bytes.
  const upload = await fetch(uploadUrl, { method: 'PUT', signal, body: await file.arrayBuffer() });
  if (!upload.ok) throw new Error(`MinerU 文件上传失败（${upload.status}）`);
  return batchId;
}

export async function getMinerUResultStatus(
  batchId: string,
  env: MinerUEnvironment,
  signal?: AbortSignal
): Promise<MinerUResultStatus> {
  const token = mineruToken(env);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(batchId)) throw new Error('MinerU 任务编号无效');
  const response = await fetch(`${MINERU_API_ORIGIN}/api/v4/extract-results/batch/${encodeURIComponent(batchId)}`, {
    signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  const payload = await readJson(response, 'MinerU 查询任务失败');
  const raw = Array.isArray(payload?.data?.extract_result)
    ? payload.data.extract_result[0]
    : payload?.data?.extract_result;
  if (!raw) throw new Error('MinerU 未返回任务状态');
  const state = normalizeState(raw.state);
  const progress = raw.extract_progress || {};
  return {
    state,
    extractedPages: finitePositiveInt(progress.extracted_pages),
    totalPages: finitePositiveInt(progress.total_pages),
    error: state === 'failed' ? String(raw.err_msg || 'MinerU 解析失败') : undefined,
    zipUrl: state === 'done' ? String(raw.full_zip_url || '').trim() : undefined
  };
}

async function readJson(response: Response, label: string): Promise<any> {
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${label}（${response.status}）`);
  }
  if (!response.ok || Number(payload?.code) !== 0) {
    throw new Error(`${label}：${String(payload?.msg || response.status)}`);
  }
  return payload;
}

function normalizeState(value: unknown): MinerUResultStatus['state'] {
  const state = String(value || '').toLowerCase();
  return state === 'waiting-file' || state === 'pending' || state === 'running'
    || state === 'converting' || state === 'done' || state === 'failed'
    ? state
    : 'pending';
}

function finitePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function assertHttpsUrl(value: string, message: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(message);
  }
  if (url.protocol !== 'https:') throw new Error(message);
}

function safeMinerUFileName(value: string): string {
  const cleaned = value.replace(/[\\/\u0000-\u001f]/g, '_').trim();
  return (cleaned || 'document.pdf').slice(0, 180);
}
