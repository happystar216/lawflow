import { createPdfPageImageRenderer, PDF_RENDER_POLICY } from './pdfPageImageRenderer';
import { createModelRequestQueue } from '../recognition/modelRequestQueue';
import type { GeminiProgressInfo } from './geminiPdfParser';
import { runQualityWorkflow } from '../recognition/qualityWorkflow';
import { QUALITY_ENDPOINT, QUALITY_POLICY_HEADER, QUALITY_REVISION, qualityWireRequest, validateQualityResult, type ModelReply, type QualityRequest } from '../recognition/qualityProtocol';
import type { QualityCallRecord, QualityRunManifest } from '../recognition/qualityRunRecord';
import type { QualityCheckpointStore } from '../store/qualityCheckpointStore';
import { qualityToWeb } from '../recognition/qualityWebAdapter';

export async function requestQualityModel(input: QualityRequest, signal: AbortSignal, policySHA256?: string): Promise<ModelReply> {
  const wire = qualityWireRequest(input);
  const response = await fetch(QUALITY_ENDPOINT, { method: 'POST', signal,
    headers: { 'Content-Type': wire.contentType, ...(policySHA256 ? { [QUALITY_POLICY_HEADER]: policySHA256 } : {}) }, body: wire.body });
  if (!response.ok) {
    let message = `识别服务请求失败（HTTP ${response.status}）`;
    const body = await response.text();
    if (/1102|Worker exceeded resource limits|exceeded.*(?:CPU|memory)/i.test(body)) message = '图像处理超过当前服务器的运行资源限制（Cloudflare 1102），已保存的识别进度仍可继续';
    else { try { message = JSON.parse(body).error || message; } catch { /* Never display provider response bodies. */ } }
    throw new Error(message);
  }
  if (!response.body) throw new Error('识别服务没有返回数据');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', completed: ModelReply | undefined;
  const line = (s: string) => {
    if (!s.startsWith('data:')) return;
    const value = JSON.parse(s.slice(5));
    if (value.type === 'error') throw new Error(value.message);
    if (value.type === 'complete') completed = value;
  };
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let n: number; while ((n = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, n).trim()); buffer = buffer.slice(n + 1); }
    }
    buffer += decoder.decode(); if (buffer.trim()) line(buffer.trim());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  signal.throwIfAborted();
  if (!completed || !['STOP', 'stop'].includes(completed.finishReason)) throw new Error('识别响应中断，可继续之前的进度');
  if (policySHA256 && completed.policySHA256 !== policySHA256) throw new Error('识别配置已更新，请刷新网页后重试');
  validateQualityResult(input.stage, completed.result); return completed;
}

export async function parsePdfWithQualityPipeline(file: File, onProgress: (p: GeminiProgressInfo) => void, signal: AbortSignal,
  options: { store: QualityCheckpointStore; onResumeWarning?: (message: string) => void }) {
  const startedAt = new Date().toISOString();
  const calls: QualityCallRecord[] = [];
  const schedule = createModelRequestQueue(3, signal);
  const callFailures: Array<{ stage: string; page: number; attempt: number; at: string; message: string }> = [];
  const config = await fetch(QUALITY_ENDPOINT, { signal, cache: 'no-store' });
  const status = await config.json();
  if (!config.ok || !status.ready) throw new Error(`识别服务尚未配置完整：${(status.missing || []).join('、')}`);
  if (status.revision !== QUALITY_REVISION || !status.policySHA256) throw new Error('识别流程已更新，请刷新网页后重试');
  const renderer = await createPdfPageImageRenderer(file);
  let cacheWarning = false;
  let resumed = false;
  const warn = () => { if (!cacheWarning) { cacheWarning = true; options.onResumeWarning?.('浏览器未能保存识别证据，请释放存储空间后重试。'); } };
  const base64 = async (blob: Blob): Promise<string> => {
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
    for (let n = 0; n < bytes.length; n += 32768) binary += String.fromCharCode(...bytes.subarray(n, n + 32768));
    return btoa(binary);
  };
  const hash = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(v => v.toString(16).padStart(2, '0')).join('');
  let percent = 0;
  try {
    const delivery = await runQualityWorkflow({ totalPages: renderer.totalPages, signal,
      progress: (statusText, next, totalTransactions = 0) => {
        percent = Math.max(percent, Math.round(next)); onProgress({ statusText, percent, totalTransactions, isStreaming: next < 100 });
      },
      preflightImages: async page => {
        signal.throwIfAborted();
        const original = await renderer.renderPage(page, 0, 150 / 72);
        const bitmap = await createImageBitmap(original.file), canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bitmap, 0, 0); bitmap.close();
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let dark160 = 0, dark210 = 0;
        for (let i = 0; i < data.length; i += 4) { const g = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114); if (g < 160) dark160++; if (g < 210) dark210++; }
        const pixels = data.length / 4; canvas.width = canvas.height = 1;
        const images = [await base64(original.file)];
        for (const rotation of [90, 180, 270]) images.push(await base64((await renderer.renderPage(page, rotation, 150 / 72)).file));
        return { images, metrics: { darkFraction160: dark160 / pixels, darkFraction210: dark210 / pixels, hasPdfText: await renderer.hasText(page) } };
      },
      image: async (page, rotation, dpi) => { signal.throwIfAborted(); return base64((await renderer.renderPage(page, rotation, dpi / 72)).file); },
      call: async (input, page, callOptions) => {
        signal.throwIfAborted();
        const inputSHA256 = await hash(JSON.stringify(input));
        const key = `${status.policySHA256}:${input.stage}:${page}:${inputSHA256}`;
        const callStartedAt = new Date().toISOString();
        const record = (reply: ModelReply, fromCache: boolean, attempts: number) => {
          calls.push({ stage: input.stage, page, inputSHA256, fromCache, attempts,
            startedAt: callStartedAt, completedAt: new Date().toISOString(), reply: structuredClone(reply) });
          return reply;
        };
        const expectedModel = input.stage === 'primaryRecovery' ? status.models?.qwenRecovery
          : ['primary', 'context'].includes(input.stage) ? status.models?.qwen : status.models?.gemini;
        let saved: ModelReply | undefined;
        if (!callOptions?.refresh) try { saved = await options.store.read(key); } catch { warn(); }
        if (saved && saved.policySHA256 === status.policySHA256 && saved.promptSHA256 === status.prompts?.[input.stage] && saved.model === expectedModel) {
          let valid = true;
          try { validateQualityResult(input.stage, saved.result); } catch { valid = false; }
          if (valid) {
            if (!resumed) { resumed = true; options.onResumeWarning?.('已恢复这个原始文件的识别进度，已完成的步骤会直接复用。'); }
            return record(saved, true, 0);
          }
        }
        let reply: ModelReply | undefined, attempts = 0;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { attempts++; reply = await schedule(() => requestQualityModel(input, signal, status.policySHA256)); break; }
          catch (error) {
            signal.throwIfAborted();
            const message = error instanceof Error ? error.message : String(error);
            callFailures.push({ stage: input.stage, page, attempt: attempts, at: new Date().toISOString(), message });
            const label = { preflight: '空白页与方向检查', primary: '原文读取', context: '页眉读取', independent: '关键内容读取',
              mapping: '流水整理', primaryRecovery: '补充原文读取', accounts: '账号归属读取', critical: '关键字段读取' }[input.stage];
            const location = `${page ? `第 ${page} 页` : '整份文件'}的${label}`;
            if (attempt === 2 || /配置|401|402|403/.test(message)) throw new Error(`${location}失败（已尝试 ${attempts} 次）：${message}`);
            onProgress({ statusText: `${location}响应失败，正在第 ${attempts + 1}/3 次尝试…`, percent, totalTransactions: 0, isStreaming: true });
            await new Promise<void>((resolve, reject) => {
              const stop = () => { clearTimeout(timer); reject(signal.reason); };
              const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, 1000 * 2 ** attempt);
              signal.addEventListener('abort', stop, { once: true });
            });
          }
        }
        if (!reply) throw new Error('识别未完成');
        // Evidence is required, not an optional resume optimization.
        try { await options.store.write(key, reply); } catch { warn(); throw new Error('原文证据未能保存，请释放浏览器空间后继续'); }
        return record(reply, false, attempts);
      }
    });
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    const run: QualityRunManifest = { schemaVersion: 1, runId: crypto.randomUUID(), endpoint: new URL(QUALITY_ENDPOINT, location.href).href,
      clientEntry: import.meta.url, revision: QUALITY_REVISION, totalPages: renderer.totalPages,
      sourceSHA256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''),
      startedAt, completedAt: new Date().toISOString(), runKind: calls.some(c => c.fromCache) ? 'RESUMED' : 'FRESH',
      policySHA256: status.policySHA256, models: status.models, prompts: status.prompts, settings: status.settings,
      renderer: PDF_RENDER_POLICY, calls, callFailures };
    const evidence = { ...delivery, run };
    await options.store.saveDelivery(evidence);
    return { ...qualityToWeb(delivery.result, delivery.registry, file.name, renderer.totalPages, delivery.mapping), evidence };
  } finally { await renderer.destroy(); }
}
