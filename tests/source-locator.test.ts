import assert from 'node:assert/strict';
import test from 'node:test';
import { estimatedSourceRegion, rotateSourceRegion, sourceRegionFromBox } from '../src/utils/sourceLocator';
import { StandardTransaction } from '../src/types/transaction';

function transaction(id: string, row: number): StandardTransaction {
  return {
    id,
    accountNumber: '6216', accountName: '胡艳红', bankName: '测试银行',
    transactionTime: '2025-01-01', transactionDate: '2025-01-01', direction: 'IN',
    amount: 1, balance: 1, counterpartyName: '', summary: '', rawSourceFile: 'test.pdf',
    rawPageNumber: 3, rawRowIndex: row
  };
}

test('normalizes a model row box and rejects invalid geometry', () => {
  const region = sourceRegionFromBox([100, 50, 140, 950])!;
  assert.equal(region.origin, 'MODEL');
  assert.equal(region.x, 0.05);
  assert.equal(region.y, 0.1);
  assert.ok(Math.abs(region.width - 0.9) < 0.0001);
  assert.ok(Math.abs(region.height - 0.04) < 0.0001);
  assert.equal(sourceRegionFromBox([100, 100, 100, 900]), undefined);
});

test('legacy row locator is explicitly approximate and follows row order', () => {
  const rows = [transaction('a', 1), transaction('b', 2), transaction('c', 3)];
  const first = estimatedSourceRegion(rows[0], rows)!;
  const third = estimatedSourceRegion(rows[2], rows)!;
  assert.equal(first.origin, 'ESTIMATED');
  assert.ok(third.y > first.y);
});

test('rotates normalized row geometry with the PDF page', () => {
  const region = sourceRegionFromBox([100, 50, 140, 950])!;
  const rotated = rotateSourceRegion(region, 90);
  assert.ok(Math.abs(rotated.x - 0.86) < 0.0001);
  assert.equal(rotated.y, 0.05);
  assert.ok(Math.abs(rotated.width - 0.04) < 0.0001);
  assert.ok(Math.abs(rotated.height - 0.9) < 0.0001);
});
