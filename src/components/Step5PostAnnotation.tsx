import React, { useState } from 'react';
import { CaseEvaluationReport } from '../types/evidence';
import { StandardTransaction } from '../types/transaction';
import { AnomalyMatch } from '../types/rules';
import { ArrowRight, ArrowLeft, UserCheck, ShieldAlert, CheckSquare, Square, Edit3, Tag } from 'lucide-react';

interface Step5Props {
  evaluationReport: CaseEvaluationReport;
  transactions: StandardTransaction[];
  onMatchesUpdated: (matches: AnomalyMatch[]) => void;
  onTransactionsUpdated: (transactions: StandardTransaction[]) => void;
  onNext: () => void;
  onPrev: () => void;
}

export const Step5PostAnnotation: React.FC<Step5Props> = ({
  evaluationReport,
  transactions,
  onMatchesUpdated,
  onTransactionsUpdated,
  onNext,
  onPrev
}) => {
  const [activeTab, setActiveTab] = useState<'matches' | 'counterparties'>('matches');
  const [editingMatchId, setEditingMatchId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const matches = evaluationReport.matches;

  // Toggle Adopted status for an anomaly
  const handleToggleAdopted = (matchId: string) => {
    const updated = matches.map(m => {
      if (m.matchId === matchId) {
        return { ...m, lawyerAdopted: !m.lawyerAdopted };
      }
      return m;
    });
    onMatchesUpdated(updated);
  };

  // Edit Lawyer Notes for a match
  const handleSaveNotes = (matchId: string) => {
    const updated = matches.map(m => {
      if (m.matchId === matchId) {
        return { ...m, lawyerNotes: editText };
      }
      return m;
    });
    onMatchesUpdated(updated);
    setEditingMatchId(null);
  };

  // Update Counterparty Role Tag (Cascading update to all transactions)
  const handleCounterpartyRoleTag = (cpName: string, roleTag: string) => {
    // 1. Update in transactions
    const updatedTx = transactions.map(t => {
      if (t.counterpartyName === cpName) {
        return { ...t, counterpartyRoleTag: roleTag };
      }
      return t;
    });
    onTransactionsUpdated(updatedTx);

    // 2. Cascade into match AI reasoning
    const updatedMatches = matches.map(m => {
      if (m.counterpartyName === cpName) {
        return {
          ...m,
          aiReasoning: m.aiReasoning.replace(/【.+?】/, `【${cpName}（${roleTag}）】`)
        };
      }
      return m;
    });
    onMatchesUpdated(updatedMatches);
  };

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 space-y-6">
      {/* Step Header */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 flex items-center justify-between flex-wrap gap-4">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
            Step 5 / 6 后标注研判
          </span>
          <h2 className="text-xl font-bold text-slate-900 mt-2">人物身份命名、穿透定性与呈庭证据复核</h2>
          <p className="text-xs text-slate-500 mt-1">
            律师根据案情对涉嫌对手方赋予真实人设（如“胞弟/空壳公司”），级联更新所有事实陈述；勾选采纳核心证据。
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center bg-slate-100 p-1 rounded-xl">
          <button
            onClick={() => setActiveTab('matches')}
            className={`flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
              activeTab === 'matches'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>可疑证据清单 ({matches.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('counterparties')}
            className={`flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
              activeTab === 'counterparties'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <UserCheck className="w-3.5 h-3.5" />
            <span>对手方身份命名 ({Object.keys(evaluationReport.counterpartySummaries).length})</span>
          </button>
        </div>
      </div>

      {/* Tab 1: Matches Evidence Review */}
      {activeTab === 'matches' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between px-2 text-xs text-slate-500">
            <span>已采纳 {matches.filter(m => m.lawyerAdopted).length} / {matches.length} 项呈庭证据</span>
            <span>勾选将包含在最终 Word / Excel 文书附件中</span>
          </div>

          <div className="space-y-3">
            {matches.map(m => (
              <div
                key={m.matchId}
                className={`rounded-2xl border p-5 transition bg-white shadow-sm ${
                  m.lawyerAdopted ? 'border-blue-200 ring-1 ring-blue-500/10' : 'border-slate-200 opacity-60'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start space-x-3">
                    <button
                      onClick={() => handleToggleAdopted(m.matchId)}
                      className="mt-0.5 text-blue-600 hover:text-blue-700 transition"
                    >
                      {m.lawyerAdopted ? (
                        <CheckSquare className="w-5 h-5" />
                      ) : (
                        <Square className="w-5 h-5 text-slate-400" />
                      )}
                    </button>

                    <div className="space-y-1">
                      <div className="flex items-center space-x-2 flex-wrap gap-1">
                        <span className="font-bold text-sm text-slate-900">{m.ruleName}</span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            m.severity === 'L0'
                              ? 'bg-rose-100 text-rose-700'
                              : m.severity === 'L1'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-emerald-100 text-emerald-700'
                          }`}
                        >
                          {m.severity}
                        </span>
                        <span className="text-xs text-slate-400 font-medium">{m.timePhase}</span>
                      </div>

                      <div className="text-xs text-slate-600">
                        对手方: <span className="font-semibold text-slate-800">{m.counterpartyName || '现金/未知'}</span>
                        <span className="mx-2 text-slate-300">|</span>
                        涉案金额: <span className="font-mono font-bold text-rose-600">¥ {m.totalAmount.toLocaleString()} 元</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <button
                      onClick={() => {
                        setEditingMatchId(m.matchId);
                        setEditText(m.lawyerNotes || m.aiReasoning);
                      }}
                      className="inline-flex items-center space-x-1 text-xs text-blue-600 hover:text-blue-700 font-medium"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>编辑陈述</span>
                    </button>
                  </div>
                </div>

                {/* AI / Lawyer Reasoning Content */}
                <div className="mt-3 pl-8">
                  {editingMatchId === m.matchId ? (
                    <div className="space-y-2">
                      <textarea
                        value={editText}
                        onChange={e => setEditText(e.target.value)}
                        rows={3}
                        className="w-full p-2.5 text-xs rounded-xl border border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                      />
                      <div className="flex justify-end space-x-2">
                        <button
                          onClick={() => setEditingMatchId(null)}
                          className="px-3 py-1 text-xs text-slate-600 rounded-lg hover:bg-slate-100"
                        >
                          取消
                        </button>
                        <button
                          onClick={() => handleSaveNotes(m.matchId)}
                          className="px-3 py-1 text-xs bg-blue-600 text-white rounded-lg font-medium"
                        >
                          保存修改
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-slate-700 bg-slate-50 rounded-xl p-3 border border-slate-200/60 leading-relaxed">
                      {m.lawyerNotes || m.aiReasoning}
                    </div>
                  )}

                  <div className="flex items-center space-x-2 mt-2 text-[10px] text-slate-400">
                    <span>法定依据:</span>
                    {m.statutoryBasis.map((law: string, idx: number) => (
                      <span key={idx} className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded font-mono">
                        {law}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab 2: Counterparties Manual Tagging */}
      {activeTab === 'counterparties' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
            <Tag className="w-4 h-4 text-blue-600" />
            <span>对手方资金去向与身份角色级联标注</span>
          </h3>
          <p className="text-xs text-slate-500">
            为对手方标注角色（如：被执行人胞妹、空壳贸易公司、保单代持人），系统将自动把该称谓级联填充至所有呈庭事实说明中。
          </p>

          <div className="divide-y divide-slate-100">
            {Object.values(evaluationReport.counterpartySummaries)
              .sort((a, b) => b.netOut - a.netOut)
              .map(cp => (
                <div key={cp.name} className="py-4 flex items-center justify-between flex-wrap gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-sm text-slate-900">{cp.name}</span>
                      {cp.isSuspectedRelative && (
                        <span className="px-2 py-0.5 rounded bg-purple-50 text-purple-700 text-[10px] font-bold border border-purple-200">
                          同姓/疑似近亲属
                        </span>
                      )}
                      {cp.isSuspectedAffiliate && (
                        <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-bold border border-blue-200">
                          疑似关联企业
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 font-mono">
                      转出: <span className="text-rose-600 font-bold">¥{cp.totalOut.toLocaleString()}</span> | 
                      转入: <span className="text-emerald-600">¥{cp.totalIn.toLocaleString()}</span> | 
                      净流出: <span className="text-rose-700 font-bold">¥{cp.netOut.toLocaleString()}</span> ({cp.transactionCount} 笔)
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-slate-500">律师标注角色:</span>
                    <input
                      type="text"
                      defaultValue={cp.roleTag || ''}
                      placeholder="如：被执行人胞弟 / 独资企业公户"
                      onBlur={e => handleCounterpartyRoleTag(cp.name, e.target.value)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500 w-48 font-medium"
                    />
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between items-center pt-4">
        <button
          onClick={onPrev}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 text-xs font-medium transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>返回数据计算</span>
        </button>

        <button
          onClick={onNext}
          className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm shadow-md shadow-blue-500/20 transition"
        >
          <span>进入步骤六：一键导出呈庭证据包</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
