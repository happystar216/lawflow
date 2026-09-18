import test from 'node:test';
import assert from 'node:assert/strict';
import { importErrorForUser } from '../src/utils/userFacingError';

test('upload errors hide service internals and explain impact', () => {
  const result = importErrorForUser(
    new Error('Gemini 响应异常（503）：upstream unavailable'),
    '银行流水.pdf'
  );
  assert.equal(result.title, '未能导入“银行流水.pdf”');
  assert.equal(result.retryable, true);
  assert.match(result.message, /暂时不可用/);
  assert.doesNotMatch(result.message, /503|upstream/);
  assert.doesNotMatch(result.details, /Gemini|Qwen|OpenAI|Anthropic|Claude/i);
  assert.match(result.impact, /原有数据未受影响/);
});

test('oversized upload errors provide a concrete recovery action', () => {
  const result = importErrorForUser(new Error('上传文件超过 75MB 限制'), '大文件.pdf');
  assert.equal(result.retryable, false);
  assert.match(result.message, /压缩|拆分/);
});
