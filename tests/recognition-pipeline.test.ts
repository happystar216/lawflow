import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessPageCompleteness,
  buildLogicalDocumentSegments,
  classifyRecognitionFailure,
  PageEvidence,
  planExtractionBatches
} from '../src/parsers/recognitionPipeline';

const page = (
  number: number,
  account: string,
  density: PageEvidence['density'] = 'HIGH',
  pageType: PageEvidence['pageType'] = 'TRANSACTIONS'
): PageEvidence => ({
  page: number,
  pageType,
  rotation: 0,
  bankName: account ? '中国工商银行' : '',
  accountName: '胡艳红',
  accountNumbers: account ? [account] : [],
  density,
  confidence: account ? 0.95 : 0.2
});

test('four-stage planner keeps logical account boundaries and chooses physical batches by estimated output', () => {
  const map = new Map<number, PageEvidence>();
  for (let number = 1; number <= 6; number += 1) map.set(number, page(number, '4088'));
  map.set(7, page(7, '1192', 'LOW'));
  map.set(8, page(8, '1192', 'LOW'));

  const segments = buildLogicalDocumentSegments(map);
  assert.deepEqual(segments.map(segment => segment.pages), [[1, 2, 3, 4, 5, 6], [7, 8]]);

  const batches = planExtractionBatches(segments, map, new Set(map.keys()), 180);
  assert.deepEqual(batches.map(batch => batch.pages), [[1, 2, 3, 4], [5, 6], [7, 8]]);
  assert.equal(batches[0].segmentId, batches[1].segmentId);
  assert.notEqual(batches[1].segmentId, batches[2].segmentId);
});

test('planner skips fully cached batches without changing the logical segment', () => {
  const map = new Map<number, PageEvidence>([
    [1, page(1, '4088', 'LOW')],
    [2, page(2, '4088', 'LOW')],
    [3, page(3, '4088', 'LOW')]
  ]);
  const segments = buildLogicalDocumentSegments(map);
  assert.equal(planExtractionBatches(segments, map, new Set()).length, 0);
  assert.deepEqual(planExtractionBatches(segments, map, new Set([3]))[0].pages, [1, 2, 3]);
});

test('completeness layer retries missing rows but leaves uncertain fields for focused review', () => {
  const missing = assessPageCompleteness({
    pageStart: 12,
    transactions: [{}],
    expectedTransactionCount: 2,
    pageQuality: [{ expectedCount: 2, extractedCount: 1, status: 'NEEDS_REVIEW', pageType: 'TRANSACTIONS' }]
  }, page(12, '4088'));
  assert.equal(missing.requiresRecovery, true);
  assert.equal(missing.blocksAnalysis, true);

  const uncertain = assessPageCompleteness({
    pageStart: 13,
    transactions: [{ extractionConfidence: 0.65 }],
    expectedTransactionCount: 1,
    pageQuality: [{ expectedCount: 1, extractedCount: 1, status: 'NEEDS_REVIEW', pageType: 'TRANSACTIONS' }]
  }, page(13, '4088'));
  assert.deepEqual(uncertain.issues, ['UNCERTAIN_FIELDS']);
  assert.equal(uncertain.requiresRecovery, false);
  assert.equal(uncertain.blocksAnalysis, false);
});

test('full-page extraction classification overrides a thumbnail transaction guess', () => {
  const assessment = assessPageCompleteness({
    pageStart: 17,
    transactions: [],
    expectedTransactionCount: 0,
    pageQuality: [{ expectedCount: 0, extractedCount: 0, status: 'COMPLETE', pageType: 'ACCOUNT_INFO' }]
  }, page(17, '4088', 'HIGH', 'TRANSACTIONS'));

  assert.deepEqual(assessment.issues, []);
  assert.equal(assessment.requiresRecovery, false);
  assert.equal(assessment.blocksAnalysis, false);
});

test('failure classifier distinguishes capacity errors from transient service errors', () => {
  assert.equal(classifyRecognitionFailure(new Error('单次识别输出达到长度上限')), 'CAPACITY');
  assert.equal(classifyRecognitionFailure(new Error('页面解析长时间没有取得新结果')), 'TIMEOUT');
  assert.equal(classifyRecognitionFailure(new Error('解析服务暂时不可用（503）')), 'TRANSIENT');
  assert.equal(classifyRecognitionFailure(new Error('结构化数据不完整')), 'INVALID_OUTPUT');
});
