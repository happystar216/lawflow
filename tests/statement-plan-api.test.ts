import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/plan-statements';

const context = (configured = true) => ({
  request: new Request('https://test.invalid/api/plan-statements', { method: 'POST',
    body: JSON.stringify({ pages: [{ page: 1, blocks: [] }], targetPages: [1] }) }),
  env: configured ? { GEMINI_API_KEY: 'synthetic-test-key' } : {}
});

test('planning API distinguishes output limit from service outage without exposing upstream response', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }));
    const truncated = await onRequestPost(context());
    assert.equal(truncated.status, 502);
    assert.equal((await truncated.json() as any).code, 'OUTPUT_LIMIT');
    globalThis.fetch = async () => new Response('private provider diagnostic', { status: 429 });
    const unavailable = await onRequestPost(context());
    assert.equal(unavailable.status, 503);
    const text = await unavailable.text();
    assert.match(text, /UPSTREAM_ERROR/);
    assert.doesNotMatch(text, /private provider|synthetic-test-key/);
  } finally { globalThis.fetch = original; }
});

test('unconfigured planning is an availability failure, not malformed source content', async () => {
  const response = await onRequestPost(context(false));
  assert.equal(response.status, 503);
  assert.equal((await response.json() as any).code, 'SERVICE_UNAVAILABLE');
});
