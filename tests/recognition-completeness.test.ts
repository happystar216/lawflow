import test from 'node:test';
import assert from 'node:assert/strict';
import { BankAccount } from '../src/types/transaction';
import {
  blockingRecognitionIssues,
  businessAccounts,
  incompleteRecognitionPages
} from '../src/review/recognitionCompleteness';

function account(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    accountNumber: '6222000000000001', accountName: '胡艳红', bankName: '测试银行', ownerType: 'DEBTOR_MAIN',
    fileName: '流水.pdf', fileType: 'pdf', totalIn: 0, totalOut: 0, transactionCount: 0,
    startDate: '', endDate: '', startBalance: 0, endBalance: 0, isBalanced: false, balanceDiff: 0,
    ...overrides
  };
}

test('hard page failures block analysis and expose exact pages', () => {
  const reviewAccount = account({
    accountNumber: '待归属页面-流水.pdf', accountName: '待归属页面', bankName: '待核对', ownerType: 'UNKNOWN',
    parseStatus: 'INCOMPLETE',
    parseWarnings: [
      '第 57 页连续识别失败：解析服务暂时不可用（503）；自动重试后仍未恢复',
      '第 123 页连续识别失败：未能完整获取结构化结果'
    ]
  });
  assert.deepEqual(incompleteRecognitionPages([reviewAccount]), [57, 123]);
  assert.equal(blockingRecognitionIssues([reviewAccount], []).length, 2);
  assert.equal(businessAccounts([account(), reviewAccount]).length, 1);
});

test('ordinary advisory warnings do not block analysis', () => {
  const ordinary = account({ parseStatus: 'NEEDS_REVIEW', parseWarnings: ['第 3 页包含跨期离散账单'] });
  assert.equal(blockingRecognitionIssues([ordinary], []).length, 0);
});
