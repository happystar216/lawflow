import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// No application login, original case data, or external recognition requests.
console.log('Starting isolated review fixture');
const server = await createServer({ configFile: false, plugins: [react(), { name: 'isolated-review-fixture',
  configureServer(server) {
    server.middlewares.use('/__review_test__', async (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(await server.transformIndexHtml('/__review_test__',
        '<!doctype html><div id="root"></div><script type="module" src="/scripts/fixtures/reviewHarness.tsx"></script>'));
    });
  }
}],
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react', 'pdfjs-dist'] },
  server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await server.listen();
console.log('Review fixture server ready');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, timeout: 20_000,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(new URL('/__review_test__', server.resolvedUrls!.local[0]).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  console.log('Review fixture page loaded');
  await page.getByText('待核对页面（2 页）', { exact: true }).waitFor();
  await page.getByText('仅账户资料，未提供流水', { exact: true }).waitFor();
  await page.getByRole('button', { name: /A.pdf · 第3页/ }).click();
  await page.getByText(/任务 1 · 尾号 0001/).waitFor();
  // A balance-only disagreement must not ask the user to re-enter every field.
  assert.equal(await page.locator('input[type="number"]').count(), 1);
  await page.locator('input[type="number"]').fill('51');
  await page.getByRole('button', { name: /我已按原件手工填写，确认本行/ }).click();
  await page.getByText(/任务 2 · 尾号 0002/).waitFor();
  assert.equal(await page.locator('input[type="number"]').inputValue(), '0');
  await page.getByRole('button', { name: '当前字段与原件一致，确认本行', exact: true }).click();
  await page.getByRole('button', { name: '已完成修改并复查，保存本页', exact: true }).click();
  const snapshot = await page.evaluate(() => (window as any).__REVIEW_TEST__);
  assert.equal(snapshot.transactions[0].balance, 51);
  assert.equal(snapshot.transactions[1].amount, 0);
  assert.deepEqual(snapshot.transactions[1].dataQualityIssues, []);
  assert.equal(snapshot.transactions[0].candidateReview.status, 'CONFIRMED');
  assert.equal(snapshot.transactions[1].candidateReview.status, 'CONFIRMED');
  assert.equal(snapshot.transactions[2].candidateReview.status, 'PENDING');
  assert.equal(snapshot.accounts[2].reviewIssues, undefined, 'other document must not be confirmed');
  for (const [index, owner] of snapshot.accounts.slice(0, 2).entries()) {
    assert.ok(owner.reviewIssues.length);
    assert.ok(owner.reviewIssues.every((issue: any) => issue.status === 'CORRECTED'
      && issue.transactionIds.every((id: string) => id === `row-${index}`)), 'save issues on their own account');
  }
  // A partly unreadable page must preserve rows already checked explicitly.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /A.pdf · 第3页/ }).click();
  await page.getByRole('button', { name: '当前字段与原件一致，确认本行', exact: true }).click();
  await page.getByText(/任务 2 · 尾号 0002/).waitFor();
  await page.getByRole('button', { name: '原件看不清，暂时无法确认', exact: true }).click();
  await page.getByRole('button', { name: '原件不清晰／无法确认', exact: true }).click();
  const partial = await page.evaluate(() => (window as any).__REVIEW_TEST__);
  assert.equal(partial.transactions[0].candidateReview.status, 'CONFIRMED');
  assert.equal(partial.transactions[1].candidateReview.status, 'UNRESOLVED');
  assert.ok(partial.accounts[0].reviewIssues.every((issue: any) => issue.status === 'CONFIRMED'));
  assert.ok(partial.accounts[1].reviewIssues.every((issue: any) => issue.status === 'UNRESOLVED'));
  await page.goto(new URL('/__review_test__?removal=1', server.resolvedUrls!.local[0]).href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /A.pdf · 第3页/ }).click();
  await page.getByRole('checkbox').first().check();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除选中的 1 笔多余记录', exact: true }).click();
  const removed = await page.evaluate(() => (window as any).__REVIEW_TEST__);
  assert.equal(removed.transactions.length, 1);
  assert.equal(removed.transactions[0].reviewedBy, undefined);
  assert.ok(removed.accounts[0].reviewIssues.every((issue: any) => issue.status === 'PENDING'));
  assert.equal(await page.getByRole('button', { name: '已完成修改并复查，保存本页', exact: true }).isEnabled(), false);
  assert.deepEqual(errors, []);
  console.log('Review UI checks passed: page grouping, targeted fields, cross-account save, zero amount, source isolation, honest badges.');
} finally {
  await browser?.close();
  await server.close();
}
