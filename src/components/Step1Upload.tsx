import React, { useState } from 'react';
import { UploadCloud, FileSpreadsheet, FileText, CheckCircle2, ArrowRight, ArrowLeft, Trash2, PlusCircle, AlertCircle } from 'lucide-react';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { parseExcelBankStatement } from '../parsers/excelParser';
import { parsePdfBankStatement } from '../parsers/pdfParser';

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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleFiles = async (files: FileList | File[]) => {
    setIsProcessing(true);
    setErrorMessage(null);

    const newAccounts = [...accounts];
    const newTransactions = [...transactions];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = file.name.toLowerCase();

      try {
        if (name.endsWith('.xlsx') || name.endsWith('.csv')) {
          const { account, transactions: parsedTx } = await parseExcelBankStatement(file);
          newAccounts.push(account);
          newTransactions.push(...parsedTx);
        } else if (name.endsWith('.pdf')) {
          const { account, transactions: parsedTx } = await parsePdfBankStatement(file);
          newAccounts.push(account);
          newTransactions.push(...parsedTx);
        } else {
          setErrorMessage(`不支持的文件格式: ${file.name}，请上传 .xlsx、.csv 或文本型 .pdf 流水。`);
        }
      } catch (err: any) {
        console.error('Error parsing file:', file.name, err);
        setErrorMessage(`解析文件 ${file.name} 失败: ${err.message || '格式无法识别'}`);
      }
    }

    setIsProcessing(false);
    onDataUpdated(newAccounts, newTransactions);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
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
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
          Step 1 / 6 证据上传
        </span>
        <h2 className="text-xl font-bold text-slate-900 mt-2">多源银行流水批量拖拽与智能入库</h2>
        <p className="text-xs text-slate-500 mt-1">
          支持工行、农行、中行、建行、招行等多家银行的 .xlsx、CSV 与文本型 PDF 对账单。老式 .xls 请先另存为 .xlsx。
        </p>

        {/* Upload Zone */}
        <div
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={`mt-6 border-2 border-dashed rounded-2xl p-8 text-center transition-all ${
            isDragging
              ? 'border-blue-500 bg-blue-50/50'
              : 'border-slate-300 hover:border-blue-400 bg-slate-50/50'
          }`}
        >
          <div className="w-14 h-14 rounded-2xl bg-blue-100/70 text-blue-600 flex items-center justify-center mx-auto mb-4">
            <UploadCloud className="w-7 h-7" />
          </div>

          <h3 className="text-sm font-semibold text-slate-800">
            拖拽银行流水文件至此，或点击选择文件
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            支持 .xlsx / .csv / .pdf 格式（支持单次上传多份流水）
          </p>

          <label className="mt-4 inline-block">
            <span className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs cursor-pointer shadow-sm transition">
              {isProcessing ? '正在解析中...' : '选择电脑中的流水文件'}
            </span>
            <input
              type="file"
              multiple
              accept=".xlsx,.csv,.pdf"
              onChange={e => e.target.files && handleFiles(e.target.files)}
              className="hidden"
            />
          </label>
        </div>

        {errorMessage && (
          <div className="mt-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-700 flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}
      </div>

      {/* Uploaded Accounts Summary */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
            <span>已成功解析的银行卡账户</span>
            <span className="text-xs font-normal text-slate-400">（共 {accounts.length} 个账户，{transactions.length} 笔交易）</span>
          </h3>

          <label className="cursor-pointer text-xs font-medium text-blue-600 hover:text-blue-700 flex items-center space-x-1">
            <PlusCircle className="w-3.5 h-3.5" />
            <span>追加新流水文件</span>
            <input
              type="file"
              multiple
              accept=".xlsx,.csv,.pdf"
              onChange={e => e.target.files && handleFiles(e.target.files)}
              className="hidden"
            />
          </label>
        </div>

        {accounts.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-xs">
            暂无已导入的流水文件，请从上方拖拽上传。
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {accounts.map(acc => (
              <div
                key={acc.accountNumber}
                className="rounded-xl border border-slate-200/80 p-4 bg-slate-50/50 hover:bg-slate-50 transition space-y-3 relative group"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-2.5">
                    <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center">
                      {acc.fileType === 'pdf' ? (
                        <FileText className="w-4 h-4" />
                      ) : (
                        <FileSpreadsheet className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-800">{acc.bankName}</div>
                      <div className="text-[11px] text-slate-500 font-mono">{acc.accountNumber}</div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleRemoveAccount(acc.accountNumber)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                    title="移除该账户"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-200/60 text-[11px]">
                  <div>
                    <span className="text-slate-400 block">交易笔数</span>
                    <span className="font-semibold text-slate-700">{acc.transactionCount} 笔</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">总流入</span>
                    <span className="font-semibold text-emerald-600">¥{acc.totalIn.toLocaleString()}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block">总流出</span>
                    <span className="font-semibold text-rose-600">¥{acc.totalOut.toLocaleString()}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1">
                  <span>文件: {acc.fileName}</span>
                  <span className="flex items-center text-emerald-600 font-medium space-x-1">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>解析就绪</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between pt-6 mt-6 border-t border-slate-100">
          <button
            onClick={onPrev}
            className="flex items-center space-x-1.5 px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 text-xs font-medium transition"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>返回建档</span>
          </button>

          <button
            onClick={onNext}
            disabled={accounts.length === 0 || transactions.length === 0}
            className={`flex items-center space-x-2 px-6 py-2.5 rounded-xl font-medium text-sm transition ${
              accounts.length > 0 && transactions.length > 0
                ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-500/20'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            <span>下一步：证据确认与平账</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
