import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMinerUPages } from '../src/parsers/mineruResultParser';
import { buildPdfBankSplitSuggestion, PdfBankSplitPlan } from '../src/parsers/pdfBankSplitter';
import type { PageMapItem } from '../src/parsers/qwenPdfParser';

test('MinerU structured content is normalized into one-based PDF page text', () => {
  const pages = normalizeMinerUPages({
    pages: [
      { page_idx: 0, blocks: [{ type: 'text', content: '中国工商银行' }, { type: 'text', content: '账户列表' }] },
      { page_idx: 1, blocks: [{ type: 'table', content: [{ type: 'text', content: '2024-01-01 100.00' }] }] }
    ]
  });
  assert.deepEqual(pages, [
    { page: 1, text: '中国工商银行\n账户列表' },
    { page: 2, text: '2024-01-01 100.00' }
  ]);
});

test('MinerU legacy content list entries are grouped by page index', () => {
  const pages = normalizeMinerUPages([
    { page_idx: 1, type: 'text', text: '第二页第一行' },
    { page_idx: 0, type: 'text', text: '第一页' },
    { page_idx: 1, type: 'text', text: '第二页第二行' }
  ]);
  assert.deepEqual(pages, [
    { page: 1, text: '第一页' },
    { page: 2, text: '第二页第一行\n第二页第二行' }
  ]);
});

test('MinerU suggestion reuses the existing PDF previews but computes independent bank ranges', () => {
  const sourceFile = new File(['pdf'], '卷宗.pdf', { type: 'application/pdf' });
  const plan: PdfBankSplitPlan = {
    id: 'plan', sourceFile, totalPages: 3,
    groups: [{
      id: 'old', bankName: '待确认银行', suggestedBankName: '待确认银行', pages: [1, 2, 3],
      pageSelection: '1-3', confidence: 0, pageTypes: ['UNKNOWN']
    }],
    pages: [1, 2, 3].map(page => ({
      page, pageType: 'UNKNOWN' as const, detectedBankName: '', assignedBankName: '待确认银行', confidence: 0,
      thumbnailUrl: `blob:${page}`, suggestedForRecognition: true, selectedForRecognition: true,
      selectionModifiedByUser: false
    }))
  };
  const map = new Map<number, PageMapItem>([
    [1, pageMap(1, '中国工商银行', 'START')],
    [2, pageMap(2, '中国工商银行', 'CONTINUE')],
    [3, pageMap(3, '中国农业银行', 'START')]
  ]);
  const suggestion = buildPdfBankSplitSuggestion('MINERU', map, plan);
  assert.deepEqual(suggestion.groups.map(group => [group.bankName, group.pageSelection]), [
    ['中国工商银行', '1-2'],
    ['中国农业银行', '3']
  ]);
  assert.equal(suggestion.pages[1].thumbnailUrl, 'blob:2');
});

test('MinerU suggestion fills an omitted bank header from visual page evidence without replacing MinerU structure', () => {
  const sourceFile = new File(['pdf'], '名字可能错误的农业银行卷宗.pdf', { type: 'application/pdf' });
  const plan: PdfBankSplitPlan = {
    id: 'plan', sourceFile, totalPages: 2,
    groups: [{
      id: 'visual', bankName: '四川农信', suggestedBankName: '四川农信', pages: [1, 2],
      pageSelection: '1-2', confidence: 0.9, pageTypes: ['BANK_REPLY', 'TRANSACTIONS']
    }],
    pages: [1, 2].map(page => ({
      page, pageType: 'UNKNOWN' as const, detectedBankName: '四川农信', assignedBankName: '四川农信', confidence: 0.9,
      thumbnailUrl: `blob:${page}`, suggestedForRecognition: true, selectedForRecognition: true,
      selectionModifiedByUser: false
    }))
  };
  const map = new Map<number, PageMapItem>([
    [1, { ...pageMap(1, '', 'START'), pageType: 'BANK_REPLY' }],
    [2, { ...pageMap(2, '', 'CONTINUE'), pageType: 'TRANSACTIONS' }]
  ]);
  const suggestion = buildPdfBankSplitSuggestion('MINERU', map, plan);
  assert.equal(suggestion.groups[0].bankName, '四川农信');
  assert.deepEqual(suggestion.pages.map(page => page.pageType), ['BANK_REPLY', 'TRANSACTIONS']);
});

function pageMap(page: number, bankName: string, boundary: PageMapItem['documentBoundary']): PageMapItem {
  return {
    page, pageType: 'TRANSACTIONS', rotation: 0, bankName, accountName: '', accountNumbers: [], density: 'HIGH',
    confidence: 0.95, documentBoundary: boundary, documentLabel: bankName, investigationOrderNo: ''
  };
}
