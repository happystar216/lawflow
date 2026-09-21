import React, { useEffect, useState, useRef } from 'react';
import { UploadCloud, FileSpreadsheet, FileText, FileImage, CheckCircle2, ArrowRight, ArrowLeft, Trash2, PlusCircle, AlertCircle, ShieldCheck, Sparkles, StopCircle, RotateCcw, CircleSlash2, Scissors, X } from 'lucide-react';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { parseExcelBankStatement } from '../parsers/excelParser';
import { parsePdfWithGemini, GeminiProgressInfo } from '../parsers/geminiPdfParser';
import { deleteSourceDocument, saveSourceDocument } from '../store/sourceDocumentStore';
import { accountIdentityKey, transactionBelongsToAccount } from '../utils/accountIdentity';
import { importErrorForUser } from '../utils/userFacingError';
import { attachSourceProvenance, createExtractionRun, identifySourceDocument, sourceFilesWithoutTransactions, sourceIdentity, transactionCountsBySource } from '../utils/evidenceProvenance';
import { publishAutomationImportState } from '../debug/automationBridge';
import { normalizeRecognizedData } from '../utils/recognizedDataNormalizer';
import { businessAccounts, incompleteRecognitionPages, isDocumentReviewAccount } from '../review/recognitionCompleteness';
import {
  createBankSplitFiles,
  getRecognitionSplitMetadata,
  isPageRecommendedForRecognition,
  PdfBankSplitPlan,
  PdfPageClassification,
  parsePageSelection,
  preparePdfBankSplitPlan,
  releasePdfSplitPlanPreviews,
  validateBankGroups
} from '../parsers/pdfBankSplitter';

interface Step1Props {
  caseId: string;
  caseRespondentName?: string;
  accounts: BankAccount[];
  transactions: StandardTransaction[];
  onDataUpdated: (accounts: BankAccount[], transactions: StandardTransaction[]) => void;
  onNext: () => void;
  onPrev: () => void;
}

type ImportTaskStatus = 'QUEUED' | 'PROCESSING' | 'SUCCESS' | 'WARNING' | 'EMPTY' | 'ERROR' | 'CANCELLED';

interface ImportTask {
  id: string;
  file: File;
  status: ImportTaskStatus;
  title: string;
  message?: string;
  impact?: string;
  details?: string;
  retryable?: boolean;
  transactionCount?: number;
  accountCount?: number;
  diagnosticCode?: string;
  diagnosis?: string;
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

function pageTypeLabel(type: PdfPageClassification['pageType']): string {
  return PAGE_TYPE_OPTIONS.find(option => option.value === type)?.label || '待确认';
}

function importTaskId(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export const Step1Upload: React.FC<Step1Props> = ({
  caseId,
  caseRespondentName,
  accounts,
  transactions,
  onDataUpdated,
  onNext,
  onPrev
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressInfo, setProgressInfo] = useState<GeminiProgressInfo | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCancellable, setIsCancellable] = useState(false);
  const [importTasks, setImportTasks] = useState<ImportTask[]>([]);
  const [pendingPdfPlans, setPendingPdfPlans] = useState<PdfBankSplitPlan[]>([]);
  const [splitValidationErrors, setSplitValidationErrors] = useState<Record<string, string[]>>({});
  const [activePreviewPages, setActivePreviewPages] = useState<Record<string, number>>({});

  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingPdfPlansRef = useRef<PdfBankSplitPlan[]>([]);
  const zeroTransactionFiles = sourceFilesWithoutTransactions(accounts, transactions);
  const sourceTransactionCounts = transactionCountsBySource(transactions);
  const hasTransactions = transactions.length > 0;
  const visibleAccounts = businessAccounts(accounts);
  const importedFileGroups = Array.from(accounts.reduce((groups, account) => {
    const key = sourceIdentity(account);
    const current = groups.get(key) || [];
    current.push(account);
    groups.set(key, current);
    return groups;
  }, new Map<string, BankAccount[]>()).entries());

  const updateImportTask = (id: string, patch: Partial<ImportTask>) => {
    setImportTasks(current => current.map(task => task.id === id ? { ...task, ...patch } : task));
  };

  useEffect(() => {
    if (!isProcessing) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [isProcessing]);

  useEffect(() => {
    pendingPdfPlansRef.current = pendingPdfPlans;
  }, [pendingPdfPlans]);

  useEffect(() => () => {
    pendingPdfPlansRef.current.forEach(releasePdfSplitPlanPreviews);
  }, []);

  useEffect(() => {
    publishAutomationImportState({
      isProcessing,
      statusText,
      progress: progressInfo ? {
        percent: progressInfo.percent,
        totalTransactions: progressInfo.totalTransactions,
        statusText: progressInfo.statusText,
        currentBank: progressInfo.currentBank
      } : null,
      tasks: importTasks.map(task => ({
        id: task.id,
        fileName: task.file.name,
        status: task.status,
        title: task.title,
        message: task.message,
        impact: task.impact,
        details: task.details,
        transactionCount: task.transactionCount,
        accountCount: task.accountCount,
        diagnosticCode: task.diagnosticCode,
        diagnosis: task.diagnosis
      })),
      pdfSplitPlans: pendingPdfPlans.map(plan => ({
        fileName: plan.sourceFile.name,
        totalPages: plan.totalPages,
        groups: plan.groups.map(group => ({ bankName: group.bankName, pageSelection: group.pageSelection })),
        pages: plan.pages.map(page => ({
          page: page.page,
          pageType: page.pageType,
          bankName: page.assignedBankName,
          selectedForRecognition: page.selectedForRecognition
        })),
        validationErrors: splitValidationErrors[plan.id] || []
      }))
    });
  }, [isProcessing, statusText, progressInfo, importTasks, pendingPdfPlans, splitValidationErrors]);

  const handleCancelProcessing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStatusText('正在停止当前文件解析…');
  };

  const processFiles = async (files: FileList | File[]) => {
    if (isProcessing) {
      setErrorMessage('当前文件仍在处理中，请等待完成或停止后再添加文件。');
      return;
    }
    const fileList = Array.from(files);
    if (fileList.length === 0) return;

    setImportTasks(current => {
      const next = new Map(current.map(task => [task.id, task]));
      for (const file of fileList) {
        const id = importTaskId(file);
        next.set(id, { id, file, status: 'QUEUED', title: `等待识别“${file.name}”` });
      }
      return [...next.values()];
    });

    setIsProcessing(true);
    setErrorMessage(null);
    setProgressInfo(null);
    setStatusText(null);

    const newAccounts = [...accounts];
    const newTransactions = [...transactions];
    let wasCancelled = false;

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const name = file.name.toLowerCase();
      const taskId = importTaskId(file);
      updateImportTask(taskId, {
        status: 'PROCESSING',
        title: `正在识别“${file.name}”`,
        message: '识别完成前请保持当前页面打开。',
        impact: undefined,
        details: undefined,
        retryable: undefined
      });

      try {
        let importedTransactionCount = 0;
        let importedAccountCount = 0;
        let incompletePages: number[] = [];
        let sourceStorageWarning = false;
        setStatusText(`正在校验原始文件“${file.name}”…`);
        const source = await identifySourceDocument(file);
        const extractionRun = createExtractionRun(source.documentId);
        const removePreviousVersion = () => {
          for (let index = newAccounts.length - 1; index >= 0; index -= 1) {
            const existing = newAccounts[index];
            const sameSource = existing.sourceDocumentId
              ? existing.sourceDocumentId === source.documentId
              : existing.fileName === file.name;
            if (sameSource) newAccounts.splice(index, 1);
          }
          for (let index = newTransactions.length - 1; index >= 0; index -= 1) {
            const existing = newTransactions[index];
            const sameSource = existing.sourceDocumentId
              ? existing.sourceDocumentId === source.documentId
              : existing.rawSourceFile === file.name;
            if (sameSource) newTransactions.splice(index, 1);
          }
        };
        if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
          setStatusText(`正在读取电子流水“${file.name}”…`);
          const { account, transactions: parsedTx } = await parseExcelBankStatement(file);
          try {
            await saveSourceDocument(caseId, file, source);
          } catch (storageError) {
            sourceStorageWarning = true;
            console.warn('Source document storage unavailable; continuing recognition', storageError);
          }
          const annotated = attachSourceProvenance([account], parsedTx, source, extractionRun);
          const canonical = normalizeRecognizedData(annotated.accounts, annotated.transactions);
          removePreviousVersion();
          newAccounts.push(...canonical.accounts);
          newTransactions.push(...canonical.transactions);
          importedTransactionCount = canonical.transactions.length;
          importedAccountCount = businessAccounts(canonical.accounts).length;
        } else if (name.endsWith('.pdf')) {
          const splitMetadata = getRecognitionSplitMetadata(file);
          const controller = new AbortController();
          abortControllerRef.current = controller;
          setIsCancellable(true);
          const { accounts: parsedAccounts, transactions: parsedTx } = await parsePdfWithGemini(
            file,
            (info: GeminiProgressInfo) => {
              setProgressInfo(info);
              if (info.statusText) setStatusText(info.statusText);
            },
            controller.signal,
            {
              respondentName: caseRespondentName,
              sourceContentHash: source.contentHash,
              sourcePageNumbers: splitMetadata?.sourcePageNumbers,
              sourceTotalPages: splitMetadata?.sourceTotalPages
            }
          );
          let sourceStored = true;
          try {
            // Replace the retained original only after recognition succeeds, so a
            // failed same-name retry cannot leave old rows pointing at a new PDF.
            await saveSourceDocument(caseId, file, source);
          } catch (storageError) {
            sourceStored = false;
            sourceStorageWarning = true;
            console.warn('Source document storage unavailable; continuing recognition', storageError);
          }
          const annotated = attachSourceProvenance(parsedAccounts, parsedTx, source, extractionRun);
          const canonical = normalizeRecognizedData(annotated.accounts, annotated.transactions);
          removePreviousVersion();
          newAccounts.push(...canonical.accounts.map(account => sourceStored ? account : {
            ...account,
            parseStatus: account.parseStatus === 'INCOMPLETE' ? 'INCOMPLETE' as const : 'NEEDS_REVIEW' as const,
            parseWarnings: [...new Set([...(account.parseWarnings || []), '原始文件未能持久保存，请在本次会话中完成原件核对或重新上传'])]
          }));
          newTransactions.push(...canonical.transactions);
          importedTransactionCount = canonical.transactions.length;
          importedAccountCount = businessAccounts(canonical.accounts).length;
          incompletePages = incompleteRecognitionPages(canonical.accounts);
        } else {
          throw new Error('不支持的文件格式');
        }
        updateImportTask(taskId, importedTransactionCount === 0 ? {
          status: 'EMPTY',
          title: `“${file.name}”未发现流水`,
          message: '请确认原件是否确实没有交易明细，或检查页面方向和清晰度后重新识别。',
          impact: '文件中的账户信息已保留，但不会计入后续资金分析。',
          retryable: true,
          transactionCount: 0,
          accountCount: importedAccountCount
        } : incompletePages.length ? {
          status: 'WARNING',
          title: `“${file.name}”仅完成部分识别`,
          message: `已保留 ${importedTransactionCount} 笔流水和 ${importedAccountCount} 个账户，但仍有 ${incompletePages.length} 页未能可靠识别。`,
          impact: `未完成页面：第 ${incompletePages.join('、')} 页。请点击“重新识别”自动补齐；补齐或人工录入前不能进入资金分析。`,
          retryable: true,
          transactionCount: importedTransactionCount,
          accountCount: importedAccountCount,
          diagnosticCode: 'PDF_INCOMPLETE_PAGES',
          diagnosis: '识别服务在这些页面连续失败。已成功页面已经缓存，重新识别时会优先补偿失败页。'
        } : sourceStorageWarning ? {
          status: 'WARNING',
          title: `“${file.name}”已导入，但原件未保存`,
          message: `已读取 ${importedTransactionCount} 笔流水，但浏览器未能保存原始文件。`,
          impact: '交易可以继续分析，但刷新页面后可能无法打开原件对照。建议释放浏览器存储空间后重新上传。',
          retryable: true,
          transactionCount: importedTransactionCount,
          accountCount: importedAccountCount
        } : {
          status: 'SUCCESS',
          title: `“${file.name}”已导入`,
          message: `共读取 ${importedTransactionCount} 笔流水，识别出 ${importedAccountCount} 个账户。`,
          transactionCount: importedTransactionCount,
          accountCount: importedAccountCount
        });
      } catch (err: any) {
        if (err.name === 'AbortError' || err.message?.includes('停止')) {
          console.log('User cancelled parsing:', file.name);
          updateImportTask(taskId, {
            status: 'CANCELLED',
            title: `已停止识别“${file.name}”`,
            message: '该文件没有导入，案件中原有数据未受影响。',
            retryable: true
          });
          for (const unprocessed of fileList.slice(i + 1)) {
            updateImportTask(importTaskId(unprocessed), {
              status: 'CANCELLED',
              title: `尚未识别“${unprocessed.name}”`,
              message: '本批次已停止，可以单独重新识别该文件。',
              retryable: true
            });
          }
          wasCancelled = true;
          break;
        }
        console.error('Error processing file:', file.name, err);
        const friendly = importErrorForUser(err, file.name);
        updateImportTask(taskId, {
          status: 'ERROR',
          title: friendly.title,
          message: friendly.message,
          impact: friendly.impact,
          details: friendly.details,
          retryable: friendly.retryable,
          diagnosticCode: friendly.diagnosticCode,
          diagnosis: friendly.diagnosis
        });
      } finally {
        abortControllerRef.current = null;
        setIsCancellable(false);
      }
    }

    setIsProcessing(false);
    setProgressInfo(null);
    setStatusText(wasCancelled ? '已停止解析，未完成的文件没有导入。' : null);
    onDataUpdated(newAccounts, newTransactions);
  };

  const preparePdfPlans = async (files: File[]) => {
    if (!files.length) return;
    setIsProcessing(true);
    setErrorMessage(null);
    setProgressInfo(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsCancellable(true);
    try {
      for (const [fileIndex, file] of files.entries()) {
        setStatusText(`正在扫描“${file.name}”的银行和页码…`);
        const plan = await preparePdfBankSplitPlan(file, (message, completedPages, totalPages) => {
          const fileBase = fileIndex / files.length;
          const fileProgress = totalPages ? completedPages / totalPages / files.length : 0;
          setProgressInfo({
            statusText: message,
            totalTransactions: 0,
            percent: Math.min(99, Math.round((fileBase + fileProgress) * 100)),
            isStreaming: true
          });
          setStatusText(message);
        }, controller.signal);
        setPendingPdfPlans(current => {
          const next = new Map(current.map(item => [item.id, item]));
          const previous = next.get(plan.id);
          if (previous) releasePdfSplitPlanPreviews(previous);
          next.set(plan.id, plan);
          return [...next.values()];
        });
      }
    } catch (error) {
      if (controller.signal.aborted) setStatusText('已停止 PDF 分拣，尚未开始识别。');
      else setErrorMessage(`PDF 分拣失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      abortControllerRef.current = null;
      setIsCancellable(false);
      setIsProcessing(false);
      setProgressInfo(null);
      if (!controller.signal.aborted) setStatusText(null);
    }
  };

  const handleFiles = async (files: FileList | File[]) => {
    if (isProcessing) {
      setErrorMessage('当前文件仍在处理中，请等待完成或停止后再添加文件。');
      return;
    }
    const selected = Array.from(files);
    const pdfFiles = selected.filter(file => file.name.toLowerCase().endsWith('.pdf'));
    const electronicFiles = selected.filter(file => !file.name.toLowerCase().endsWith('.pdf'));
    if (electronicFiles.length) await processFiles(electronicFiles);
    if (pdfFiles.length) await preparePdfPlans(pdfFiles);
  };

  const updatePdfGroup = (planId: string, groupId: string, patch: { bankName?: string; pageSelection?: string }) => {
    setPendingPdfPlans(current => current.map(plan => plan.id !== planId ? plan : {
      ...plan,
      groups: plan.groups.map(group => group.id === groupId ? { ...group, ...patch } : group)
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const updatePdfPageType = (
    planId: string,
    pageNumber: number,
    pageType: PdfPageClassification['pageType']
  ) => {
    setPendingPdfPlans(current => current.map(plan => plan.id !== planId ? plan : {
      ...plan,
      pages: plan.pages.map(page => {
        if (page.page !== pageNumber) return page;
        const suggestedForRecognition = isPageRecommendedForRecognition(pageType);
        return {
          ...page,
          pageType,
          suggestedForRecognition,
          selectedForRecognition: page.selectionModifiedByUser
            ? page.selectedForRecognition
            : suggestedForRecognition
        };
      })
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const togglePdfPageSelection = (planId: string, pageNumber: number) => {
    setPendingPdfPlans(current => current.map(plan => plan.id !== planId ? plan : {
      ...plan,
      pages: plan.pages.map(page => page.page === pageNumber ? {
        ...page,
        selectedForRecognition: !page.selectedForRecognition,
        selectionModifiedByUser: true
      } : page)
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const applySuggestedPageSelection = (planId: string, pageNumbers?: number[]) => {
    const targetPages = pageNumbers ? new Set(pageNumbers) : null;
    setPendingPdfPlans(current => current.map(plan => plan.id !== planId ? plan : {
      ...plan,
      pages: plan.pages.map(page => !targetPages || targetPages.has(page.page) ? {
        ...page,
        selectedForRecognition: page.suggestedForRecognition,
        selectionModifiedByUser: false
      } : page)
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const addPdfGroup = (planId: string) => {
    setPendingPdfPlans(current => current.map(plan => plan.id !== planId ? plan : {
      ...plan,
      groups: [...plan.groups, {
        id: `MANUAL_${Date.now()}_${plan.groups.length + 1}`,
        bankName: '',
        suggestedBankName: '',
        pages: [],
        pageSelection: '',
        confidence: 1,
        pageTypes: []
      }]
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const removePdfGroup = (planId: string, groupId: string) => {
    setPendingPdfPlans(current => current.map(plan => plan.id !== planId ? plan : {
      ...plan,
      groups: plan.groups.filter(group => group.id !== groupId)
    }));
    setSplitValidationErrors(current => ({ ...current, [planId]: [] }));
  };

  const discardPdfPlan = (planId: string) => {
    setPendingPdfPlans(current => {
      current.filter(plan => plan.id === planId).forEach(releasePdfSplitPlanPreviews);
      return current.filter(plan => plan.id !== planId);
    });
    setSplitValidationErrors(current => {
      const next = { ...current };
      delete next[planId];
      return next;
    });
  };

  const confirmPdfPlans = async () => {
    const errors = Object.fromEntries(pendingPdfPlans.map(plan => [
      plan.id,
      validateBankGroups(plan.groups, plan.totalPages, plan.pages)
    ]));
    setSplitValidationErrors(errors);
    if (Object.values(errors).some(items => items.length)) {
      setErrorMessage('分拣方案仍有未确认、漏页或重复页，请按红色提示修改后再开始识别。');
      return;
    }
    setErrorMessage(null);
    setIsProcessing(true);
    setStatusText('正在生成各银行独立 PDF…');
    try {
      const splitFiles: File[] = [];
      for (const plan of pendingPdfPlans) splitFiles.push(...await createBankSplitFiles(plan));
      pendingPdfPlans.forEach(releasePdfSplitPlanPreviews);
      setPendingPdfPlans([]);
      setSplitValidationErrors({});
      setIsProcessing(false);
      setStatusText(null);
      await processFiles(splitFiles);
    } catch (error) {
      setIsProcessing(false);
      setStatusText(null);
      setErrorMessage(`无法生成银行分文件：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isProcessing) {
      setErrorMessage('当前文件仍在处理中，请等待完成或停止后再添加文件。');
      return;
    }
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleRemoveSourceFile = async (sourceKey: string, fileName: string) => {
    const sourceAccounts = accounts.filter(account => sourceIdentity(account) === sourceKey);
    if (!sourceAccounts.length) return;
    const sourceAccountCount = businessAccounts(sourceAccounts).length;
    if (!window.confirm(`确定删除来源文件“${fileName}”及其识别出的 ${sourceAccountCount} 个账户吗？重新上传时将从头识别。`)) return;
    const updatedAccounts = accounts.filter(account => sourceIdentity(account) !== sourceKey);
    const updatedTransactions = transactions.filter(transaction => transaction.sourceDocumentId
      ? sourceIdentity(transaction) !== sourceKey
      : transaction.rawSourceFile
        ? transaction.rawSourceFile !== fileName
        : !sourceAccounts.some(account => transactionBelongsToAccount(transaction, account)));
    await deleteSourceDocument(caseId, fileName, sourceAccounts[0].sourceDocumentId);
    onDataUpdated(updatedAccounts, updatedTransactions);
    setStatusText(`已删除 ${fileName} 的识别结果`);
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
              <span>智能识别与结构化提取</span>
            </span>

            <span className="inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-medium">
              <ShieldCheck className="w-3 h-3 text-emerald-600" />
              <span>长卷宗结构化提取与人工复核</span>
            </span>
          </div>
        </div>

        <h1 className="text-2xl font-bold text-slate-900 mt-3">
          上传银行流水证据文件
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Excel/CSV 会直接读取；PDF 会先按银行和页码生成分拣方案，经你确认后再分别识别。完成后请对照原件复核。
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
          accept=".xlsx,.xls,.csv,.pdf"
          onChange={(event) => {
            const selectedFiles = event.currentTarget.files
              ? Array.from(event.currentTarget.files)
              : [];
            event.currentTarget.value = '';
            if (selectedFiles.length) handleFiles(selectedFiles);
          }}
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
              支持格式：.xlsx、.xls、.csv、.pdf（识别完成后可按原件页码核对）
            </p>
          </div>

          {isProcessing && (
            <div className="w-full max-w-lg bg-blue-50/90 border border-blue-200 rounded-2xl p-5 text-left space-y-3 mt-4 shadow-sm">
              <div className="flex items-center justify-between text-blue-900 font-semibold text-sm">
                <div className="flex items-center space-x-2">
                  <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  <span className="truncate">{statusText || '正在准备识别文件...'}</span>
                </div>
                <div className="flex items-center space-x-2">
                  {progressInfo && (
                    <span className="text-xs font-mono font-bold text-blue-700 bg-blue-100/80 px-2 py-0.5 rounded-full flex-shrink-0">
                      {progressInfo.percent}%
                    </span>
                  )}
                  {isCancellable && (
                    <button
                      type="button"
                      onClick={handleCancelProcessing}
                      className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg border border-red-200 bg-white hover:bg-red-50 text-red-600 text-xs font-medium transition shadow-xs"
                      title="中止当前识别任务"
                    >
                      <StopCircle className="w-3.5 h-3.5" />
                      <span>停止</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Real-time Streaming Progress Bar */}
              {progressInfo && (
                <div className="space-y-2">
                  <div className="w-full h-2.5 bg-blue-200/60 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-blue-600 to-indigo-600 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${Math.max(progressInfo.percent, 3)}%` }}
                    />
                  </div>
                  <div className="flex justify-between items-center text-[11px] text-slate-600 font-medium pt-0.5">
                    <div className="flex items-center space-x-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                      <span><strong>{pendingPdfPlans.length ? '正在处理文件' : '正在扫描或识别文件'}</strong></span>
                      {progressInfo.currentBank && (
                        <span className="ml-1 px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 text-[10px] font-semibold">
                          {progressInfo.currentBank}
                        </span>
                      )}
                    </div>
                    <span>
                      当前已读取约：<strong className="text-emerald-700 text-xs">{progressInfo.totalTransactions}</strong> 笔
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {errorMessage && (
            <div role="status" className="flex items-center space-x-2 text-amber-800 bg-amber-50 border border-amber-200 px-4 py-2 rounded-xl text-xs mt-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>
      </div>

      {pendingPdfPlans.length > 0 && (
        <div className="bg-white rounded-2xl border border-blue-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 bg-blue-50/80 border-b border-blue-200 flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-xl bg-blue-100 text-blue-700">
                <Scissors className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">确认 PDF 分拣方案</h2>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  系统已按原文件顺序划分连续页段，并逐页标注内容类型。请确认银行、连续页码和标成“待确认”的页面；确认后才会分别识别流水。
                </p>
              </div>
            </div>
            <span className="text-[11px] font-medium text-blue-700 bg-white border border-blue-200 rounded-full px-2.5 py-1 flex-shrink-0">
              待确认 {pendingPdfPlans.length} 个原文件
            </span>
          </div>

          <div className="p-5 space-y-5">
            {pendingPdfPlans.map(plan => {
              const planErrors = splitValidationErrors[plan.id] || [];
              return (
                <section key={plan.id} className="rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900 truncate" title={plan.sourceFile.name}>{plan.sourceFile.name}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">共 {plan.totalPages} 页 · 建议拆成 {plan.groups.length} 个连续文档段</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => discardPdfPlan(plan.id)}
                      disabled={isProcessing}
                      className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-rose-600 px-2 py-1.5 rounded-lg hover:bg-rose-50 disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      移除
                    </button>
                  </div>

                  <div className="p-4 space-y-3">
                    {plan.groups.map((group, groupIndex) => {
                      let selectedPages = group.pages;
                      try {
                        const parsed = parsePageSelection(group.pageSelection, plan.totalPages);
                        if (parsed.length) selectedPages = parsed;
                      } catch {
                        // Keep showing the original proposal while the user is editing an invalid range.
                      }
                      const pageDetails = selectedPages.map(pageNumber => plan.pages.find(page => page.page === pageNumber))
                        .filter((page): page is PdfPageClassification => Boolean(page));
                      const previewKey = `${plan.id}:${group.id}`;
                      const activePage = pageDetails.find(page => page.page === activePreviewPages[previewKey])
                        || pageDetails.find(page => page.pageType === 'UNKNOWN')
                        || pageDetails.find(page => page.selectedForRecognition)
                        || pageDetails[0];
                      const selectedCount = pageDetails.filter(page => page.selectedForRecognition).length;
                      return (
                        <div key={group.id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                          <div className="px-3.5 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-3">
                            <div>
                              <span className="text-xs font-semibold text-slate-800">连续页段 {groupIndex + 1}</span>
                              <span className="ml-2 text-[11px] text-slate-500">原第 {group.pageSelection || '—'} 页</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => removePdfGroup(plan.id, group.id)}
                              disabled={plan.groups.length === 1 || isProcessing}
                              className="w-8 h-8 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-30"
                              title={plan.groups.length === 1 ? '至少保留一个连续页段' : `删除连续页段 ${groupIndex + 1}`}
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>

                          <div className="p-3.5 space-y-3">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <label className="space-y-1">
                                <span className="text-[11px] font-medium text-slate-600">所属银行</span>
                                <input
                                  value={group.bankName}
                                  onChange={event => updatePdfGroup(plan.id, group.id, { bankName: event.target.value })}
                                  placeholder="例如：中国工商银行"
                                  className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-200 ${/待确认|待核验|未知/.test(group.bankName) || !group.bankName.trim() ? 'border-amber-300 bg-amber-50' : 'border-slate-300 bg-white'}`}
                                />
                                {group.bankName === group.suggestedBankName && group.confidence < 0.55 && (
                                  <span className="block text-[10px] text-amber-700">银行名称把握较低，请对照原件确认</span>
                                )}
                              </label>
                              <label className="space-y-1">
                                <span className="text-[11px] font-medium text-slate-600">连续原文件页码</span>
                                <input
                                  value={group.pageSelection}
                                  onChange={event => updatePdfGroup(plan.id, group.id, { pageSelection: event.target.value })}
                                  placeholder="例如：1-12"
                                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-blue-200"
                                />
                                <span className="block text-[10px] text-slate-400">每个页段必须连续，例如“1-12”；不能填写“1-3,20-25”</span>
                              </label>
                            </div>

                            <div className="space-y-3">
                              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                                <div>
                                  <div className="text-[11px] font-medium text-slate-700">逐页预览与识别范围</div>
                                  <div className="text-[10px] text-slate-400 mt-0.5">已选择 {selectedCount}/{pageDetails.length} 页；未选择的页面仍保留在原文件中，但不进入下一步识别</div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => applySuggestedPageSelection(plan.id, pageDetails.map(page => page.page))}
                                  className="self-start sm:self-auto text-[11px] font-medium text-blue-600 hover:text-blue-700 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1.5"
                                >
                                  恢复系统建议
                                </button>
                              </div>

                              {activePage && (
                                <div className="rounded-2xl bg-slate-950 p-3 sm:p-4 shadow-inner">
                                  <div className="relative min-h-[300px] sm:min-h-[430px] flex items-center justify-center overflow-hidden rounded-xl bg-slate-900">
                                    {activePage.thumbnailUrl ? (
                                      <img
                                        src={activePage.thumbnailUrl}
                                        alt={`原 PDF 第 ${activePage.page} 页预览`}
                                        className="max-h-[520px] max-w-full object-contain shadow-2xl transition-all duration-200"
                                      />
                                    ) : (
                                      <div className="text-xs text-slate-400">第 {activePage.page} 页预览暂不可用</div>
                                    )}
                                    <div className="absolute left-3 top-3 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur">
                                      原第 {activePage.page} 页
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => togglePdfPageSelection(plan.id, activePage.page)}
                                      className={`absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold shadow-lg backdrop-blur transition ${activePage.selectedForRecognition ? 'bg-blue-600 text-white' : 'bg-white/90 text-slate-700'}`}
                                    >
                                      {activePage.selectedForRecognition ? <CheckCircle2 className="w-3.5 h-3.5" /> : <CircleSlash2 className="w-3.5 h-3.5" />}
                                      {activePage.selectedForRecognition ? '进入识别' : '不进入识别'}
                                    </button>
                                  </div>

                                  <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl bg-white/10 px-3 py-2.5">
                                    <div className="min-w-0 flex-1">
                                      <div className="text-xs font-semibold text-white">第 {activePage.page} 页 · {pageTypeLabel(activePage.pageType)}</div>
                                      <div className="text-[10px] text-slate-300 mt-0.5">
                                        系统建议：{activePage.suggestedForRecognition ? '进入识别' : '不进入识别'}
                                        {activePage.confidence < 0.55 ? ' · 页面类型把握较低，请人工确认' : ''}
                                      </div>
                                    </div>
                                    <select
                                      value={activePage.pageType}
                                      onChange={event => updatePdfPageType(plan.id, activePage.page, event.target.value as PdfPageClassification['pageType'])}
                                      aria-label={`第 ${activePage.page} 页内容类型`}
                                      className={`rounded-lg border px-3 py-2 text-xs outline-none ${activePage.pageType === 'UNKNOWN' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-white/20 bg-white text-slate-800'}`}
                                    >
                                      {PAGE_TYPE_OPTIONS.map(option => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                              )}

                              <div className="overflow-x-auto pb-2">
                                <div className="flex min-w-max items-end gap-2 px-1 pt-1">
                                  {pageDetails.map(page => {
                                    const isActive = activePage?.page === page.page;
                                    return (
                                      <button
                                        key={page.page}
                                        type="button"
                                        onClick={() => setActivePreviewPages(current => ({ ...current, [previewKey]: page.page }))}
                                        className={`group relative w-[76px] flex-shrink-0 rounded-xl border-2 p-1.5 text-left transition-all duration-200 ${isActive ? 'border-blue-500 bg-blue-50 -translate-y-1 shadow-lg' : 'border-transparent bg-slate-100 hover:border-slate-300'} ${page.selectedForRecognition ? '' : 'opacity-55'}`}
                                        aria-label={`查看第 ${page.page} 页，${pageTypeLabel(page.pageType)}，${page.selectedForRecognition ? '进入识别' : '不进入识别'}`}
                                      >
                                        <div className="aspect-[3/4] overflow-hidden rounded-lg bg-white shadow-sm">
                                          {page.thumbnailUrl ? (
                                            <img src={page.thumbnailUrl} alt="" className="h-full w-full object-cover object-top" />
                                          ) : (
                                            <div className="h-full w-full flex items-center justify-center text-[9px] text-slate-400">无预览</div>
                                          )}
                                        </div>
                                        <div className="mt-1 truncate text-[9px] font-medium text-slate-700">第 {page.page} 页</div>
                                        <div className={`truncate text-[8px] ${page.pageType === 'UNKNOWN' ? 'text-amber-700' : 'text-slate-500'}`}>{pageTypeLabel(page.pageType)}</div>
                                        <span className={`absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-white ${page.selectedForRecognition ? 'bg-blue-600 text-white' : 'bg-slate-400 text-white'}`}>
                                          {page.selectedForRecognition ? <CheckCircle2 className="w-3 h-3" /> : <X className="w-2.5 h-2.5" />}
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      onClick={() => addPdfGroup(plan.id)}
                      disabled={isProcessing}
                      className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
                    >
                      <PlusCircle className="w-4 h-4" />
                      添加连续页段
                    </button>

                    {planErrors.length > 0 && (
                      <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-900 space-y-1">
                        {planErrors.map(error => <div key={error}>• {error}</div>)}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
              <p className="text-[11px] text-slate-500 leading-relaxed">
                确认时会检查 1 到末页是否全部归类、没有重复且每段连续。同一银行在后文再次出现时仍保留为新的连续页段；只有勾选的原生 PDF 页面进入识别，不会把缩略图当作识别原件。
              </p>
              <button
                type="button"
                onClick={confirmPdfPlans}
                disabled={isProcessing || pendingPdfPlans.length === 0}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shadow-sm disabled:opacity-50 flex-shrink-0"
              >
                <CheckCircle2 className="w-4 h-4" />
                确认分拣并开始识别
              </button>
            </div>
          </div>
        </div>
      )}

      {zeroTransactionFiles.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-950">
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold">
              {zeroTransactionFiles.length} 个文件未识别到流水明细
            </div>
            <p className="text-xs mt-1 leading-relaxed">
              这些文件已保留，但不会计入后续资金分析，也不能单独进入下一步。请确认原件是否确实无交易；如有流水，请点击下方“重新识别”，或删除后上传更清晰的文件。
            </p>
            <p className="text-[11px] mt-2 text-amber-800 break-all">
              {zeroTransactionFiles.join('、')}
            </p>
          </div>
        </div>
      )}

      {importTasks.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">本次文件处理结果</h2>
            <p className="text-[11px] text-slate-500 mt-1">每个文件单独处理；某个文件失败不会影响其他文件或案件中已有数据。</p>
          </div>
          <div className="space-y-2">
            {importTasks.map(task => {
              const isFailure = task.status === 'ERROR';
              const isWarning = task.status === 'WARNING' || task.status === 'EMPTY';
              const isActive = task.status === 'PROCESSING' || task.status === 'QUEUED';
              return (
                <div
                  key={task.id}
                  role={isFailure ? 'alert' : undefined}
                  className={`rounded-xl border p-3 ${isFailure ? 'border-rose-200 bg-rose-50' : isWarning ? 'border-amber-200 bg-amber-50' : task.status === 'SUCCESS' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2 min-w-0">
                      {isActive ? (
                        <span className="mt-0.5 w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      ) : task.status === 'SUCCESS' ? (
                        <CheckCircle2 className="w-4 h-4 mt-0.5 text-emerald-600 flex-shrink-0" />
                      ) : task.status === 'CANCELLED' ? (
                        <CircleSlash2 className="w-4 h-4 mt-0.5 text-slate-500 flex-shrink-0" />
                      ) : (
                        <AlertCircle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${isFailure ? 'text-rose-600' : 'text-amber-600'}`} />
                      )}
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900 break-all">{task.title}</div>
                        {task.message && <p className="text-[11px] text-slate-700 mt-1 leading-relaxed">{task.message}</p>}
                        {task.impact && <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{task.impact}</p>}
                        {task.diagnosis && (
                          <div className="mt-2 rounded-lg border border-rose-200 bg-white/80 p-2 text-[11px] leading-relaxed text-rose-900">
                            <div className="font-semibold">具体诊断{task.diagnosticCode ? ` · ${task.diagnosticCode}` : ''}</div>
                            <div className="mt-1">{task.diagnosis}</div>
                          </div>
                        )}
                        {task.details && (
                          <details className="mt-2 text-[10px] text-slate-500">
                            <summary className="cursor-pointer select-none">查看错误详情</summary>
                            <div className="mt-1 rounded-lg bg-white/70 border border-slate-200 p-2 break-all font-mono">{task.details}</div>
                          </details>
                        )}
                      </div>
                    </div>
                    {task.retryable && !isActive && (
                      <button
                        type="button"
                        onClick={() => task.file.type === 'application/pdf'
                          ? processFiles([task.file])
                          : handleFiles([task.file])}
                        disabled={isProcessing}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 text-[11px] font-medium disabled:opacity-50 flex-shrink-0"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        重新识别
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Uploaded Accounts List */}
      {accounts.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div className="flex items-center space-x-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              <h2 className="text-base font-semibold text-slate-900">
                已导入文件 ({importedFileGroups.length}) · 账户 ({visibleAccounts.length})
              </h2>
            </div>
            <span className="text-xs text-slate-500">
              共计 {transactions.length} 笔流水记录 · 数据保存在当前浏览器
            </span>
          </div>

          <div className="space-y-4">
            {importedFileGroups.map(([sourceKey, fileAccounts]) => {
              const firstAccount = fileAccounts[0];
              const fileName = firstAccount.fileName;
              const fileTransactionCount = sourceTransactionCounts.get(sourceKey) || 0;
              const fileBusinessAccounts = fileAccounts.filter(account => !isDocumentReviewAccount(account));
              const reviewPages = incompleteRecognitionPages(fileAccounts);
              return (
                <section key={sourceKey} className="rounded-xl border border-slate-200 overflow-hidden bg-slate-50/40">
                  <div className="flex items-center justify-between gap-3 px-4 py-3 bg-slate-100/80 border-b border-slate-200">
                    <div className="flex items-center gap-2 min-w-0">
                      {firstAccount.fileType === 'excel' || firstAccount.fileType === 'csv' ? (
                        <FileSpreadsheet className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                      ) : firstAccount.fileType === 'pdf' ? (
                        <FileText className="w-4 h-4 text-red-500 flex-shrink-0" />
                      ) : (
                        <FileImage className="w-4 h-4 text-blue-600 flex-shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate" title={fileName}>{fileName}</p>
                        <p className="text-[11px] text-slate-500">识别出 {fileBusinessAccounts.length} 个账户 · {fileTransactionCount} 笔流水</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleRemoveSourceFile(sourceKey, fileName)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition flex-shrink-0"
                      title="删除该来源文件及全部识别结果"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      删除文件
                    </button>
                  </div>
                  {reviewPages.length > 0 && (
                    <div className="mx-3 mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-900">
                      <span className="font-semibold">该文件尚未完整识别：</span>
                      第 {reviewPages.join('、')} 页仍需重新识别或人工补录，完成前不会进入正式资金分析。
                    </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
                    {fileBusinessAccounts.map((acc) => (
                      <div
                        key={accountIdentityKey(acc)}
                        className="p-4 rounded-lg border border-slate-200 bg-white"
                      >
                        <div className="flex items-center space-x-2">
                          <span className="font-semibold text-slate-900 text-sm">{acc.bankName}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200/70 text-slate-700 font-mono">
                            {acc.accountNumber.slice(-4) ? `...${acc.accountNumber.slice(-4)}` : acc.accountNumber}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 mt-1">
                          户名: <span className="font-medium">{acc.accountName}</span>
                        </p>
                        <div className="flex items-center space-x-3 mt-2 text-[11px] text-slate-500 font-mono">
                          <span>入: <strong className="text-emerald-600 font-normal">¥{acc.totalIn.toLocaleString()}</strong></span>
                          <span>出: <strong className="text-rose-600 font-normal">¥{acc.totalOut.toLocaleString()}</strong></span>
                          <span>流水: {acc.transactionCount} 笔</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
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
          disabled={!hasTransactions || isProcessing || pendingPdfPlans.length > 0}
          className={`inline-flex items-center space-x-2 px-6 py-2.5 rounded-xl text-sm font-medium transition shadow-sm ${
            hasTransactions && !isProcessing && pendingPdfPlans.length === 0
              ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          }`}
          title={pendingPdfPlans.length > 0
            ? '请先确认 PDF 分拣方案并完成识别'
            : !hasTransactions && accounts.length > 0
              ? '当前文件没有可分析的流水明细，请继续添加文件或核对原件'
              : undefined}
        >
          <span>{pendingPdfPlans.length > 0
            ? '请先确认 PDF 分拣方案'
            : !hasTransactions && accounts.length > 0
              ? '请先添加含流水明细的文件'
              : '下一步：核对原件'}</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
