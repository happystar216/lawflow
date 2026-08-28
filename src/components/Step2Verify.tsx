import React, { useState } from 'react';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { CheckCircle2, AlertTriangle, ArrowRight, ArrowLeft, Search, Check, Eye } from 'lucide-react';
import { auditAccountBalance } from '../parsers/sanityChecker';

interface Step2Props {
  accounts: BankAccount[];
  transactions: StandardTransaction[];
  onTransactionsUpdated: (updated: StandardTransaction[]) => void;
  onNext: () => void;
  onPrev: () => void;
}

export const Step2Verify: React.FC<Step2Props> = ({
  accounts,
  transactions,
  onTransactionsUpdated,
  onNext,
  onPrev
}) => {
  const [selectedAccNum, setSelectedAccNum] = useState<string>(accounts[0]?.accountNumber || '');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTxForPreview, setSelectedTxForPreview] = useState<StandardTransaction | null>(null);

  const selectedAccount = accounts.find(a => a.accountNumber === selectedAccNum) || accounts[0];
  const auditReport = selectedAccount ? auditAccountBalance(selectedAccount, transactions) : null;

  const currentAccTransactions = transactions.filter(t => {
    if (selectedAccNum && t.accountNumber !== selectedAccNum) return false;
    if (searchTerm) {
      const q = searchTerm.toLowerCase();
      return (
        t.counterpartyName.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        String(t.amount).includes(q) ||
        t.transactionDate.includes(q)
      );
    }
    return true;
  });

  const handleCellEdit = (txId: string, field: keyof StandardTransaction, value: any) => {
    const updated = transactions.map(t => {
      if (t.id === txId) {
        return { ...t, [field]: value };
      }
      return t;
    });
    onTransactionsUpdated(updated);
  };

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 space-y-6">
      {/* Step Header */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
          Step 2 / 6 证据确认
        </span>
        <h2 className="text-xl font-bold text-slate-900 mt-2">数据平账审计与证据真实性核验</h2>
        <p className="text-xs text-slate-500 mt-1">
          系统自动进行借贷平衡审计（期初+收入-支出=期末）。支持对解析数据在线纠偏，确保上法庭数据 100% 准确。
        </p>

        {/* Account Selector Tabs */}
        <div className="flex items-center space-x-2 mt-5 overflow-x-auto pb-1">
          {accounts.map(acc => (
            <button
              key={acc.accountNumber}
              onClick={() => setSelectedAccNum(acc.accountNumber)}
              className={`px-4 py-2 rounded-xl text-xs font-medium transition flex items-center space-x-2 flex-shrink-0 ${
                selectedAccNum === acc.accountNumber
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <span>{acc.bankName}</span>
              <span className="font-mono text-[11px] opacity-75">({acc.accountNumber.slice(-4)})</span>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            </button>
          ))}
        </div>
      </div>

      {/* Audit Stats Panel */}
      {selectedAccount && auditReport && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm">
            <div className="text-xs text-slate-400">平账审计状态</div>
            <div className="flex items-center space-x-2 mt-1">
              {auditReport.isBalanced ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-rose-600" />
              )}
              <span className={`text-sm font-bold ${auditReport.isBalanced ? 'text-emerald-700' : 'text-rose-700'}`}>
                {!auditReport.isAuditable ? '缺少余额字段（无法自动平账）' : auditReport.isBalanced ? '借贷完全平衡（已平账）' : '借贷不平衡（需复核）'}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-1 font-mono">
              误差差额: ¥{auditReport.difference.toFixed(2)}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm">
            <div className="text-xs text-slate-400">账户收入总计</div>
            <div className="text-lg font-bold text-emerald-600 mt-1">
              ¥ {auditReport.totalIncome.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">贷方总入账发生额</div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm">
            <div className="text-xs text-slate-400">账户支出总计</div>
            <div className="text-lg font-bold text-rose-600 mt-1">
              ¥ {auditReport.totalExpense.toLocaleString()}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">借方总转出发生额</div>
          </div>

          <div className="bg-white rounded-xl border border-slate-200/80 p-4 shadow-sm">
            <div className="text-xs text-slate-400">流水时间跨度</div>
            <div className="text-sm font-semibold text-slate-800 mt-1">
              {selectedAccount.startDate || '2023-01-01'} ~ {selectedAccount.endDate || '2024-05-30'}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">共 {selectedAccount.transactionCount} 条交易记录</div>
          </div>
        </div>
      )}

      {/* Transactions Data Table */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center space-x-2">
            <h3 className="text-sm font-bold text-slate-800">
              标准化明细核对 ({currentAccTransactions.length} 笔)
            </h3>
            <span className="text-xs text-slate-400">（双击单元格可直接修正 OCR 或解析文字）</span>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="搜索对手方、金额、附言..."
              className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 w-56"
            />
          </div>
        </div>

        <div className="overflow-x-auto max-h-[500px]">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 font-semibold border-b border-slate-200 sticky top-0 z-10">
              <tr>
                <th className="py-2.5 px-3">序号</th>
                <th className="py-2.5 px-3">交易时间</th>
                <th className="py-2.5 px-3">收支方向</th>
                <th className="py-2.5 px-3">交易金额 (元)</th>
                <th className="py-2.5 px-3">交易后余额</th>
                <th className="py-2.5 px-3">对手方户名</th>
                <th className="py-2.5 px-3">摘要 / 附言</th>
                <th className="py-2.5 px-3">原始凭证定位</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-normal">
              {currentAccTransactions.map((tx, idx) => (
                <tr key={tx.id} className="hover:bg-blue-50/40 transition">
                  <td className="py-2 px-3 text-slate-400 font-mono text-[11px]">{idx + 1}</td>
                  <td className="py-2 px-3 text-slate-700 whitespace-nowrap">
                    <input
                      type="text"
                      value={tx.transactionTime}
                      onChange={e => handleCellEdit(tx.id, 'transactionTime', e.target.value)}
                      className="bg-transparent hover:bg-white focus:bg-white focus:ring-1 focus:ring-blue-500 rounded px-1.5 py-0.5 border border-transparent hover:border-slate-300 w-32"
                    />
                  </td>
                  <td className="py-2 px-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold ${
                        tx.direction === 'IN'
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : 'bg-rose-50 text-rose-700 border border-rose-200'
                      }`}
                    >
                      {tx.direction === 'IN' ? '存入(+)' : '支出(-)'}
                    </span>
                  </td>
                  <td className="py-2 px-3 font-semibold font-mono">
                    <input
                      type="number"
                      value={tx.amount}
                      onChange={e => handleCellEdit(tx.id, 'amount', parseFloat(e.target.value) || 0)}
                      className={`bg-transparent hover:bg-white focus:bg-white focus:ring-1 focus:ring-blue-500 rounded px-1.5 py-0.5 border border-transparent hover:border-slate-300 w-28 ${
                        tx.direction === 'IN' ? 'text-emerald-700' : 'text-rose-700'
                      }`}
                    />
                  </td>
                  <td className="py-2 px-3 text-slate-600 font-mono">
                    ¥{tx.balance.toLocaleString()}
                  </td>
                  <td className="py-2 px-3">
                    <input
                      type="text"
                      value={tx.counterpartyName}
                      onChange={e => handleCellEdit(tx.id, 'counterpartyName', e.target.value)}
                      className="bg-transparent hover:bg-white focus:bg-white focus:ring-1 focus:ring-blue-500 rounded px-1.5 py-0.5 border border-transparent hover:border-slate-300 font-medium text-slate-800 w-36"
                    />
                  </td>
                  <td className="py-2 px-3 text-slate-600">
                    <input
                      type="text"
                      value={tx.summary}
                      onChange={e => handleCellEdit(tx.id, 'summary', e.target.value)}
                      className="bg-transparent hover:bg-white focus:bg-white focus:ring-1 focus:ring-blue-500 rounded px-1.5 py-0.5 border border-transparent hover:border-slate-300 w-36"
                    />
                  </td>
                  <td className="py-2 px-3 text-slate-400 text-[11px] whitespace-nowrap">
                    <button
                      onClick={() => setSelectedTxForPreview(tx)}
                      className="inline-flex items-center space-x-1 text-blue-600 hover:text-blue-700 font-medium"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>{tx.rawPageNumber ? `第${tx.rawPageNumber}页` : `第${tx.rawRowIndex || 1}行`}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Modal for Raw Evidence Inspector */}
        {selectedTxForPreview && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h3 className="font-bold text-slate-900 text-sm">原始流水凭证切片对照</h3>
                <button
                  onClick={() => setSelectedTxForPreview(null)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  ✕
                </button>
              </div>

              <div className="bg-slate-50 rounded-xl p-4 border border-slate-200 text-xs space-y-2">
                <div className="flex justify-between">
                  <span className="text-slate-500">来源文件:</span>
                  <span className="font-medium text-slate-800">{selectedTxForPreview.rawSourceFile}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">凭证位置:</span>
                  <span className="font-semibold text-blue-600">
                    {selectedTxForPreview.rawPageNumber ? `第 ${selectedTxForPreview.rawPageNumber} 页` : `第 ${selectedTxForPreview.rawRowIndex} 行`}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">交易金额:</span>
                  <span className="font-bold text-rose-600">¥ {selectedTxForPreview.amount.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">对手方:</span>
                  <span className="font-medium text-slate-800">{selectedTxForPreview.counterpartyName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">附言摘要:</span>
                  <span className="text-slate-700">{selectedTxForPreview.summary}</span>
                </div>
              </div>

              <div className="p-3 bg-amber-50 rounded-xl border border-amber-200 text-[11px] text-amber-800">
                💡 导出文书时，系统将自动把该页码与行号作为质证索引写入 Word 附件中，方便当庭翻阅。
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => setSelectedTxForPreview(null)}
                  className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-medium"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Footer Navigation */}
        <div className="p-4 bg-slate-50/70 border-t border-slate-100 flex justify-between items-center">
          <button
            onClick={onPrev}
            className="flex items-center space-x-1.5 px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-200 text-xs font-medium transition"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>返回上传</span>
          </button>

          <button
            onClick={onNext}
            disabled={accounts.some(account => {
              const report = auditAccountBalance(account, transactions);
              return report.isAuditable && !report.isBalanced;
            })}
            title={accounts.some(account => {
              const report = auditAccountBalance(account, transactions);
              return report.isAuditable && !report.isBalanced;
            }) ? '仍有账户未平账，请修正后继续' : undefined}
            className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-medium text-sm shadow-md shadow-blue-500/20 transition"
          >
            <Check className="w-4 h-4" />
            <span>确认无误，进入前置标注</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
