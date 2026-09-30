import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../functions/api/recognize-quality';
import { qualityModelConfig, decodeQualityRequest } from '../functions/lib/qualityModel';
import { qualityPrompts } from '../functions/lib/qualityPrompts.generated';
import { requestQualityModel } from '../src/parsers/qualityPdfParser';
import { QUALITY_ENDPOINT, QUALITY_POLICY_HEADER, type QualityRequest } from '../src/recognition/qualityProtocol';
import { runQualityWorkflow, type QualityWorkflowIO } from '../src/recognition/qualityWorkflow';
import { createQualityRecognitionRecord, freezeQualityRecognitionRecord } from '../src/recognition/qualityRunRecord';
import { qualityToWeb } from '../src/recognition/qualityWebAdapter';
import { normalizeRecognizedData } from '../src/utils/recognizedDataNormalizer';
import { attachSourceProvenance } from '../src/utils/evidenceProvenance';
import { buildQualitySources } from '../src/recognition/qualitySources';
import type { QualityDeliveryInput } from '../src/review/qualityDelivery';
import type { TableMappingPlan } from '../src/recognition/tableMapping';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const env = { GEMINI_API_KEY: 'test-only', DASHSCOPE_API_KEY: 'test-only' };
const page = { nearTableText: ['测试银行', '001234567890'], tables: [{ rows: [
  ['2026-07-10', '支出', '10.00', '100.00', '账户转账', '测试对方', '009876543210']
] }] };
const mapping: TableMappingPlan = { tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit',
  groups: [[1]], ignored: [], directionCodes: null, fields: { bankName: { fixed: 1 }, accountNumber: { fixed: 2 },
    transactionDate: { row: 0, col: 1 }, direction: { row: 0, col: 2 }, amount: { row: 0, col: 3 }, balance: { row: 0, col: 4 },
    description: { row: 0, col: 5 }, counterpartyName: { row: 0, col: 6 }, counterpartyAccount: { row: 0, col: 7 } }
}], typeRules: [{ accountKind: 'deposit', text: '账户转账', type: '账户转账' }] };
function responseFor(stage: QualityRequest['stage'], blank = false): any {
  if (stage === 'preflight') return { pageKind: blank ? 'blank' : 'content', uprightCandidate: blank ? 'uncertain' : 'B', reason: 'fixture' };
  if (stage === 'primary') return page;
  if (stage === 'context') return { nearTableText: [], tables: [] };
  if (stage === 'mapping') return mapping;
  if (stage === 'independent') return { pageType: 'transactions', coverage: 'complete', pageIssues: [], bankName: '测试银行', rows: [
    { row: 1, values: ['001234567890', '2026-07-10', '', 'OUT', '10.00', '100.00', '测试对方', '009876543210'], rawDirection: '支出', issues: [] }
  ] };
  throw new Error(`Unexpected stage ${stage}`);
}
const source = { documentId: 'DOC_fixture', contentHash: 'fixture', fileName: 'fixture.pdf', mimeType: 'application/pdf', size: 1, lastModified: 0 };
function webRecord(result: QualityDeliveryInput, registry = buildQualitySources([page]).registry) {
  const web = qualityToWeb(result, registry, source.fileName, 2, mapping);
  const annotated = attachSourceProvenance(web.accounts, web.transactions, source, { id: 'run', documentId: source.documentId, startedAt: 'fixture' });
  const normalized = normalizeRecognizedData(annotated.accounts, annotated.transactions);
  return createQualityRecognitionRecord(source.documentId, source.fileName, { result, registry }, normalized.accounts, normalized.transactions);
}

test('same replies through the real HTTP route, SSE client and workflow yield identical web rows and review evidence', async t => {
  const config = await qualityModelConfig(env), requests: QualityRequest[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url === QUALITY_ENDPOINT) {
      assert.equal(new Headers(init.headers).get(QUALITY_POLICY_HEADER), config.policySHA256);
      const input = decodeQualityRequest(String(init.body), new Headers(init.headers).get('Content-Type')!);
      requests.push(input);
      return onRequestPost({ env, request: new Request(`https://test.local${QUALITY_ENDPOINT}`, init) });
    }
    const body = JSON.parse(String(init.body));
    const qwen = url.includes('dashscope');
    const prompt = qwen ? body.messages[0].content[0].text : body.contents[0].parts[0].text;
    const stage = Object.entries(qualityPrompts).find(([, p]) => p.prompt === prompt)?.[0] as QualityRequest['stage'];
    if (!qwen) {
      const image = body.contents[0].parts.find((p: any) => p.inlineData);
      if (stage === 'independent') assert.equal(image.mediaResolution.level, 'MEDIA_RESOLUTION_ULTRA_HIGH');
      if (stage === 'preflight') assert.equal(image.mediaResolution, undefined);
    }
    const blank = !qwen && body.contents[0].parts.find((p: any) => p.inlineData)?.inlineData.data === 'Yg==';
    const result = responseFor(stage, blank);
    return qwen ? Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] })
      : new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(result) }] }, finishReason: 'STOP' }] })}\n\n`);
  });
  const io: Omit<QualityWorkflowIO, 'call'> = { totalPages: 2, signal: new AbortController().signal, progress() {},
    image: async (_page, rotation) => { assert.equal(rotation, 90); return 'YQ=='; },
    preflightImages: async p => ({ images: Array(4).fill(p === 2 ? 'Yg==' : 'YQ=='),
      metrics: { darkFraction160: p === 2 ? 0 : .1, darkFraction210: p === 2 ? 0 : .1, hasPdfText: false } }) };
  const http = await runQualityWorkflow({ ...io, call: input => requestQualityModel(input, io.signal, config.policySHA256) });
  const fixture = await runQualityWorkflow({ ...io, call: async (input, p) => ({
    result: structuredClone(responseFor(input.stage, p === 2)), model: 'fixture', finishReason: 'STOP', promptSHA256: 'fixture'
  }) });
  assert.deepEqual(http, fixture);
  assert.deepEqual(freezeQualityRecognitionRecord(webRecord(http.result, http.registry)), fixture.result);
  assert.equal(http.result.rows.length, 1);
  assert.equal(requests.length, 6); // two preflights, three readings, one full mapping
  assert.equal(requests.filter(r => r.stage === 'mapping').length, 1);
});

test('changed model configuration is rejected before any provider request', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not call a model'); });
  const config = await qualityModelConfig(env);
  const next = { ...env, GEMINI_MODEL: 'another-model' };
  assert.notEqual((await qualityModelConfig({ ...env, QWEN_RECOVERY_MODEL: 'another-recovery-model' })).policySHA256, config.policySHA256);
  assert.notEqual((await qualityModelConfig(next)).policySHA256, config.policySHA256);
  const response = await onRequestPost({ env: next, request: new Request(`https://test.local${QUALITY_ENDPOINT}`, {
    method: 'POST', headers: { [QUALITY_POLICY_HEADER]: config.policySHA256 }, body: '{}'
  }) });
  assert.equal(response.status, 409);
  const published = await onRequestGet({ env, request: new Request(`https://test.local${QUALITY_ENDPOINT}`) });
  assert.equal((await published.json()).policySHA256, config.policySHA256);
});

test('freezing web exports retains ROW alerts, empty money and leading zeroes; refuses edited or missing rows', () => {
  const result: QualityDeliveryInput = { complete: false, rows: [{ id: 'E1', sourceObservationIds: ['source:1'],
    values: ['001234567890', '', '测试银行', '', '2026-07-10', '', '', '', '', '测试对方', '009876543210', ''] }], pending: [
    { id: 'ROW1', code: 'INDEPENDENT_UNMATCHED', field: null, outputRows: [1], sourceRows: [1], sourceCells: [], severity: 'REQUIRED', message: '交易行无法对应' },
    { id: 'FIELD1', code: 'TYPE_UNKNOWN', field: 'transactionType', outputRows: [1], sourceRows: [1], sourceCells: [], severity: 'REQUIRED', message: '用途不明' }
  ] };
  const record = webRecord(result);
  assert.deepEqual(freezeQualityRecognitionRecord(record), result);
  const changed = structuredClone(record); changed.transactions[0].counterpartyAccount = '9876543210';
  assert.throws(() => freezeQualityRecognitionRecord(changed), /第 1 笔/);
  const removed = structuredClone(record); removed.transactions = [];
  assert.throws(() => freezeQualityRecognitionRecord(removed), /行数不一致/);
  const wrongSource = structuredClone(record); wrongSource.transactions[0].qualitySourceObservationIds = ['source:2'];
  assert.throws(() => freezeQualityRecognitionRecord(wrongSource), /第 1 笔/);
  const lostAlert = structuredClone(record); lostAlert.transactions[0].candidateReview = undefined;
  assert.throws(() => freezeQualityRecognitionRecord(lostAlert), /待确认提示/);
});

test('regression CLI only submits the PDF to the web driver and freezes its returned rows', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lawflow-entry-test-'));
  const pdf = Buffer.from('%PDF-1.4 synthetic client fixture');
  await writeFile(join(dir, 'fixture.pdf'), pdf);
  const result: QualityDeliveryInput = { complete: true, rows: [], pending: [] };
  const record = webRecord(result);
  record.evidence.run = { schemaVersion: 1, runId: 'fixture', endpoint: `https://test.local${QUALITY_ENDPOINT}`,
    clientEntry: 'fixture', revision: 'fixture', sourceSHA256: createHash('sha256').update(pdf).digest('hex'),
    totalPages: 1, startedAt: 'fixture', completedAt: 'fixture', runKind: 'FRESH', policySHA256: 'fixture',
    models: {}, prompts: {}, settings: {}, renderer: {}, calls: [] };
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') res.end('{}');
    else if (req.url === '/debug/runs' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      assert.ok(body.includes(pdf.toString()));
      assert.match(body, /name="mode"\r\n\r\nrecognition/);
      assert.ok(!body.includes('apiTarget'));
      res.end(JSON.stringify({ runId: 'fixture', status: 'SUCCESS' }));
    } else if (req.url === '/debug/runs/fixture/result') {
      res.end(JSON.stringify({ runKind: 'PRODUCTION_WEB_FRESH', qualityRecords: [record], transactions: [], accounts: record.accounts }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/runRecognitionRegression.ts',
    '--pdf', join(dir, 'fixture.pdf'), '--output', join(dir, 'run'), '--server', `http://127.0.0.1:${address.port}`]);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'run/01/result.json'), 'utf8')), result);
  assert.deepEqual(paths, ['/health', '/debug/runs', '/debug/runs/fixture/result']);
});
