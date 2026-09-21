import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBankGroups,
  createBankSplitFiles,
  formatPageSelection,
  isPageRecommendedForRecognition,
  parsePageSelection,
  validateBankGroups
} from '../src/parsers/pdfBankSplitter';
import { PageMapItem } from '../src/parsers/qwenPdfParser';
import { PDFDocument } from 'pdf-lib';

test('bank splitter creates continuous runs and carries document pages to their neighbour', () => {
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

test('bank splitter never joins separated runs when the same bank appears again later', () => {
  const groups = buildBankGroups(new Map<number, PageMapItem>([
    [1, page(1, '中国工商银行')],
    [2, page(2, '中国工商银行')],
    [3, page(3, '中国农业银行')],
    [4, page(4, '中国农业银行')],
    [5, page(5, '工商银行')]
  ]), 5);

  assert.deepEqual(groups.map(group => [group.bankName, group.pageSelection]), [
    ['中国工商银行', '1-2'],
    ['中国农业银行', '3-4'],
    ['工商银行', '5']
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

test('split validation rejects scattered ranges and requires every page type to be confirmed', () => {
  const groups = [
    { id: '1', bankName: '工商银行', suggestedBankName: '工商银行', pages: [1, 2, 4], pageSelection: '1-2,4', confidence: 1, pageTypes: ['TRANSACTIONS'] as PageMapItem['pageType'][] },
    { id: '2', bankName: '农业银行', suggestedBankName: '农业银行', pages: [3], pageSelection: '3', confidence: 1, pageTypes: ['UNKNOWN'] as PageMapItem['pageType'][] }
  ];
  const errors = validateBankGroups(groups, 4, [
    { page: 1, pageType: 'TRANSACTIONS', detectedBankName: '工商银行', assignedBankName: '工商银行', confidence: 1 },
    { page: 2, pageType: 'ACCOUNT_LIST', detectedBankName: '工商银行', assignedBankName: '工商银行', confidence: 1 },
    { page: 3, pageType: 'UNKNOWN', detectedBankName: '', assignedBankName: '农业银行', confidence: 0 },
    { page: 4, pageType: 'BLANK', detectedBankName: '', assignedBankName: '工商银行', confidence: 1 }
  ]);
  assert.ok(errors.some(error => error.includes('必须是连续页段')));
  assert.ok(errors.some(error => error.includes('第 3 页的页面类型尚未确认')));
});

test('recognition recommendation keeps evidence pages and excludes administrative filler', () => {
  assert.equal(isPageRecommendedForRecognition('TRANSACTIONS'), true);
  assert.equal(isPageRecommendedForRecognition('ACCOUNT_LIST'), true);
  assert.equal(isPageRecommendedForRecognition('BANK_REPLY'), true);
  assert.equal(isPageRecommendedForRecognition('INVESTIGATION_ORDER'), false);
  assert.equal(isPageRecommendedForRecognition('COVER'), false);
  assert.equal(isPageRecommendedForRecognition('BLANK'), false);
});

test('split PDF contains only pages selected for the recognition stage', async () => {
  const source = await PDFDocument.create();
  for (let index = 0; index < 4; index += 1) source.addPage([300 + index, 500]);
  const sourceFile = new File([Uint8Array.from(await source.save()).buffer], '卷宗.pdf', { type: 'application/pdf' });
  const pageEntry = (page: number, selectedForRecognition: boolean) => ({
    page,
    pageType: selectedForRecognition ? 'TRANSACTIONS' as const : 'COVER' as const,
    detectedBankName: '工商银行',
    assignedBankName: '工商银行',
    confidence: 1,
    thumbnailUrl: '',
    suggestedForRecognition: selectedForRecognition,
    selectedForRecognition,
    selectionModifiedByUser: false
  });
  const files = await createBankSplitFiles({
    id: 'plan',
    sourceFile,
    sourcePdfUrl: '',
    totalPages: 4,
    groups: [{
      id: 'segment', bankName: '工商银行', suggestedBankName: '工商银行', pages: [1, 2, 3, 4],
      pageSelection: '1-4', confidence: 1, pageTypes: ['COVER', 'TRANSACTIONS']
    }],
    pages: [pageEntry(1, false), pageEntry(2, true), pageEntry(3, false), pageEntry(4, true)]
  });

  assert.equal(files.length, 1);
  assert.match(files[0].name, /原第2_4页/);
  const split = await PDFDocument.load(await files[0].arrayBuffer());
  assert.equal(split.getPageCount(), 2);
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
