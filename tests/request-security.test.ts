import test from 'node:test';
import assert from 'node:assert/strict';
import { guardParseRequest, validateUploadedFile } from '../functions/lib/requestSecurity';

test('parse request guard rejects a cross-origin browser request', async () => {
  const response = guardParseRequest({
    request: new Request('https://lawflow.example/api/parse-bank-statement', {
      method: 'POST', headers: { Origin: 'https://attacker.example' }
    }),
    env: {}
  });
  assert.equal(response?.status, 403);
});

test('parse upload validation rejects unsupported content', () => {
  const response = validateUploadedFile(new File(['x'], 'payload.txt', { type: 'text/plain' }));
  assert.equal(response?.status, 415);
});
