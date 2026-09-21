import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PdfTimelineEditor } from '../src/components/PdfTimelineEditor';
import { PdfBankSplitPlan } from '../src/parsers/pdfBankSplitter';

test('PDF timeline editor exposes the original document, bank tracks and frame controls', () => {
  const plan: PdfBankSplitPlan = {
    id: 'timeline-plan',
    sourceFile: new File([new Uint8Array([1])], '测试卷宗.pdf', { type: 'application/pdf' }),
    sourcePdfUrl: 'blob:original-pdf',
    totalPages: 4,
    groups: [
      {
        id: 'bank-one', bankName: '中国工商银行', suggestedBankName: '中国工商银行',
        pages: [1, 2], pageSelection: '1-2', confidence: 0.98, pageTypes: ['ACCOUNT_LIST', 'TRANSACTIONS']
      },
      {
        id: 'bank-two', bankName: '中国农业银行', suggestedBankName: '中国农业银行',
        pages: [3, 4], pageSelection: '3-4', confidence: 0.97, pageTypes: ['TRANSACTIONS']
      }
    ],
    pages: [1, 2, 3, 4].map(page => ({
      page,
      pageType: page === 1 ? 'ACCOUNT_LIST' as const : 'TRANSACTIONS' as const,
      detectedBankName: page <= 2 ? '中国工商银行' : '中国农业银行',
      assignedBankName: page <= 2 ? '中国工商银行' : '中国农业银行',
      confidence: 0.98,
      thumbnailUrl: `blob:thumbnail-${page}`,
      suggestedForRecognition: true,
      selectedForRecognition: true,
      selectionModifiedByUser: false
    }))
  };

  const markup = renderToStaticMarkup(React.createElement(PdfTimelineEditor, {
    plan,
    onGroupChange: () => undefined,
    onBoundaryChange: () => undefined,
    onRemoveGroup: () => undefined,
    onSplitAtPage: () => undefined,
    onPageTypeChange: () => undefined,
    onTogglePageSelection: () => undefined,
    onApplySuggestedSelection: () => undefined
  }));

  assert.match(markup, /原文件 · 第 1 页/);
  assert.match(markup, /blob:original-pdf#page=1/);
  assert.match(markup, /PDF 页面时间线/);
  assert.match(markup, /中国工商银行/);
  assert.match(markup, /第 1-2 页/);
  assert.match(markup, /拖动银行分界/);
  assert.match(markup, /从本页切开/);
  assert.equal(markup.match(/查看原 PDF 第 \d 页/g)?.length, 4);
  assert.doesNotMatch(markup, /片段 1/);
});
