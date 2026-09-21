import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleSlash2, ExternalLink, Scissors, Trash2 } from 'lucide-react';
import {
  parsePageSelection,
  PdfBankGroup,
  PdfBankSplitPlan,
  PdfPageClassification
} from '../parsers/pdfBankSplitter';

interface PdfTimelineEditorProps {
  plan: PdfBankSplitPlan;
  disabled?: boolean;
  onGroupChange: (groupId: string, patch: { bankName?: string }) => void;
  onBoundaryChange: (boundaryIndex: number, leftEndPage: number) => void;
  onRemoveGroup: (groupId: string) => void;
  onSplitAtPage: (pageNumber: number) => void;
  onPageTypeChange: (pageNumber: number, pageType: PdfPageClassification['pageType']) => void;
  onTogglePageSelection: (pageNumber: number) => void;
  onApplySuggestedSelection: () => void;
}

const PAGE_TYPE_OPTIONS: Array<{ value: PdfPageClassification['pageType']; label: string }> = [
  { value: 'TRANSACTIONS', label: '流水明细' },
  { value: 'ACCOUNT_LIST', label: '账号列表' },
  { value: 'ACCOUNT_INFO', label: '账户资料' },
  { value: 'INVESTIGATION_ORDER', label: '调查令' },
  { value: 'BANK_REPLY', label: '银行回函' },
  { value: 'COVER', label: '封面/目录' },
  { value: 'OTHER_DOCUMENT', label: '其他资料' },
  { value: 'DOCUMENT', label: '一般文书' },
  { value: 'BLANK', label: '空白页' },
  { value: 'UNKNOWN', label: '待确认' }
];

const SEGMENT_COLORS = [
  { solid: '#2563eb', soft: '#dbeafe', text: '#1e3a8a' },
  { solid: '#059669', soft: '#d1fae5', text: '#064e3b' },
  { solid: '#7c3aed', soft: '#ede9fe', text: '#4c1d95' },
  { solid: '#ea580c', soft: '#ffedd5', text: '#7c2d12' },
  { solid: '#0891b2', soft: '#cffafe', text: '#164e63' },
  { solid: '#db2777', soft: '#fce7f3', text: '#831843' }
];

interface TimelineSegment {
  group: PdfBankGroup;
  pages: number[];
  color: typeof SEGMENT_COLORS[number];
  originalIndex: number;
}

export const PdfTimelineEditor: React.FC<PdfTimelineEditorProps> = ({
  plan,
  disabled,
  onGroupChange,
  onBoundaryChange,
  onRemoveGroup,
  onSplitAtPage,
  onPageTypeChange,
  onTogglePageSelection,
  onApplySuggestedSelection
}) => {
  const orderedPages = useMemo(() => [...plan.pages].sort((left, right) => left.page - right.page), [plan.pages]);
  const segments = useMemo<TimelineSegment[]>(() => plan.groups.map((group, originalIndex) => ({
    group,
    pages: safeGroupPages(group, plan.totalPages),
    color: SEGMENT_COLORS[originalIndex % SEGMENT_COLORS.length],
    originalIndex
  })).sort((left, right) => (left.pages[0] || Number.MAX_SAFE_INTEGER) - (right.pages[0] || Number.MAX_SAFE_INTEGER)), [plan.groups, plan.totalPages]);
  const firstAttentionPage = orderedPages.find(page => page.pageType === 'UNKNOWN')
    || orderedPages.find(page => page.selectedForRecognition)
    || orderedPages[0];
  const [activePageNumber, setActivePageNumber] = useState(firstAttentionPage?.page || 1);
  const activePage = orderedPages.find(page => page.page === activePageNumber) || orderedPages[0];

  useEffect(() => {
    if (!orderedPages.some(page => page.page === activePageNumber) && orderedPages[0]) {
      setActivePageNumber(orderedPages[0].page);
    }
  }, [activePageNumber, orderedPages]);

  const segmentByPage = useMemo(() => {
    const result = new Map<number, TimelineSegment>();
    for (const segment of segments) for (const page of segment.pages) result.set(page, segment);
    return result;
  }, [segments]);
  const activeSegment = activePage ? segmentByPage.get(activePage.page) : undefined;
  const selectedCount = orderedPages.filter(page => page.selectedForRecognition).length;
  const frameWidth = 86;
  const timelineWidth = Math.max(860, plan.totalPages * frameWidth);
  const pdfPageUrl = activePage ? `${plan.sourcePdfUrl}#page=${activePage.page}&zoom=page-fit&toolbar=1&navpanes=0` : plan.sourcePdfUrl;
  const canSplitAtActivePage = Boolean(activeSegment && activePage && activePage.page > (activeSegment.pages[0] || 1));

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-slate-300 bg-slate-900 shadow-sm">
        <div className="flex flex-col gap-2 border-b border-slate-700 bg-slate-950 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">原文件 · 第 {activePage?.page || 1} 页</div>
            <div className="mt-0.5 text-[11px] text-slate-400">这里直接显示原始 PDF，可缩放、搜索和翻页；下方缩略图仅用于定位。</div>
          </div>
          <a
            href={pdfPageUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex flex-shrink-0 items-center gap-1.5 self-start rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-white/15 sm:self-auto"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            独立打开原文件
          </a>
        </div>
        <iframe
          key={activePage?.page || 1}
          src={pdfPageUrl}
          title={`${plan.sourceFile.name} 第 ${activePage?.page || 1} 页原文`}
          className="h-[620px] w-full bg-slate-800"
        />
      </div>

      {activePage && (
        <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3.5 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900">第 {activePage.page} 页</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{ backgroundColor: activeSegment?.color.soft || '#e2e8f0', color: activeSegment?.color.text || '#334155' }}
              >
                {activeSegment?.group.bankName || '待确认银行'}
              </span>
              {activePage.confidence < 0.55 && <span className="text-[10px] text-amber-700">页面分类把握较低</span>}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              系统建议：{activePage.suggestedForRecognition ? '进入识别' : '不进入识别'} · 当前已选择 {selectedCount}/{plan.totalPages} 页
            </div>
          </div>
          <select
            value={activePage.pageType}
            onChange={event => onPageTypeChange(activePage.page, event.target.value as PdfPageClassification['pageType'])}
            disabled={disabled}
            aria-label={`第 ${activePage.page} 页内容类型`}
            className={`rounded-lg border px-3 py-2 text-xs outline-none ${activePage.pageType === 'UNKNOWN' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-slate-300 bg-white text-slate-800'}`}
          >
            {PAGE_TYPE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <button
            type="button"
            onClick={() => onTogglePageSelection(activePage.page)}
            disabled={disabled}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold ${activePage.selectedForRecognition ? 'bg-blue-600 text-white hover:bg-blue-700' : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
          >
            {activePage.selectedForRecognition ? <CheckCircle2 className="h-4 w-4" /> : <CircleSlash2 className="h-4 w-4" />}
            {activePage.selectedForRecognition ? '进入识别' : '不进入识别'}
          </button>
          <button
            type="button"
            onClick={() => onSplitAtPage(activePage.page)}
            disabled={disabled || !canSplitAtActivePage}
            title={canSplitAtActivePage ? '让当前页成为一个新银行片段的第一页' : '请选择当前片段第一张之后的页面'}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <Scissors className="h-4 w-4" />
            从本页切开
          </button>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-slate-950 p-3.5 shadow-inner">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-semibold text-white">PDF 页面时间线</div>
            <div className="mt-0.5 text-[10px] text-slate-400">上层颜色表示银行页段；点击任意帧，上方立即打开对应原页。</div>
          </div>
          <button
            type="button"
            onClick={onApplySuggestedSelection}
            disabled={disabled}
            className="self-start rounded-lg border border-blue-400/30 bg-blue-500/15 px-2.5 py-1.5 text-[11px] font-medium text-blue-200 hover:bg-blue-500/25 sm:self-auto"
          >
            恢复系统建议选择
          </button>
        </div>

        <div className="overflow-x-auto pb-2">
          <div className="relative" style={{ width: timelineWidth }}>
            <div className="flex h-16 overflow-hidden rounded-lg border border-white/10 bg-slate-900">
              {segments.map(segment => (
                <div
                  key={segment.group.id}
                  onClick={() => segment.pages[0] && setActivePageNumber(segment.pages[0])}
                  className="group/segment min-w-0 cursor-pointer border-r border-white/40 px-2 py-1.5 text-left last:border-r-0"
                  style={{ width: segment.pages.length * frameWidth, backgroundColor: segment.color.solid }}
                  title={`${segment.group.bankName}：第 ${rangeLabel(segment.pages)} 页`}
                >
                  <div className="flex min-w-0 items-center gap-1">
                    <input
                      value={segment.group.bankName}
                      onClick={event => event.stopPropagation()}
                      onChange={event => onGroupChange(segment.group.id, { bankName: event.target.value })}
                      disabled={disabled}
                      aria-label={`第 ${rangeLabel(segment.pages)} 页所属银行`}
                      className="min-w-0 flex-1 truncate rounded border border-white/20 bg-black/10 px-1.5 py-0.5 text-[11px] font-semibold text-white outline-none placeholder:text-white/60 focus:border-white/70 focus:bg-black/20"
                      placeholder="待确认银行"
                    />
                    {segments.length > 1 && (
                      <button
                        type="button"
                        onClick={event => {
                          event.stopPropagation();
                          onRemoveGroup(segment.group.id);
                        }}
                        disabled={disabled}
                        title="与相邻银行区间合并"
                        aria-label={`合并${segment.group.bankName || '待确认银行'}区间`}
                        className="flex-shrink-0 rounded p-1 text-white/70 hover:bg-white/15 hover:text-white disabled:opacity-40"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <div className="mt-1 truncate text-[9px] text-white/80">第 {rangeLabel(segment.pages)} 页</div>
                </div>
              ))}
            </div>

            <div className="mt-2 flex">
              {orderedPages.map(page => {
                const segment = segmentByPage.get(page.page);
                const isActive = page.page === activePage?.page;
                return (
                  <div key={page.page} className="flex-shrink-0 px-[5px]" style={{ width: frameWidth }}>
                    <button
                      type="button"
                      onClick={() => setActivePageNumber(page.page)}
                      className={`group relative w-full rounded-lg border-2 p-1 text-left transition-all ${isActive ? 'border-yellow-400 bg-yellow-50 -translate-y-1 shadow-lg' : 'border-transparent bg-slate-800 hover:border-slate-500'} ${page.selectedForRecognition ? '' : 'opacity-45'}`}
                      aria-label={`查看原 PDF 第 ${page.page} 页，${pageTypeLabel(page.pageType)}`}
                    >
                      <div className="h-24 overflow-hidden rounded-md bg-white" style={{ borderTop: `4px solid ${segment?.color.solid || '#64748b'}` }}>
                        {page.thumbnailUrl ? <img src={page.thumbnailUrl} alt="" className="h-full w-full object-cover object-top" /> : <div className="flex h-full items-center justify-center text-[9px] text-slate-400">无预览</div>}
                      </div>
                      <div className="mt-1 truncate text-[9px] font-semibold text-slate-200">第 {page.page} 页</div>
                      <div className={`truncate text-[8px] ${page.pageType === 'UNKNOWN' ? 'text-amber-300' : 'text-slate-400'}`}>{pageTypeLabel(page.pageType)}</div>
                      <span className={`absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-slate-950 ${page.selectedForRecognition ? 'bg-blue-500 text-white' : 'bg-slate-500 text-white'}`}>
                        {page.selectedForRecognition ? <CheckCircle2 className="h-3 w-3" /> : <CircleSlash2 className="h-3 w-3" />}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>

            {activePage && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,0.9)]"
                style={{ left: (activePage.page - 1) * frameWidth + frameWidth / 2 }}
              />
            )}
          </div>
        </div>
      </div>

      {segments.length > 1 && (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3.5">
          <div className="text-[11px] font-semibold text-slate-700">拖动银行分界</div>
          {segments.slice(0, -1).map((left, boundaryIndex) => {
            const right = segments[boundaryIndex + 1];
            const start = left.pages[0] || 1;
            const end = right.pages.at(-1) || plan.totalPages;
            const value = left.pages.at(-1) || start;
            return (
              <div key={`${left.group.id}:${right.group.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center justify-between gap-3 text-[10px] text-slate-500">
                    <span className="truncate">{left.group.bankName} 截止第 {value} 页</span>
                    <span className="truncate text-right">{right.group.bankName} 从第 {value + 1} 页开始</span>
                  </div>
                  <input
                    type="range"
                    min={start}
                    max={Math.max(start, end - 1)}
                    value={value}
                    onChange={event => onBoundaryChange(left.originalIndex, Number(event.target.value))}
                    disabled={disabled}
                    className="mt-1.5 w-full"
                    style={{ accentColor: left.color.solid }}
                    aria-label={`${left.group.bankName}与${right.group.bankName}的页面分界`}
                  />
                </div>
                <input
                  type="number"
                  min={start}
                  max={Math.max(start, end - 1)}
                  value={value}
                  onChange={event => onBoundaryChange(left.originalIndex, Number(event.target.value))}
                  disabled={disabled}
                  className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-center text-xs font-mono outline-none focus:ring-2 focus:ring-blue-200"
                  aria-label="左侧银行截止页"
                />
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
};

function safeGroupPages(group: PdfBankGroup, totalPages: number): number[] {
  try {
    const pages = parsePageSelection(group.pageSelection, totalPages);
    return pages.length ? pages : group.pages;
  } catch {
    return group.pages;
  }
}

function rangeLabel(pages: number[]): string {
  if (!pages.length) return '—';
  return pages.length === 1 ? String(pages[0]) : `${pages[0]}-${pages.at(-1)}`;
}

function pageTypeLabel(type: PdfPageClassification['pageType']): string {
  return PAGE_TYPE_OPTIONS.find(option => option.value === type)?.label || '待确认';
}
