import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, join, resolve } from 'node:path';
import { BrowserContext, chromium, Page } from 'playwright-core';

const HOST = '127.0.0.1';
const PORT = positiveInteger(process.env.LAWFLOW_DEBUG_PORT, 4318);
const DEFAULT_TARGET = process.env.LAWFLOW_DEBUG_TARGET || 'https://lawtool.cocoaiagent.com/';
const OUTPUT_ROOT = resolve(process.env.LAWFLOW_DEBUG_OUTPUT || 'tmp/online-debug-runs');
const BROWSER_PROFILE_ROOT = resolve(process.env.LAWFLOW_DEBUG_PROFILE || 'tmp/online-debug-profile');
const MAX_FILE_BYTES = positiveInteger(process.env.LAWFLOW_DEBUG_MAX_FILE_MB, 75) * 1024 * 1024;
const MAX_TOTAL_BYTES = positiveInteger(process.env.LAWFLOW_DEBUG_MAX_TOTAL_MB, 250) * 1024 * 1024;
// Large bank bundles can legitimately exceed an hour when several dense pages
// need focused re-reading. Keep the limit configurable, but do not let the
// automation harness terminate a healthy production import prematurely.
const RUN_TIMEOUT_MS = positiveInteger(process.env.LAWFLOW_DEBUG_TIMEOUT_MINUTES, 180) * 60_000;
const RETENTION_MS = positiveInteger(process.env.LAWFLOW_DEBUG_RETENTION_HOURS, 24) * 60 * 60_000;
const TERMINAL_TASK_STATUSES = new Set(['SUCCESS', 'WARNING', 'EMPTY', 'ERROR', 'CANCELLED']);
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.xlsx', '.xls', '.csv']);

type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'ERROR';

interface DebugRun {
  id: string;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  target: string;
  respondentName: string;
  fileNames: string[];
  filePaths: string[];
  outputDir: string;
  progress?: unknown;
  result?: unknown;
  error?: string;
}

interface BrowserDiagnostic {
  at: string;
  type: string;
  message: string;
  url?: string;
  method?: string;
  status?: number;
  requestId?: string;
}

const runs = new Map<string, DebugRun>();
const queue: string[] = [];
let queueActive = false;

async function main(): Promise<void> {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await mkdir(BROWSER_PROFILE_ROOT, { recursive: true });
  await cleanupExpiredRuns();
  const server = createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      console.error('Debug API request failed:', error);
      sendJson(response, error instanceof HttpError ? error.status : 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`LawFlow online debug API: http://${HOST}:${PORT}`);
    console.log(`Default target: ${DEFAULT_TARGET}`);
    console.log(`Artifacts: ${OUTPUT_ROOT}`);
    if (process.env.LAWFLOW_DEBUG_TOKEN) console.log('Bearer token protection: enabled');
  });
  const cleanupTimer = setInterval(() => cleanupExpiredRuns().catch(console.error), 60 * 60_000);
  cleanupTimer.unref();
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method || 'GET';
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/health' && method === 'GET') {
    sendJson(response, 200, { ok: true, active: queueActive, queued: queue.length });
    return;
  }
  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: '缺少或无效的调试接口令牌' });
    return;
  }

  if (url.pathname === '/debug/runs' && method === 'POST') {
    const form = await readMultipartForm(request);
    const target = validateTarget(textField(form, 'target') || DEFAULT_TARGET);
    const respondentName = textField(form, 'respondentName') || '自动化调试案件';
    const files = [...form.entries()]
      .filter(([key, value]) => (key === 'file' || key === 'files') && typeof value !== 'string')
      .map(([, value]) => value as File);
    if (!files.length) throw new HttpError(400, '请至少提供一个 file 字段');

    const id = `run_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${randomUUID().slice(0, 8)}`;
    const outputDir = join(OUTPUT_ROOT, id);
    const uploadDir = join(outputDir, 'uploads');
    await mkdir(uploadDir, { recursive: true });
    const filePaths: string[] = [];
    const fileNames: string[] = [];
    let totalBytes = 0;
    for (const [index, file] of files.entries()) {
      const safeName = safeFileName(file.name || `upload-${index + 1}`);
      validateFile(safeName, file.size);
      totalBytes += file.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new HttpError(413, `本次上传总量超过 ${MAX_TOTAL_BYTES / 1024 / 1024}MB`);
      const fileDir = join(uploadDir, String(index + 1).padStart(2, '0'));
      await mkdir(fileDir, { recursive: true });
      // Keep the basename unchanged: browsers expose the selected basename to
      // the application and source-document identity must match real uploads.
      const path = join(fileDir, safeName);
      await writeFile(path, Buffer.from(await file.arrayBuffer()));
      filePaths.push(path);
      fileNames.push(safeName);
    }

    const run: DebugRun = {
      id,
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
      target,
      respondentName,
      fileNames,
      filePaths,
      outputDir
    };
    runs.set(id, run);
    queue.push(id);
    void drainQueue();
    sendJson(response, 202, publicRun(run));
    return;
  }

  const match = url.pathname.match(/^\/debug\/runs\/([^/]+)(?:\/(result|artifacts\/final\.png))?$/);
  if (!match) {
    sendJson(response, 404, { error: '接口不存在' });
    return;
  }
  const run = await findRun(match[1]);
  if (!run) {
    sendJson(response, 404, { error: '没有找到该运行记录' });
    return;
  }

  if (method === 'DELETE' && !match[2]) {
    if (run.status === 'RUNNING') throw new HttpError(409, '任务运行中，暂不能删除');
    runs.delete(run.id);
    await rm(run.outputDir, { recursive: true, force: true });
    sendJson(response, 200, { deleted: true, runId: run.id });
    return;
  }
  if (method !== 'GET') {
    sendJson(response, 405, { error: '不支持的请求方法' });
    return;
  }
  if (match[2] === 'result') {
    if (run.status !== 'SUCCESS') {
      sendJson(response, run.status === 'ERROR' ? 422 : 202, publicRun(run));
      return;
    }
    sendJson(response, 200, run.result);
    return;
  }
  if (match[2] === 'artifacts/final.png') {
    const screenshotPath = join(run.outputDir, 'final.png');
    try {
      const image = await readFile(screenshotPath);
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length });
      response.end(image);
    } catch {
      sendJson(response, 404, { error: '截图尚未生成' });
    }
    return;
  }
  sendJson(response, 200, publicRun(run));
}

async function drainQueue(): Promise<void> {
  if (queueActive) return;
  queueActive = true;
  try {
    while (queue.length) {
      const id = queue.shift();
      const run = id ? runs.get(id) : undefined;
      if (!run) continue;
      await executeRun(run);
    }
  } finally {
    queueActive = false;
  }
}

async function executeRun(run: DebugRun): Promise<void> {
  run.status = 'RUNNING';
  run.startedAt = new Date().toISOString();
  await persistRun(run);
  let context: BrowserContext | undefined;
  let activePage: Page | undefined;
  let monitor: NodeJS.Timeout | undefined;
  const diagnostics: BrowserDiagnostic[] = [];
  try {
    const executablePath = await findChromeExecutable();
    context = await chromium.launchPersistentContext(BROWSER_PROFILE_ROOT, {
      executablePath,
      headless: process.env.LAWFLOW_DEBUG_HEADFUL === '1' ? false : true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      viewport: { width: 1440, height: 1000 }
    });
    const page = context.pages()[0] || await context.newPage();
    activePage = page;
    installDiagnostics(page, diagnostics);
    await seedAutomationUser(page, run.id);

    const targetUrl = new URL(run.target);
    targetUrl.searchParams.set('lawflowDebug', '1');
    await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await passOptionalSiteGate(page);
    await page.waitForFunction(() => Boolean((window as any).__LAWFLOW_AUTOMATION__), undefined, { timeout: 60_000 });
    await page.waitForFunction(() => (window as any).__LAWFLOW_AUTOMATION__?.app?.ready === true, undefined, { timeout: 60_000 });

    await page.waitForSelector('input[placeholder*="被执行人"]', { timeout: 30_000 });
    await page.locator('input[placeholder*="被执行人"]').fill(run.respondentName);
    const enteredUploadStep = await clickButtonContaining(page, '保存建档，进入下一步上传流水');
    if (!enteredUploadStep) throw new Error('没有找到进入上传步骤的按钮');
    const uploadInput = await page.waitForSelector('#file-upload', { timeout: 30_000, state: 'attached' });
    if (!uploadInput) throw new Error('线上页面没有出现文件上传入口');

    monitor = setInterval(() => {
      page.evaluate(() => (window as any).__LAWFLOW_AUTOMATION__?.import || null)
        .then(value => { run.progress = value; })
        .catch(() => undefined);
    }, 1000);
    monitor.unref();

    await uploadInput.setInputFiles(run.filePaths);
    await page.waitForFunction(({ expectedTasks, terminalStatuses }: { expectedTasks: number; terminalStatuses: string[] }) => {
      const state = (window as any).__LAWFLOW_AUTOMATION__?.import;
      if (!state || state.isProcessing || state.tasks.length < expectedTasks) return false;
      return state.tasks.every((task: { status: string }) => terminalStatuses.includes(task.status));
    }, { expectedTasks: run.filePaths.length, terminalStatuses: [...TERMINAL_TASK_STATUSES] }, { timeout: RUN_TIMEOUT_MS, polling: 1000 });

    await page.waitForFunction(() => {
      const app = (window as any).__LAWFLOW_AUTOMATION__?.app;
      return Boolean(app && (app.transactions.length === 0 || app.evaluationReport));
    }, undefined, { timeout: 30_000, polling: 500 }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 1500));

    const workflowScreens: Record<string, { text: string; screenshot: string }> = {};
    const uploadText = await page.evaluate(() => document.body.innerText.slice(0, 100_000));
    await page.screenshot({ path: join(run.outputDir, 'upload-result.png'), fullPage: true });
    workflowScreens.upload = { text: uploadText, screenshot: `/debug/runs/${run.id}/artifacts/upload-result.png` };

    const uploadSnapshot = await page.evaluate(() => (window as any).__LAWFLOW_AUTOMATION__ || null) as any;
    if ((uploadSnapshot?.app?.transactions?.length || 0) > 0) {
      if (!await clickButtonContaining(page, '下一步：核对原件')) throw new Error('识别完成后没有找到“下一步：核对原件”按钮');
      await page.waitForFunction(() => (window as any).__LAWFLOW_AUTOMATION__?.app?.currentStep === 2, undefined, { timeout: 30_000 });
      await new Promise(resolve => setTimeout(resolve, 1000));
      const reviewText = await page.evaluate(() => document.body.innerText.slice(0, 100_000));
      await page.screenshot({ path: join(run.outputDir, 'evidence-review.png'), fullPage: true });
      workflowScreens.review = { text: reviewText, screenshot: `/debug/runs/${run.id}/artifacts/evidence-review.png` };

      // This is an isolated automation case. Preserve every unresolved item and
      // continue without pretending that a lawyer confirmed any field.
      const continued = await clickButtonContaining(page, '保留未处理事项并继续')
        || await clickButtonContaining(page, '完成核对，进入下一步');
      if (continued) {
        await page.waitForFunction(() => (window as any).__LAWFLOW_AUTOMATION__?.app?.currentStep === 3, undefined, { timeout: 30_000 });
        if (await clickButtonContaining(page, '进入步骤四：运行核心算法计算')) {
          await page.waitForFunction(() => (window as any).__LAWFLOW_AUTOMATION__?.app?.currentStep === 4, undefined, { timeout: 30_000 });
          await page.waitForFunction(() => Boolean((window as any).__LAWFLOW_AUTOMATION__?.app?.evaluationReport), undefined, { timeout: 60_000 });
          await new Promise(resolve => setTimeout(resolve, 1000));
          const analysisText = await page.evaluate(() => document.body.innerText.slice(0, 100_000));
          await page.screenshot({ path: join(run.outputDir, 'analysis.png'), fullPage: true });
          workflowScreens.analysis = { text: analysisText, screenshot: `/debug/runs/${run.id}/artifacts/analysis.png` };
        }
      }
    }

    const snapshot = await page.evaluate(() => (window as any).__LAWFLOW_AUTOMATION__ || null) as any;
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 100_000));
    await page.screenshot({ path: join(run.outputDir, 'final.png'), fullPage: true });
    const app = snapshot?.app;
    run.result = {
      runId: run.id,
      target: run.target,
      startedAt: run.startedAt,
      completedAt: new Date().toISOString(),
      files: run.fileNames,
      summary: {
        accountCount: app?.accounts.length || 0,
        transactionCount: app?.transactions.length || 0,
        reviewIssueCount: app?.reviewIssues?.length || 0,
        unbalancedAccountCount: Object.values(app?.evaluationReport?.accountAudits || {}).filter((audit: any) => audit.isAuditable && !audit.isBalanced).length
      },
      import: snapshot?.import || null,
      caseMetadata: app?.caseMetadata || null,
      accounts: app?.accounts || [],
      transactions: app?.transactions || [],
      reviewIssues: app?.reviewIssues || [],
      balanceAudits: app?.evaluationReport?.accountAudits || {},
      evaluationReport: app?.evaluationReport || null,
      browserDiagnostics: diagnostics,
      renderedText: bodyText,
      workflowScreens,
      artifacts: {
        screenshot: `/debug/runs/${run.id}/artifacts/final.png`,
        upload: `/debug/runs/${run.id}/artifacts/upload-result.png`,
        review: workflowScreens.review?.screenshot,
        analysis: workflowScreens.analysis?.screenshot
      }
    };
    run.status = 'SUCCESS';
    run.completedAt = new Date().toISOString();
    await writeFile(join(run.outputDir, 'result.json'), `${JSON.stringify(run.result, null, 2)}\n`, 'utf8');
  } catch (error) {
    run.status = 'ERROR';
    run.error = error instanceof Error ? error.message : String(error);
    run.completedAt = new Date().toISOString();
    if (activePage) await activePage.screenshot({ path: join(run.outputDir, 'final.png'), fullPage: true }).catch(() => undefined);
    await writeFile(join(run.outputDir, 'error.json'), `${JSON.stringify({ error: run.error, diagnostics }, null, 2)}\n`, 'utf8');
  } finally {
    if (monitor) clearInterval(monitor);
    await context?.close().catch(() => undefined);
    await persistRun(run);
  }
}

function installDiagnostics(page: Page, diagnostics: BrowserDiagnostic[]): void {
  const append = (item: BrowserDiagnostic) => {
    diagnostics.push(item);
    if (diagnostics.length > 1000) diagnostics.shift();
  };
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      append({ at: new Date().toISOString(), type: `console.${message.type()}`, message: message.text().slice(0, 4000) });
    }
  });
  page.on('pageerror', error => append({
    at: new Date().toISOString(), type: 'pageerror',
    message: (error instanceof Error ? error.message : String(error)).slice(0, 4000)
  }));
  page.on('requestfailed', request => {
    const failure = request.failure();
    append({
      at: new Date().toISOString(), type: 'requestfailed',
      message: typeof failure === 'string' ? failure : failure?.errorText || 'request failed',
      url: request.url(), method: request.method()
    });
  });
  page.on('response', response => {
    if (!response.url().includes('/api/') && response.status() < 400) return;
    append({
      at: new Date().toISOString(), type: response.status() >= 400 ? 'http-error' : 'api-response',
      message: response.statusText(), url: response.url(), status: response.status(),
      requestId: response.headers()['x-lawflow-request-id']
    });
  });
}

async function seedAutomationUser(page: Page, runId: string): Promise<void> {
  await page.addInitScript((id: string) => {
    const user = {
      id: `AUTOMATION_${id}`,
      email: `${id}@automation.local`,
      name: '自动化调试',
      firmName: 'LawFlow 本地调试',
      role: 'LAWYER',
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString()
    };
    localStorage.setItem('LAWFLOW_REGISTERED_USERS_V1', JSON.stringify([{ user, passwordHash: 'automation-session-only' }]));
    localStorage.setItem('LAWFLOW_CURRENT_SESSION_USER_ID', user.id);
  }, runId);
}

async function passOptionalSiteGate(page: Page): Promise<void> {
  const password = process.env.LAWFLOW_SITE_PASSWORD;
  if (!password) return;
  const bridgeAppeared = await page.waitForFunction(() => Boolean((window as any).__LAWFLOW_AUTOMATION__), undefined, { timeout: 5000 }).then(() => true).catch(() => false);
  if (bridgeAppeared) return;
  const passwordInput = await page.$('input[type="password"]');
  if (!passwordInput) return;
  await passwordInput.fill(password);
  await page.keyboard.press('Enter');
  await new Promise(resolve => setTimeout(resolve, 1500));
}

async function clickButtonContaining(page: Page, text: string): Promise<boolean> {
  return page.evaluate((needle: string) => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.includes(needle));
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  }, text);
}

async function readMultipartForm(request: IncomingMessage): Promise<FormData> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
    else if (value !== undefined) headers.set(key, value);
  }
  const body = Readable.toWeb(request) as ReadableStream;
  const webRequest = new Request(`http://${HOST}:${PORT}${request.url || '/'}`, {
    method: request.method,
    headers,
    body,
    duplex: 'half'
  } as RequestInit & { duplex: 'half' });
  try {
    return await webRequest.formData();
  } catch (error) {
    throw new HttpError(400, `无法读取 multipart/form-data：${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateFile(name: string, size: number): void {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new HttpError(400, `不支持的文件格式：${name}`);
  if (size <= 0) throw new HttpError(400, `文件为空：${name}`);
  if (size > MAX_FILE_BYTES) throw new HttpError(413, `${name} 超过单文件 ${MAX_FILE_BYTES / 1024 / 1024}MB 限制`);
}

function validateTarget(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'target 不是有效网址');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'target 仅支持 http/https');
  const configured = (process.env.LAWFLOW_DEBUG_ALLOWED_HOSTS || '').split(',').map(item => item.trim()).filter(Boolean);
  const defaultHost = new URL(DEFAULT_TARGET).hostname;
  const allowed = new Set([defaultHost, 'localhost', '127.0.0.1', ...configured]);
  if (!allowed.has(url.hostname)) throw new HttpError(400, `不允许访问目标主机：${url.hostname}`);
  return url.href;
}

async function findChromeExecutable(): Promise<string> {
  const candidates = [
    process.env.LAWFLOW_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next known installation path.
    }
  }
  throw new Error('未找到 Chrome；请通过 LAWFLOW_CHROME_PATH 指定浏览器可执行文件');
}

async function findRun(id: string): Promise<DebugRun | undefined> {
  const inMemory = runs.get(id);
  if (inMemory) return inMemory;
  try {
    const stored = JSON.parse(await readFile(join(OUTPUT_ROOT, id, 'run.json'), 'utf8')) as DebugRun;
    try { stored.result = JSON.parse(await readFile(join(OUTPUT_ROOT, id, 'result.json'), 'utf8')); } catch { /* not complete */ }
    runs.set(id, stored);
    return stored;
  } catch {
    return undefined;
  }
}

async function persistRun(run: DebugRun): Promise<void> {
  await mkdir(run.outputDir, { recursive: true });
  const stored = { ...run, result: undefined };
  await writeFile(join(run.outputDir, 'run.json'), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
}

async function cleanupExpiredRuns(): Promise<void> {
  const entries = await import('node:fs/promises').then(module => module.readdir(OUTPUT_ROOT, { withFileTypes: true })).catch(() => []);
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(OUTPUT_ROOT, entry.name);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > RETENTION_MS) {
      runs.delete(entry.name);
      await rm(path, { recursive: true, force: true });
    }
  }
}

function publicRun(run: DebugRun): object {
  return {
    runId: run.id,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    target: run.target,
    files: run.fileNames,
    progress: run.progress,
    error: run.error,
    resultUrl: run.status === 'SUCCESS' ? `/debug/runs/${run.id}/result` : undefined
  };
}

function textField(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function safeFileName(value: string): string {
  return basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 180) || 'upload';
}

function isAuthorized(request: IncomingMessage): boolean {
  const token = process.env.LAWFLOW_DEBUG_TOKEN;
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));
void main();
