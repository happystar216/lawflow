import React, { useState, useEffect } from 'react';
import { CaseRecord, listSavedCases, saveCaseRecord, deleteCaseRecord, exportCaseBackupJson, importCaseBackupJson } from '../store/caseStore';
import { 
  FolderPlus, 
  Search, 
  Trash2, 
  Download, 
  Upload, 
  ArrowRight, 
  Scale, 
  ShieldAlert,
  Coins,
  X
} from 'lucide-react';

interface CaseManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentCaseId: string;
  onSelectCase: (record: CaseRecord) => void;
  onNewCase: () => void;
}

export const CaseManagerModal: React.FC<CaseManagerModalProps> = ({
  isOpen,
  onClose,
  currentCaseId,
  onSelectCase,
  onNewCase
}) => {
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const loadCases = async () => {
    setIsLoading(true);
    const list = await listSavedCases();
    setCases(list);
    setIsLoading(false);
  };

  useEffect(() => {
    if (isOpen) {
      loadCases();
    }
  }, [isOpen]);

  const filteredCases = cases.filter(c => {
    const q = searchTerm.toLowerCase();
    return (
      (c.metadata.caseNumber || '').toLowerCase().includes(q) ||
      (c.metadata.respondentName || '').toLowerCase().includes(q) ||
      (c.metadata.applicantName || '').toLowerCase().includes(q) ||
      (c.metadata.courtName || '').toLowerCase().includes(q)
    );
  });

  const handleDelete = async (e: React.MouseEvent, caseId: string) => {
    e.stopPropagation();
    if (window.confirm('确定要删除该案件及全部流水记录吗？此操作无法撤销。')) {
      await deleteCaseRecord(caseId);
      await loadCases();
    }
  };

  const handleExportBackup = (e: React.MouseEvent, record: CaseRecord) => {
    e.stopPropagation();
    exportCaseBackupJson(record);
  };

  const handleImportBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const jsonStr = event.target?.result as string;
        const record = importCaseBackupJson(jsonStr);
        await saveCaseRecord(record);
        await loadCases();
        onSelectCase(record);
        onClose();
      } catch (err: any) {
        alert('导入失败: ' + err.message);
      }
    };
    reader.readAsText(file);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl max-w-4xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Modal Header */}
        <div className="p-6 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
              <Scale className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900">案件工作台管理中心</h2>
              <p className="text-xs text-slate-400">本地持久化存储，支持多案件切换与备份导出</p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <label className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-600 cursor-pointer transition">
              <Upload className="w-3.5 h-3.5" />
              <span>导入案件备份</span>
              <input type="file" accept=".json" onChange={handleImportBackup} className="hidden" />
            </label>

            <button
              onClick={() => {
                onNewCase();
                onClose();
              }}
              className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-sm transition"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>新建案件</span>
            </button>

            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-slate-600 hover:bg-slate-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="p-4 border-b border-slate-100 bg-slate-50/50">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="搜索案号、被执行人、申请人、法院..."
              className="w-full pl-10 pr-4 py-2 text-xs rounded-xl border border-slate-200 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>
        </div>

        {/* Case Cards Grid */}
        <div className="p-6 overflow-y-auto flex-1 divide-y divide-slate-100">
          {isLoading ? (
            <div className="text-center py-12 text-slate-400 text-xs">正在载入案件列表...</div>
          ) : filteredCases.length === 0 ? (
            <div className="text-center py-12 text-slate-400 text-xs">未搜索到相关案件</div>
          ) : (
            filteredCases.map(c => {
              const isCurrent = c.metadata.id === currentCaseId;
              const matchesCount = c.evaluationReport?.matches?.length || 0;
              const suspectedAmount = c.evaluationReport?.postExecutionTransferAmount || 0;

              return (
                <div
                  key={c.metadata.id}
                  onClick={() => {
                    onSelectCase(c);
                    onClose();
                  }}
                  className={`py-4 px-4 rounded-2xl cursor-pointer transition flex items-center justify-between flex-wrap gap-4 ${
                    isCurrent
                      ? 'bg-blue-50/70 border border-blue-200 shadow-sm'
                      : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center space-x-2 flex-wrap gap-1">
                      <span className="font-bold text-sm text-slate-900">
                        {c.metadata.caseNumber || '（未录入案号）'}
                      </span>
                      {isCurrent && (
                        <span className="px-2 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-semibold">
                          当前正在处理
                        </span>
                      )}
                      <span className="text-xs text-slate-400">
                        {c.metadata.courtName || '人民法院'}
                      </span>
                    </div>

                    <div className="text-xs text-slate-600 flex items-center space-x-3">
                      <span>
                        被执行人: <strong className="text-slate-800">{c.metadata.respondentName || '未指定'}</strong>
                      </span>
                      <span className="text-slate-300">|</span>
                      <span>
                        申请人: {c.metadata.applicantName || '债权人'}
                      </span>
                      <span className="text-slate-300">|</span>
                      <span>
                        标的: <strong className="text-blue-600 font-mono">¥{(c.metadata.targetAmount || 0).toLocaleString()}</strong>
                      </span>
                    </div>

                    <div className="flex items-center space-x-3 text-[11px] text-slate-400 pt-1 font-mono">
                      <span>已导入 {c.accounts?.length || 0} 张银行卡</span>
                      <span>共 {c.transactions?.length || 0} 笔明细</span>
                      {suspectedAmount > 0 && (
                        <span className="text-rose-600 font-bold flex items-center space-x-1">
                          <ShieldAlert className="w-3 h-3" />
                          <span>涉嫌转移: ¥{suspectedAmount.toLocaleString()} ({matchesCount} 项)</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Card Actions */}
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={e => handleExportBackup(e, c)}
                      className="p-2 rounded-xl text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition"
                      title="导出此案件备份 JSON"
                    >
                      <Download className="w-4 h-4" />
                    </button>

                    <button
                      onClick={e => handleDelete(e, c.metadata.id)}
                      className="p-2 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                      title="删除案件"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>

                    <div className="pl-2 border-l border-slate-200">
                      <span className="inline-flex items-center space-x-1 text-xs font-semibold text-blue-600 group-hover:text-blue-700">
                        <span>打开</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
