import React, { useEffect, useRef, useState } from 'react';
import { FileWarning, LoaderCircle, RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';

GlobalWorkerOptions.workerSrc = workerUrl;

interface PdfEvidencePageProps {
  file: File | null;
  pageNumber?: number;
}

export const PdfEvidencePage: React.FC<PdfEvidencePageProps> = ({ file, pageNumber = 1 }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [scale, setScale] = useState(1.15);
  const [rotation, setRotation] = useState(0);
  const [status, setStatus] = useState<'LOADING' | 'READY' | 'MISSING' | 'ERROR'>(file ? 'LOADING' : 'MISSING');
  const [pageCount, setPageCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof getDocument> | undefined;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | undefined;
    if (!file) {
      setStatus('MISSING');
      return;
    }
    setStatus('LOADING');
    (async () => {
      try {
        loadingTask = getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
        const document = await loadingTask.promise;
        if (cancelled) return;
        setPageCount(document.numPages);
        const safePage = Math.min(Math.max(pageNumber, 1), document.numPages);
        const page = await document.getPage(safePage);
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法创建页面画布');
        renderTask = page.render({ canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        await renderTask.promise;
        if (!cancelled) setStatus('READY');
      } catch (error: any) {
        if (!cancelled && error?.name !== 'RenderingCancelledException') setStatus('ERROR');
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      loadingTask?.destroy();
    };
  }, [file, pageNumber, scale, rotation]);

  if (!file) {
    return (
      <div className="h-[620px] flex flex-col items-center justify-center text-center p-8 bg-slate-50 text-slate-500">
        <FileWarning className="w-9 h-9 text-amber-500 mb-3" />
        <div className="text-sm font-semibold text-slate-700">当前案件未保存这份原始PDF</div>
        <div className="text-xs mt-2 max-w-sm">请返回上传步骤，重新选择同名原始文件。重新解析时会恢复已经完成的页段。</div>
      </div>
    );
  }

  return (
    <div className="bg-slate-100 h-[620px] flex flex-col">
      <div className="h-11 px-3 bg-white border-b border-slate-200 flex items-center justify-between text-xs">
        <span className="font-medium text-slate-700">原始PDF第 {pageNumber} 页{pageCount ? ` / 共 ${pageCount} 页` : ''}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setScale(value => Math.max(0.65, value - 0.2))} className="p-1.5 rounded hover:bg-slate-100" title="缩小"><ZoomOut className="w-4 h-4" /></button>
          <span className="w-12 text-center text-slate-500">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale(value => Math.min(2.5, value + 0.2))} className="p-1.5 rounded hover:bg-slate-100" title="放大"><ZoomIn className="w-4 h-4" /></button>
          <button onClick={() => setRotation(value => (value + 90) % 360)} className="p-1.5 rounded hover:bg-slate-100" title="顺时针旋转"><RotateCw className="w-4 h-4" /></button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {status === 'LOADING' && <div className="absolute inset-0 flex items-center justify-center pointer-events-none"><LoaderCircle className="w-7 h-7 animate-spin text-blue-600" /></div>}
        {status === 'ERROR' && <div className="text-center text-sm text-rose-600 py-12">原始页面显示失败，请确认PDF文件可以正常打开。</div>}
        <canvas ref={canvasRef} className={`mx-auto bg-white shadow-md ${status === 'READY' ? 'block' : 'invisible'}`} />
      </div>
    </div>
  );
};
