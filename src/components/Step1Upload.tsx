import React, { useState, useRef } from 'react';
import { UploadCloud, FileSpreadsheet, FileText, FileImage, CheckCircle2, ArrowRight, ArrowLeft, Trash2, PlusCircle, AlertCircle, ShieldCheck, Sparkles, StopCircle } from 'lucide-react';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { parseExcelBankStatement } from '../parsers/excelParser';
import { parsePdfWithAliyunEcs, DEFAULT_ECS_HOST, OcrProgressInfo } from '../parsers/aliyunEcsOcr';

interface Step1Props {
  accounts: BankAccount[];
  transactions: StandardTransaction[];
  onDataUpdated: (accounts: BankAccount[], transactions: StandardTransaction[]) => void;
  onNext: () => void;
  onPrev: () => void;
}

export const Step1Upload: React.FC<Step1Props> = ({
  accounts,
  transactions,
  onDataUpdated,
  onNext,
  onPrev
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressInfo, setProgressInfo] = useState<OcrProgressInfo | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const handleCancelProcessing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsProcessing(false);
    setProgressInfo(null);
    setStatusText('已手动停止当前文件解析');
  };

  const handleFiles = async (files: FileList | File[]) => {
    const fileList = Array.from(files);
    if (fileList.length === 0) return;

    setIsProcessing(true);
    setErrorMessage(null);
    setProgressInfo(null);
    setStatusText(null);

    const newAccounts = [...accounts];
    const newTransactions = [...transactions];

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const name = file.name.toLowerCase();

      try {
        if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
          setStatusText(`正在解析结构化电子流水: ${file.name}...`);
          const { account, transactions: parsedTx } = await parseExcelBankStatement(file);
          newAccounts.push(account);
          newTransactions.push(...parsedTx);
        } else if (name.endsWith('.pdf') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp') || name.endsWith('.bmp')) {
          const controller = new AbortController();
          abortControllerRef.current = controller;

          const { account, transactions: parsedTx } = await parsePdfWithAliyunEcs(
            file,
            DEFAULT_ECS_HOST,
            (info: OcrProgressInfo) => {
              setProgressInfo(info);
              if (info.statusText) setStatusText(info.statusText);
            },
            controller.signal
          );
          newAccounts.push(account);
          newTransactions.push(...parsedTx);
        } else {
          setErrorMessage(`不支持的文件格式: ${file.name}，请上传 Excel、CSV、PDF 或扫描图片。`);
        }
      } catch (err: any) {
        if (err.name === 'AbortError' || err.message?.includes('停止')) {
          console.log('User cancelled parsing:', file.name);
          setStatusText('已取消解析');
          break;
        }
        console.error('Error processing file:', file.name, err);
        setErrorMessage(`解析文件 ${file.name} 失败: ${err.message || '文件格式无法识别或内容损坏'}`);
      } finally {
        abortControllerRef.current = null;
      }
    }

    setIsProcessing(false);
    setProgressInfo(null);
    setStatusText(null);
    onDataUpdated(newAccounts, newTransactions);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleRemoveAccount = (accNum: string) => {
    const updatedAccounts = accounts.filter(a => a.accountNumber !== accNum);
    const updatedTransactions = transactions.filter(t => t.accountNumber !== accNum);
    onDataUpdated(updatedAccounts, updatedTransactions);
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 sm:px-6 space-y-6">
      {/* Step Header */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
            Step 1 / 6 证据上传
          </span>

          <div className="flex items-center space-x-2">
            <span className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-xs font-medium">
              <Sparkles className="w-3.5 h-3.5 text-blue-600" />
              <span>AI 银行流水智能穿透引擎已就绪</span>
            </span>

            <span className="inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-medium">
              <ShieldCheck className="w-3 h-3 text-emerald-600" />
              <span>司法印章自动滤除</span>
            </span>
          </div>
        </div>

        <h1 className="text-2xl font-bold text-slate-900 mt-3">
          上传银行流水证据文件
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          支持各大商业银行导出的 Excel/CSV 电子流水、PDF 扫描件及调查令回执照片。系统支持 100+ 页长卷扫描件全自动印章穿透与实时逐页对账。
        </p>
      </div>

      {/* Upload Zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`relative border-2 border-dashed rounded-2xl p-10 text-center transition-all bg-white shadow-sm ${
          isDragging
            ? 'border-blue-500 bg-blue-50/50 scale-[1.005]'
            : 'border-slate-300 hover:border-slate-400'
        }`}
      >
        <input
          type="file"
          id="file-upload"
          multiple
          accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp,.bmp"
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
          className="hidden"
          disabled={isProcessing}
        />

        <div className="flex flex-col items-center justify-center space-y-4">
          <div className={`p-4 rounded-full transition-transform ${isDragging ? 'bg-blue-100 scale-110' : 'bg-slate-100'}`}>
            <UploadCloud className={`w-10 h-10 ${isDragging ? 'text-blue-600' : 'text-slate-500'}`} />
          </div>

          <div className="space-y-1">
            <label
              htmlFor="file-upload"
              className="text-base font-semibold text-blue-600 hover:text-blue-700 cursor-pointer hover:underline"
            >
              点击选择文件
            </label>
            <span className="text-slate-600 text-base"> 或直接拖拽文件到这里</span>
            <p className="text-xs text-slate-400 mt-1">
              支持格式：.xlsx, .xls, .csv, .pdf, .jpg, .png, .jpeg（单文件支持 100+ 页扫描件）
            </p>
          </div>

          {isProcessing && (
            <div className="w-full max-w-lg bg-blue-50/90 border border-blue-200 rounded-2xl p-5 text-left space-y-3 mt-4 shadow-sm">
              <div className="flex items-center justify-between text-blue-900 font-semibold text-sm">
                <div className="flex items-center space-x-2">
                  <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  <span className="truncate">{statusText || '正在初始化智能识别引擎...'}</span>
                </div>
                <div className="flex items-center space-x-2">
                  {progressInfo && progressInfo.totalPages > 0 && (
                    <span className="text-xs font-mono font-bold text-blue-700 bg-blue-100/80 px-2 py-0.5 rounded-full flex-shrink-0">
                      {progressInfo.percent}%
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleCancelProcessing}
                    className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-600 text-xs font-medium transition shadow-xs"
                    title="中止当前识别任务"
                  >
                    <StopCircle className="w-3.5 h-3.5" />
                    <span>停止</span>
                  </button>
                </div>
              </div>

              {/* Real-time Streaming Progress Bar */}
              {progressInfo && progressInfo.totalPages > 0 && (
                <div className="space-y-1.5">
                  <div className="w-full h-2.5 bg-blue-200/60 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-600 to-indigo-600 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${Math.max(progressInfo.percent, 3)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] text-slate-500 font-medium pt-0.5">
                    <span>
                      已完成：<strong>{progressInfo.currentPage}</strong> / {progressInfo.totalPages} 页
                    </span>
                    <span>
                      已提取有效明细：<strong className="text-emerald-700">{progressInfo.totalTransactions}</strong> 笔
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {errorMessage && (
            <div className="flex items-center space-x-2 text-red-600 bg-red-50 border border-red-200 px-4 py-2 rounded-xl text-xs mt-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>
      </div>

      {/* Uploaded Accounts List */}
      {accounts.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div className="flex items-center space-x-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              <h2 className="text-base font-semibold text-slate-900">
                已成功导入账户 ({accounts.length})
              </h2>
            </div>
            <span className="text-xs text-slate-500">
              共计 {transactions.length} 笔流水记录 · 浏览器已自动保存
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {accounts.map((acc) => (
              <div
                key={acc.accountNumber}
                className="flex items-start justify-between p-4 rounded-xl border border-slate-200 hover:border-slate-300 bg-slate-50/50 hover:bg-slate-50 transition"
              >
                <div className="flex items-start space-x-3">
                  <div className="p-2.5 rounded-lg bg-blue-100/70 text-blue-700 mt-0.5">
                    {acc.fileType === 'excel' || acc.fileType === 'csv' ? (
                      <FileSpreadsheet className="w-5 h-5" />
                    ) : acc.fileType === 'pdf' ? (
                      <FileText className="w-5 h-5" />
                    ) : (
                      <FileImage className="w-5 h-5" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="font-semibold text-slate-900 text-sm">{acc.bankName}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200/70 text-slate-700 font-mono">
                        {acc.accountNumber.slice(-4) ? `...${acc.accountNumber.slice(-4)}` : acc.accountNumber}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">
                      户名: <span className="font-medium">{acc.accountName}</span> | 来源文件: {acc.fileName}
                    </p>
                    <div className="flex items-center space-x-3 mt-2 text-[11px] text-slate-500 font-mono">
                      <span>入: <strong className="text-emerald-600 font-normal">¥{acc.totalIn.toLocaleString()}</strong></span>
                      <span>出: <strong className="text-rose-600 font-normal">¥{acc.totalOut.toLocaleString()}</strong></span>
                      <span>流水: {acc.transactionCount} 笔</span>
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => handleRemoveAccount(acc.accountNumber)}
                  className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition"
                  title="删除该账户流水"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>

          <div className="pt-2 flex justify-between items-center">
            <label
              htmlFor="file-upload"
              className="inline-flex items-center space-x-1.5 text-xs text-blue-600 hover:text-blue-700 font-medium cursor-pointer"
            >
              <PlusCircle className="w-4 h-4" />
              <span>继续添加其他银行流水</span>
            </label>
          </div>
        </div>
      )}

      {/* Navigation Footer */}
      <div className="flex items-center justify-between pt-4">
        <button
          onClick={onPrev}
          disabled
          className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-xl border border-slate-200 text-slate-400 bg-slate-50 cursor-not-allowed text-sm font-medium"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>上一步</span>
        </button>

        <button
          onClick={onNext}
          disabled={accounts.length === 0 || isProcessing}
          className={`inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl text-sm font-medium transition shadow-sm ${
            accounts.length > 0 && !isProcessing
              ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          }`}
        >
          <span>下一步：账户主体归属确认</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
