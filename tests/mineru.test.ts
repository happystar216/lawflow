import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMinerUPages } from '../src/parsers/mineruResultParser';
import {
  applyMinerUModelNormalization,
  parseMinerUDocumentToBankStatement,
  parseMinerUTableHtml
} from '../src/parsers/mineruBankStatementParser';
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

test('MinerU HTML tables are converted directly into accounts and transactions without page classification', () => {
  const accountTable = '<table><tr><td>客户名称</td><td>账号</td><td>金额</td></tr>'
    + '<tr><td>胡艳红</td><td>22255301100017262</td><td>57.67</td></tr>'
    + '<tr><td>胡艳红</td><td>22240101100859012</td><td>31573.42</td></tr></table>';
  const transactionTable = '<table><tr><td>姓名</td><td>账号</td><td>交易日期</td><td>交易金额</td><td>账户余额</td><td>交易摘要</td></tr>'
    + '<tr><td>胡艳红</td><td>255301100017262</td><td>20230621</td><td>0.03</td><td>57.48</td><td>结息</td></tr>'
    + '<tr><td>胡艳红</td><td>255301100017262</td><td>20230921</td><td>0.03</td><td>57.51</td><td>结息</td></tr></table>';
  const parsed = parseMinerUDocumentToBankStatement({
    pages: [{ page: 1, text: '中国农业银行' }, { page: 2, text: '账户信息' }, { page: 3, text: '交易明细' }],
    blocks: [
      { page: 2, type: 'table', text: accountTable, tableHtml: accountTable, bbox: [50, 100, 950, 400] },
      { page: 3, type: 'table', text: transactionTable, tableHtml: transactionTable, bbox: [50, 100, 950, 700] }
    ]
  }, '06_中国农业银行_流水.pdf', '胡艳红', 3);

  assert.equal(parsed.accounts.length, 2);
  assert.equal(parsed.transactions.length, 2);
  assert.deepEqual(parsed.transactions.map(transaction => transaction.accountNumber), [
    '22255301100017262', '22255301100017262'
  ]);
  assert.deepEqual(parsed.transactions.map(transaction => transaction.direction), ['IN', 'IN']);
  assert.equal(parsed.transactions[0].extractionMethod, 'MINERU_DIRECT_PDF');
  assert.equal(parsed.transactions[0].rawPageNumber, 3);
  assert.equal(parsed.transactions[0].sourceRegion?.origin, 'ESTIMATED');
});

test('MinerU table parser expands colspan cells and ignores markup', () => {
  assert.deepEqual(parseMinerUTableHtml(
    '<table><tr><th>日期</th><th>摘要</th></tr><tr><td>2024-01-01</td><td colspan="2"><b>结息</b></td></tr></table>'
  ), [
    ['日期', '摘要'],
    ['2024-01-01', '结息', '']
  ]);
});

test('large-model normalization improves institution fields without dropping an omitted source row', () => {
  const table = '<table><tr><td>姓名</td><td>账号</td><td>交易日期</td><td>交易金额</td><td>账户余额</td><td>交易摘要</td></tr>'
    + '<tr><td>胡艳红</td><td>255301100017262</td><td>20230621</td><td>0.03</td><td>57.48</td><td>结息</td></tr>'
    + '<tr><td>胡艳红</td><td>255301100017262</td><td>20230921</td><td>0.03</td><td>57.51</td><td>结息</td></tr></table>';
  const draft = parseMinerUDocumentToBankStatement({
    pages: [{ page: 1, text: '账户交易明细' }],
    blocks: [{ page: 1, type: 'table', text: table, tableHtml: table }]
  }, '06_中国农业银行.pdf', '胡艳红', 1);
  const first = draft.transactions[0];
  const normalized = applyMinerUModelNormalization(
    draft,
    [{ accountNumber: '255301100017262', accountName: '胡艳红', bankName: '四川农信' }],
    [{
      sourceKey: first.id,
      accountNumber: first.accountNumber,
      accountName: '胡艳红',
      bankName: '四川农信',
      transactionTime: first.transactionTime,
      direction: 'IN', amount: 0.03, balance: 57.48,
      counterpartyName: '', counterpartyAccount: '', counterpartyBank: '', summary: '结息', confidence: 0.98
    }],
    [],
    '06_中国农业银行.pdf', '胡艳红', 1
  );
  assert.equal(normalized.transactions.length, 2);
  assert.equal(normalized.transactions[0].bankName, '四川农信');
  assert.equal(normalized.transactions[1].amount, draft.transactions[1].amount);
  assert.match(normalized.accounts[0].parseWarnings?.join('') || '', /未返回 1 笔/);
});
