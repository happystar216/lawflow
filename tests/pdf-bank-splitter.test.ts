import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBankGroups,
  formatPageSelection,
  parsePageSelection,
  validateBankGroups
} from '../src/parsers/pdfBankSplitter';
import { PageMapItem } from '../src/parsers/qwenPdfParser';

test('bank splitter groups pages by bank and carries document pages to their neighbour', () => {
  const pageMap = new Map<number, PageMapItem>([
    [1, page(1, '', 'DOCUMENT', 0.2)],
    [2, page(2, '中国工商银行')],
    [3, page(3, '中国工商银行')],
    [4, page(4, '', 'BLANK', 0.99)],
    [5, page(5, '中国农业银行')],
    [6, page(6, '中国农业银行')]
  ]);

  const groups = buildBankGroups(pageMap, 6);
  assert.deepEqual(groups.map(group => [group.bankName, group.pages]), [
    ['中国工商银行', [1, 2, 3, 4]],
    ['中国农业银行', [5, 6]]
  ]);
});

test('bank splitter leaves an ambiguous transaction page for explicit confirmation', () => {
  const groups = buildBankGroups(new Map<number, PageMapItem>([
    [1, page(1, '中国工商银行')],
    [2, page(2, '', 'TRANSACTIONS', 0.1)],
    [3, page(3, '中国农业银行')]
  ]), 3);

  assert.equal(groups[1].bankName, '待确认银行');
  assert.deepEqual(groups[1].pages, [2]);
  assert.match(validateBankGroups(groups, 3).join('\n'), /尚未确认银行名称/);
});

test('page selection parser validates full, non-overlapping document coverage', () => {
  assert.deepEqual(parsePageSelection('1-3，5,4', 5), [1, 2, 3, 4, 5]);
  assert.equal(formatPageSelection([1, 2, 3, 5, 7, 8]), '1-3,5,7-8');

  const groups = [
    { id: '1', bankName: '工商银行', suggestedBankName: '工商银行', pages: [1, 2], pageSelection: '1-3', confidence: 1, pageTypes: ['TRANSACTIONS'] as PageMapItem['pageType'][] },
    { id: '2', bankName: '农业银行', suggestedBankName: '农业银行', pages: [3, 4], pageSelection: '3-4', confidence: 1, pageTypes: ['TRANSACTIONS'] as PageMapItem['pageType'][] }
  ];
  const errors = validateBankGroups(groups, 5);
  assert.ok(errors.some(error => error.includes('尚未分配第 5 页')));
  assert.ok(errors.some(error => error.includes('第 3 页被重复分配')));
});

function page(
  number: number,
  bankName: string,
  pageType: PageMapItem['pageType'] = 'TRANSACTIONS',
  confidence = 0.95
): PageMapItem {
  return {
    page: number,
    pageType,
    rotation: 0,
    bankName,
    accountName: '胡艳红',
    accountNumbers: [],
    density: pageType === 'TRANSACTIONS' ? 'HIGH' : 'LOW',
    confidence
  };
}
