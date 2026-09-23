import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Isolated browser profile, synthetic evidence, no model API calls.
const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
server.middlewares.use('/__storage_test__', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Isolated storage test</title>');
});
await server.listen();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true,
    timeout: 20_000, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  console.log('Testing storage in isolated browser');
  await page.goto(new URL('/__storage_test__', server.resolvedUrls!.local[0]).href);
  console.log('Storage page loaded');
  await page.evaluate(async () => {
    const path = '/src/store/recognitionCheckpointStore.ts';
    const { createRecognitionCheckpointStore: create } = await import(/* @vite-ignore */ path);
    localStorage.setItem('LAWFLOW_REGISTERED_USERS_V1', JSON.stringify([
      { user: { id: 'test-u1', email: 'u1@example.invalid' } }, { user: { id: 'test-u2', email: 'u2@example.invalid' } }
    ]));
    localStorage.setItem('LAWFLOW_CURRENT_SESSION_USER_ID', 'test-u1');
    const a = create('case-a', 'doc-hash', 'synthetic.pdf', 'synthetic');
    await a.saveDocument({ pages: [{ page: 1, text: 'synthetic only' }], blocks: [] });
    await a.savePage({ version: 1, page: 1, source: { page: 1, blocks: [] }, candidates: [],
      selected: { transactions: [], pageQuality: [{ expectedCount: Number.NaN }] } }, 'input-hash');
    await a.savePlanningBatch(1, 'plan-input', [{ page: 1, type: 'DOCUMENT', bank: null,
      accounts: [], headers: [], relation: 'START', continuation: [], confidence: 0.99, issues: [] }]);
    await create('case-b', 'doc-hash', 'synthetic.pdf', 'synthetic').saveDocument({ pages: [], blocks: [] });
  });
  console.log('Checkpoints written; reloading');
  await page.reload();
  const result = await page.evaluate(async () => {
    const path = '/src/store/recognitionCheckpointStore.ts';
    const { createRecognitionCheckpointStore: create, clearRecognitionCheckpoints: clear } = await import(/* @vite-ignore */ path);
    const a = create('case-a', 'doc-hash', 'synthetic.pdf', 'synthetic');
    const restored = (await a.loadDocument())?.pages[0].text === 'synthetic only';
    const savedPage = await a.loadPage(1, 'input-hash');
    const keepsNaN = Number.isNaN(savedPage?.selected.pageQuality[0].expectedCount);
    const planningRestored = (await a.loadPlanningBatch(1, 'plan-input'))?.[0].type === 'DOCUMENT'
      && !(await a.loadPlanningBatch(1, 'different-plan-input'));
    const changedInputMiss = !(await a.loadPage(1, 'changed-input'));
    const differentFileMiss = !(await create('case-a', 'other-hash', 'synthetic.pdf', 'synthetic').loadDocument());
    const differentRespondentMiss = !(await create('case-a', 'doc-hash', 'synthetic.pdf', 'different').loadDocument());
    localStorage.setItem('LAWFLOW_CURRENT_SESSION_USER_ID', 'test-u2');
    const userTwo = create('case-a', 'doc-hash', 'synthetic.pdf', 'synthetic');
    const differentUserMiss = !(await userTwo.loadDocument());
    await userTwo.saveDocument({ pages: [{ page: 1, text: 'other-user' }], blocks: [] });
    localStorage.setItem('LAWFLOW_CURRENT_SESSION_USER_ID', 'test-u1');
    await clear('case-a', 'synthetic.pdf', 'doc-hash');
    const deleted = !(await a.loadDocument()) && !(await a.loadPage(1, 'input-hash'))
      && !(await a.loadPlanningBatch(1, 'plan-input'));
    const otherCaseKept = Boolean(await create('case-b', 'doc-hash', 'synthetic.pdf', 'synthetic').loadDocument());
    const otherUserKept = (await userTwo.loadDocument())?.pages[0].text === 'other-user';
    await clear('case-b');
    return { restored, keepsNaN, planningRestored, changedInputMiss, differentFileMiss, differentRespondentMiss, differentUserMiss,
      deleted, otherCaseKept, otherUserKept };
  });
  for (const [name, passed] of Object.entries(result)) assert.equal(passed, true, name);
  console.log('Browser IndexedDB checks passed:', Object.keys(result).join(', '));
} finally {
  await browser?.close();
  await server.close();
}
