import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleSlash2, ExternalLink, Minus, Plus, Scissors, Trash2 } from 'lucide-react';
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
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [isPanning, setIsPanning] = useState(false);
  const timelineViewportRef = useRef<HTMLDivElement>(null);
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number; moved: boolean }>();
  const boundaryDragRef = useRef<{ pointerId: number; boundaryIndex: number }>();
  const ignoreFrameClickRef = useRef(false);
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
  const frameWidth = Math.round(86 * timelineZoom);
  const frameHeight = Math.round(96 * timelineZoom);
  const timelineWidth = Math.max(frameWidth, plan.totalPages * frameWidth);
  const pdfPageUrl = activePage ? `${plan.sourcePdfUrl}#page=${activePage.page}&zoom=page-fit&toolbar=1&navpanes=0` : plan.sourcePdfUrl;
  const canSplitAtActivePage = Boolean(activeSegment && activePage && activePage.page > (activeSegment.pages[0] || 1));

  const beginTimelinePan = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-timeline-control="true"]')) return;
    const viewport = timelineViewportRef.current;
    if (!viewport) return;
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: viewport.scrollLeft, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  };

  const beginBoundaryDrag = (event: React.PointerEvent<HTMLButtonElement>, boundaryIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    boundaryDragRef.current = { pointerId: event.pointerId, boundaryIndex };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updatePointerInteraction = (event: React.PointerEvent<HTMLDivElement>) => {
    const boundary = boundaryDragRef.current;
    if (boundary?.pointerId === event.pointerId) {
      const content = timelineContentRef.current;
      if (!content) return;
      const rect = content.getBoundingClientRect();
      const boundaryPage = Math.round((event.clientX - rect.left) / frameWidth);
      onBoundaryChange(boundary.boundaryIndex, Math.max(1, Math.min(plan.totalPages - 1, boundaryPage)));
      return;
    }
    const pan = panRef.current;
    const viewport = timelineViewportRef.current;
    if (!pan || pan.pointerId !== event.pointerId || !viewport) return;
    const distance = event.clientX - pan.startX;
    if (Math.abs(distance) > 4) {
      pan.moved = true;
      ignoreFrameClickRef.current = true;
    }
    viewport.scrollLeft = pan.startScrollLeft - distance;
  };

  const endPointerInteraction = (event: React.PointerEvent<HTMLDivElement>) => {
    if (boundaryDragRef.current?.pointerId === event.pointerId) boundaryDragRef.current = undefined;
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = undefined;
      setIsPanning(false);
      window.setTimeout(() => { ignoreFrameClickRef.current = false; }, 0);
    }
  };

  const openPage = (pageNumber: number) => {
    if (ignoreFrameClickRef.current) return;
    setActivePageNumber(pageNumber);
  };

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
            title={canSplitAtActivePage ? '让当前页成为下一个银行材料区间的第一页' : '请选择当前银行区间第一张之后的页面'}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <Scissors className="h-4 w-4" />
            从本页切开银行区间
          </button>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-slate-950 p-3.5 shadow-inner">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-semibold text-white">PDF 页面时间线</div>
            <div className="mt-0.5 text-[10px] text-slate-400">按住时间轴左右拖动；上方括号表示银行材料区间，拖动括号端点即可调整范围。</div>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            <div data-timeline-control="true" className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-1.5 py-1 text-slate-300">
              <button type="button" onClick={() => setTimelineZoom(value => Math.max(0.6, Number((value - 0.2).toFixed(1))))} className="rounded p-1 hover:bg-white/10" aria-label="缩小时间轴"><Minus className="h-3 w-3" /></button>
              <input
                type="range"
                min="0.6"
                max="1.8"
                step="0.1"
                value={timelineZoom}
                onChange={event => setTimelineZoom(Number(event.target.value))}
                className="w-20 accent-blue-400"
                aria-label="时间轴缩放"
              />
              <button type="button" onClick={() => setTimelineZoom(value => Math.min(1.8, Number((value + 0.2).toFixed(1))))} className="rounded p-1 hover:bg-white/10" aria-label="放大时间轴"><Plus className="h-3 w-3" /></button>
            </div>
            <button
              type="button"
              data-timeline-control="true"
              onClick={onApplySuggestedSelection}
              disabled={disabled}
              className="rounded-lg border border-blue-400/30 bg-blue-500/15 px-2.5 py-1.5 text-[11px] font-medium text-blue-200 hover:bg-blue-500/25"
            >
              恢复系统建议选择
            </button>
          </div>
        </div>

        <div
          ref={timelineViewportRef}
          className={`select-none overflow-x-auto pb-3 ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ touchAction: 'pan-y' }}
          onPointerDown={beginTimelinePan}
          onPointerMove={updatePointerInteraction}
          onPointerUp={endPointerInteraction}
          onPointerCancel={endPointerInteraction}
          onWheel={event => {
            if (!timelineViewportRef.current || (!event.shiftKey && Math.abs(event.deltaX) < 1)) return;
            event.preventDefault();
            timelineViewportRef.current.scrollLeft += event.deltaX || event.deltaY;
          }}
        >
          <div ref={timelineContentRef} className="relative" style={{ width: timelineWidth }}>
            <div className="flex h-20">
              {segments.map(segment => (
                <div
                  key={segment.group.id}
                  onClick={() => segment.pages[0] && openPage(segment.pages[0])}
                  className="group/segment relative min-w-0 flex-shrink-0 text-left"
                  style={{ width: segment.pages.length * frameWidth, color: segment.color.solid }}
                  title={`${segment.group.bankName}：第 ${rangeLabel(segment.pages)} 页`}
                >
                  <div data-timeline-control="true" className="absolute left-2 right-2 top-0 z-10 flex min-w-0 items-center justify-center gap-1">
                    <input
                      value={segment.group.bankName}
                      onClick={event => event.stopPropagation()}
                      onChange={event => onGroupChange(segment.group.id, { bankName: event.target.value })}
                      disabled={disabled}
                      aria-label={`第 ${rangeLabel(segment.pages)} 页所属银行`}
                      className="min-w-0 max-w-48 flex-1 truncate rounded border border-white/15 bg-slate-900/90 px-1.5 py-0.5 text-center text-[11px] font-semibold text-white outline-none placeholder:text-white/60 focus:border-white/60"
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
                        className="flex-shrink-0 rounded bg-slate-900/80 p-1 text-white/60 hover:bg-white/15 hover:text-white disabled:opacity-40"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <div
                    className="absolute bottom-1 left-1 right-1 h-9 rounded-t-md border-l-2 border-r-2 border-t-2"
                    style={{ borderColor: segment.color.solid }}
                  >
                    <div className="absolute inset-x-1 top-1 truncate text-center text-[9px] font-medium text-slate-300">
                      {segment.group.documentLabel || `第 ${rangeLabel(segment.pages)} 页`}
                    </div>
                    <span className="absolute -bottom-0.5 left-1 rounded bg-slate-950 px-1 text-[8px] text-slate-400">{segment.pages[0]}</span>
                    <span className="absolute -bottom-0.5 right-1 rounded bg-slate-950 px-1 text-[8px] text-slate-400">{segment.pages.at(-1)}</span>
                  </div>
                  {segment.originalIndex < plan.groups.length - 1 && (
                    <button
                      type="button"
                      data-timeline-control="true"
                      onPointerDown={event => beginBoundaryDrag(event, segment.originalIndex)}
                      onClick={event => event.stopPropagation()}
                      disabled={disabled}
                      aria-label={`${segment.group.bankName}结束页拖动手柄`}
                      title="左右拖动调整两个银行区间的分界页"
                      className="absolute -right-2 bottom-0 z-20 h-6 w-4 cursor-ew-resize rounded-full border-2 border-slate-950 bg-white shadow disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: segment.color.solid }}
                    />
                  )}
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
                      data-timeline-frame="true"
                      onClick={() => openPage(page.page)}
                      className={`group relative w-full rounded-lg border-2 p-1 text-left transition-all ${isActive ? 'border-yellow-400 bg-yellow-50 -translate-y-1 shadow-lg' : 'border-transparent bg-slate-800 hover:border-slate-500'} ${page.selectedForRecognition ? '' : 'opacity-45'}`}
                      aria-label={`查看原 PDF 第 ${page.page} 页，${pageTypeLabel(page.pageType)}`}
                    >
                      <div className="overflow-hidden rounded-md bg-white" style={{ height: frameHeight, borderTop: `4px solid ${segment?.color.solid || '#64748b'}` }}>
                        {page.thumbnailUrl ? <img src={page.thumbnailUrl} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover object-top" /> : <div className="flex h-full items-center justify-center text-[9px] text-slate-400">无预览</div>}
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
