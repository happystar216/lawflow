import React, { useState, useEffect } from 'react';
import { UploadCloud, FileSpreadsheet, FileText, FileImage, CheckCircle2, ArrowRight, ArrowLeft, Trash2, PlusCircle, AlertCircle, Scan, ShieldCheck, Cloud, Key, Check } from 'lucide-react';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { parseExcelBankStatement } from '../parsers/excelParser';
import { parsePdfWithBaiduCloud, getBaiduCredentials, saveBaiduCredentials, BaiduCredentials } from '../parsers/baiduCloudOcr';

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
  const [ocrStatus, setOcrStatus] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  
  // Baidu Cloud OCR credentials state
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  useEffect(() => {
    const creds = getBaiduCredentials();
    if (creds) {
      setApiKey(creds.apiKey);
      setSecretKey(creds.secretKey);
    }
  }, []);

  const handleSaveKeys = () => {
    if (apiKey.trim() && secretKey.trim()) {
      saveBaiduCredentials(apiKey.trim(), secretKey.trim());
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2000);
    }
  };

  const handleFiles = async (files: FileList | File[]) => {
    const fileList = Array.from(files);
    if (fileList.length === 0) return;

    setIsProcessing(true);
    setErrorMessage(null);
    setOcrStatus(null);

    const newAccounts = [...accounts];
    const newTransactions = [...transactions];
    const creds: BaiduCredentials = {
      apiKey: apiKey.trim(),
      secretKey: secretKey.trim()
    };

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const name = file.name.toLowerCase();

      try {
        if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
          setOcrStatus(`正在解析 Excel 结构化流水: ${file.name}...`);
          const { account, transactions: parsedTx } = await parseExcelBankStatement(file);
          newAccounts.push(account);
          newTransactions.push(...parsedTx);
        } else if (name.endsWith('.pdf') || name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp') || name.endsWith('.bmp')) {
          setOcrStatus(`正在调用百度智能云官方 AI 模型解析: ${file.name}...`);
          const { account, transactions: parsedTx } = await parsePdfWithBaiduCloud(
            file,
            creds,
            (status: string, prog: number) => {
              setOcrStatus(`${status} (${Math.round(prog * 100)}%)`);
            }
          );
          newAccounts.push(account);
          newTransactions.push(...parsedTx);
        } else {
          setErrorMessage(`不支持的文件格式: ${file.name}，请上传 Excel、CSV、PDF 或扫描图片。`);
        }
      } catch (err: any) {
        console.error('Error processing file:', file.name, err);
        setErrorMessage(`解析文件 ${file.name} 失败: ${err.message || '格式无法识别'}`);
      }
    }

    setIsProcessing(false);
    setOcrStatus(null);
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
            <button
              onClick={() => setIsConfigOpen(!isConfigOpen)}
              className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 text-xs font-medium transition"
            >
              <Cloud className="w-3.5 h-3.5 text-blue-600" />
              <span>{apiKey && secretKey ? '百度智能云官方 OCR 已就绪' : '配置百度云 Key'}</span>
            </button>

            <span className="inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-medium">
              <ShieldCheck className="w-3 h-3 text-emerald-600" />
              <span>百度智能云官方高精引擎</span>
            </span>
          </div>
        </div>

        {/* Baidu Cloud Config Modal / Drawer */}
        {isConfigOpen && (
          <div className="mt-4 p-5 rounded-2xl bg-gradient-to-br from-blue-50/70 to-indigo-50/40 border border-blue-100 text-xs space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 font-bold text-slate-800">
                <Key className="w-4 h-4 text-blue-600" />
                <span>百度智能云官方 OCR 密钥设置</span>
              </div>
              <a
                href="https://console.bce.baidu.com/ai/#/ai/ocr/overview/index"
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline font-medium text-[11px]"
              >
                前往百度云控制台获取 Key →
              </a>
            </div>

            <p className="text-[11px] text-slate-500">
              系统直连<strong>百度官方最高精度 PaddleOCR 云集群</strong>，享受每月免费额度与高精度印章穿透。密钥保存在您的浏览器本地，绝不泄露给任何第三方。
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">API Key:</label>
                <input
                  type="text"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="从百度云应用列表复制"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-blue-500 font-mono bg-white"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">Secret Key:</label>
                <input
                  type="password"
                  value={secretKey}
                  onChange={e => setSecretKey(e.target.value)}
                  placeholder="从百度云应用列表复制"
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs focus:ring-2 focus:ring-blue-500 font-mono bg-white"
                />
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={handleSaveKeys}
                className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs flex items-center space-x-1 shadow-sm transition"
              >
                {isSaved ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>保存成功</span>
                  </>
                ) : (
                  <span>保存配置</span>
                )}
              </button>
            </div>
          </div>
        )}

        <h2 className="text-xl font-bold text-slate-900 mt-2">多源异构银行流水批量拖拽与智能解析</h2>
        <p className="text-xs text-slate-500 mt-1">
          支持工行、农行、中行、建行、光大、招行等多家银行标准/非标 Excel、CSV 电子对账单，以及<strong>多页扫描件 PDF / 纸质流水翻拍图像的百度官方高精度自动识别</strong>。
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
            支持 .xlsx / .xls / .csv / .pdf (电子版及扫描件) / 扫描图片 (.png, .jpg)
          </p>

          <label className="mt-4 inline-block">
            <span className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs cursor-pointer shadow-sm transition">
              {isProcessing ? '正在智能解析中...' : '选择电脑中的流水文件'}
            </span>
            <input
              type="file"
              multiple
              accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp,.bmp"
              onChange={e => e.target.files && handleFiles(Array.from(e.target.files))}
              className="hidden"
            />
          </label>

          {ocrStatus && (
            <div className="mt-4 inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-xs text-blue-700 animate-pulse">
              <Scan className="w-3.5 h-3.5" />
              <span>{ocrStatus}</span>
            </div>
          )}
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
              accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg,.webp,.bmp"
              onChange={e => e.target.files && handleFiles(Array.from(e.target.files))}
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
                      ) : acc.fileType === 'ocr' ? (
                        <FileImage className="w-4 h-4 text-purple-600" />
                      ) : (
                        <FileSpreadsheet className="w-4 h-4" />
                      )}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-800 flex items-center space-x-1.5">
                        <span>{acc.bankName}</span>
                        {acc.fileType === 'ocr' && (
                          <span className="px-1.5 py-0.2 rounded bg-purple-100 text-purple-700 text-[10px] font-medium">
                            百度云高精识别
                          </span>
                        )}
                      </div>
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
                  <span className="truncate max-w-[200px]">文件: {acc.fileName}</span>
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
            disabled={accounts.length === 0}
            className={`flex items-center space-x-2 px-6 py-2.5 rounded-xl font-medium text-sm transition ${
              accounts.length > 0
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
