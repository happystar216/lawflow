import test from 'node:test';
import assert from 'node:assert/strict';
import { StandardTransaction } from '../src/types/transaction';
import { applyRowReviewDecision } from '../src/review/fieldReview';

function suggestedTransaction(): StandardTransaction {
  return {
    id: 'tx-1', accountNumber: 'A', accountName: '张三', bankName: '测试银行',
    transactionTime: '2025-02-25', transactionDate: '2025-02-25', direction: 'OUT',
    amount: 5453.26, balance: 3.47, counterpartyName: '', summary: '司法划扣', rawSourceFile: '流水.pdf',
    reviewStatus: 'CORRECTED', originalAmount: 197.97,
    fieldEvidence: {
      amount: {
        originalValue: 197.97, currentValue: 5453.26, confidence: 0.7,
        origin: 'AUTO_NORMALIZATION', decision: 'SUGGESTED', reason: '根据相邻余额关系提出修正'
      }
    }
  };
}

test('row review can explicitly accept the system suggestion', () => {
  const reviewed = applyRowReviewDecision(suggestedTransaction(), ['amount'], 'ACCEPT_CURRENT', '2026-09-20T10:00:00.000Z');
  assert.equal(reviewed.amount, 5453.26);
  assert.equal(reviewed.reviewStatus, 'CORRECTED');
  assert.equal(reviewed.fieldEvidence?.amount?.decision, 'CONFIRMED');
  assert.equal(reviewed.fieldEvidence?.amount?.reviewedBy, '律师人工核对');
});

test('row review can restore the original extracted value', () => {
  const reviewed = applyRowReviewDecision(suggestedTransaction(), ['amount'], 'USE_ORIGINAL', '2026-09-20T10:00:00.000Z');
  assert.equal(reviewed.amount, 197.97);
  assert.equal(reviewed.fieldEvidence?.amount?.currentValue, 197.97);
  assert.equal(reviewed.fieldEvidence?.amount?.decision, 'CONFIRMED');
});

test('unreadable source remains unresolved instead of being silently approved', () => {
  const reviewed = applyRowReviewDecision(suggestedTransaction(), ['amount'], 'UNRESOLVED', '2026-09-20T10:00:00.000Z');
  assert.equal(reviewed.reviewStatus, 'PENDING');
  assert.equal(reviewed.fieldEvidence?.amount?.decision, 'UNRESOLVED');
  assert.match(reviewed.lawyerNote || '', /暂未确认/);
});
