import React, { useState } from 'react';
import { CaseMetadata } from '../types/case';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { CaseEvaluationReport } from '../types/evidence';
import { LawFlowEngine } from '../engine/engine';
import { 
  Play, 
  Settings2, 
  ArrowRight, 
  ArrowLeft, 
  ShieldAlert, 
  Flame, 
  AlertCircle, 
  Coins, 
  Sliders, 
  BarChart3, 
  Layers
} from 'lucide-react';

interface Step4Props {
  caseMeta: CaseMetadata;
  accounts: BankAccount[];
  transactions: StandardTransaction[];
  engine: LawFlowEngine;
  onEvaluationComplete: (report: CaseEvaluationReport, processedTransactions: StandardTransaction[]) => void;
  evaluationReport: CaseEvaluationReport | null;
  onNext: () => void;
  onPrev: () => void;
}

export const Step4Compute: React.FC<Step4Props> = ({
  caseMeta,
  accounts,
  transactions,
  engine,
  onEvaluationComplete,
  evaluationReport,
  onNext,
  onPrev
}) => {
  const [isCalculating, setIsCalculating] = useState(false);
  const [showRuleSettings, setShowRuleSettings] = useState(false);
  const [ruleList, setRuleList] = useState(engine.getRegistry().getAllRules());

  const handleRunCompute = () => {
    setIsCalculating(true);
    setTimeout(() => {
      const { report, processedTransactions } = engine.evaluateCase(
        caseMeta,
        transactions,
        accounts
      );
      onEvaluationComplete(report, processedTransactions);
      setIsCalculating(false);
    }, 400);
  };

  const handleToggleRule = (ruleId: string, enabled: boolean) => {
    engine.getRegistry().toggleRule(ruleId, enabled);
    setRuleList([...engine.getRegistry().getAllRules()]);
  };

  // Run automatically once if not already computed
  React.useEffect(() => {
    if (!evaluationReport && transactions.length > 0) {
      handleRunCompute();
    }
  }, []);

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6 space-y-6">
      {/* Step Header */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 flex items-center justify-between flex-wrap gap-4">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
            Step 4 / 6 数据计算 (核心算法引擎)
          </span>
          <h2 className="text-xl font-bold text-slate-900 mt-2">11 大异常识别算法 DAG 矩阵运算</h2>
          <p className="text-xs text-slate-500 mt-1">
            本人账户核销、时间轴切片、双向净额汇总与可配置异常提示，生成供律师复核的资金画像。
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => setShowRuleSettings(!showRuleSettings)}
            className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-medium transition"
          >
            <Sliders className="w-4 h-4 text-slate-500" />
            <span>算法参数与开关抽屉</span>
          </button>

          <button
            onClick={handleRunCompute}
            disabled={isCalculating}
            className="flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs shadow-md shadow-blue-500/20 transition"
          >
            <Play className={`w-3.5 h-3.5 ${isCalculating ? 'animate-spin' : ''}`} />
            <span>{isCalculating ? '正在计算中...' : '重新执行计算'}</span>
          </button>
        </div>
      </div>

      {/* Rule Settings Drawer */}
      {showRuleSettings && (
        <div className="bg-slate-900 text-white rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div className="flex items-center space-x-2">
              <Settings2 className="w-4 h-4 text-blue-400" />
              <h3 className="text-sm font-bold">可插拔规则算法库配置中枢 (11大算法)</h3>
            </div>
            <span className="text-xs text-slate-400">支持独立开启/停用与阈值调优</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {ruleList.map(rule => (
              <div
                key={rule.ruleId}
                className="p-3 rounded-xl bg-slate-800/80 border border-slate-700/60 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-200">{rule.name}</span>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={e => handleToggleRule(rule.ruleId, e.target.checked)}
                    className="w-4 h-4 text-blue-600 rounded bg-slate-700 border-slate-600"
                  />
                </div>
                <p className="text-[11px] text-slate-400 leading-snug">{rule.description}</p>
                <div className="text-[10px] text-blue-400 font-mono pt-1">{rule.statutoryBasis[0]}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Evaluation Macro Dashboard */}
      {evaluationReport && (
        <div className="space-y-6">
          {/* Top KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Card 1: Netting Result */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>内部对冲自转剔除</span>
                <Layers className="w-4 h-4 text-blue-500" />
              </div>
              <div className="text-2xl font-bold text-slate-900">
                ¥ {evaluationReport.internalTransferAmount.toLocaleString()}
              </div>
              <div className="text-[11px] text-emerald-600 font-medium">
                双边匹配并核销 {evaluationReport.internalTransferCount} 笔本人账户自转交易
              </div>
            </div>

            {/* Card 2: Post Enforcement Transfer */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>执行立案后对外转出</span>
                <Flame className="w-4 h-4 text-rose-500" />
              </div>
              <div className="text-2xl font-bold text-rose-600">
                ¥ {evaluationReport.postExecutionTransferAmount.toLocaleString()}
              </div>
              <div className="text-[11px] text-rose-700 font-medium">
                其中报告令后转出 ¥{evaluationReport.postReportOrderTransferAmount.toLocaleString()}
              </div>
            </div>

            {/* Card 3: Solvency vs Target Debt */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>履行能力覆盖率</span>
                <Coins className="w-4 h-4 text-amber-500" />
              </div>
              <div className="text-2xl font-bold text-amber-600">
                {(evaluationReport.solvencyCoverageRate * 100).toFixed(0)}%
              </div>
              <div className="text-[11px] text-slate-500 font-medium">
                进账收入 ¥{evaluationReport.totalIncomeDuringExecution.toLocaleString()} / 标的 ¥{evaluationReport.targetDebtAmount.toLocaleString()}
              </div>
            </div>

            {/* Card 4: Anomalies Found */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-5 shadow-sm space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>命中异常证据项</span>
                <ShieldAlert className="w-4 h-4 text-indigo-500" />
              </div>
              <div className="text-2xl font-bold text-indigo-600">
                {evaluationReport.matches.length} 项
              </div>
              <div className="text-[11px] text-slate-500 font-medium">
                L0红线: {evaluationReport.matches.filter(m => m.severity === 'L0').length}项 | L1重点: {evaluationReport.matches.filter(m => m.severity === 'L1').length}项
              </div>
            </div>
          </div>

          {/* Macro Visual Breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left 2 Cols: Macro Net Cash Flow */}
            <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
              <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
                <BarChart3 className="w-4 h-4 text-blue-600" />
                <span>资金总发生额 vs 真实外部净流向穿透对比</span>
              </h3>

              <div className="space-y-4 pt-2">
                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-600 mb-1">
                    <span>原始账面总流出 (含自转)</span>
                    <span className="font-mono">¥ {evaluationReport.totalRawOut.toLocaleString()}</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-3">
                    <div className="bg-slate-400 h-3 rounded-full" style={{ width: '100%' }}></div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-600 mb-1">
                    <span>真实外部净流出 (剔除自转后)</span>
                    <span className="font-mono text-blue-600 font-bold">¥ {evaluationReport.netExternalOut.toLocaleString()}</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-3">
                    <div
                      className="bg-blue-600 h-3 rounded-full"
                      style={{
                        width: `${Math.min(100, (evaluationReport.netExternalOut / (evaluationReport.totalRawOut || 1)) * 100)}%`
                      }}
                    ></div>
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-medium text-slate-600 mb-1">
                    <span>执行立案后对外转出（待核实用途）</span>
                    <span className="font-mono text-rose-600 font-bold">¥ {evaluationReport.postExecutionTransferAmount.toLocaleString()}</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-3">
                    <div
                      className="bg-rose-500 h-3 rounded-full"
                      style={{
                        width: `${Math.min(100, (evaluationReport.postExecutionTransferAmount / (evaluationReport.totalRawOut || 1)) * 100)}%`
                      }}
                    ></div>
                  </div>
                </div>
              </div>

              <div className="p-3 bg-blue-50/60 rounded-xl border border-blue-100 text-xs text-blue-800">
                💡 <strong>复核提示</strong>：本人账户双边互转核销后，执行立案后对外转出合计 <strong>¥{evaluationReport.postExecutionTransferAmount.toLocaleString()} 元</strong>；执行期间已识别入账约占标的额 <strong>{(evaluationReport.solvencyCoverageRate * 100).toFixed(0)}%</strong>。上述数字仅反映已导入流水，资金性质、可供执行范围及主观目的仍需结合完整证据判断。
              </div>
            </div>

            {/* Right Col: Anomaly Radar Distribution */}
            <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
              <h3 className="text-sm font-bold text-slate-800">异常特征命中分布</h3>
              <div className="space-y-3">
                {evaluationReport.matches.slice(0, 5).map((m, idx) => (
                  <div key={idx} className="p-3 rounded-xl bg-slate-50 border border-slate-200/60 text-xs space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-800">{m.ruleName}</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          m.severity === 'L0' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {m.severity}
                      </span>
                    </div>
                    <div className="text-slate-500 truncate">{m.counterpartyName}</div>
                    <div className="font-mono font-semibold text-rose-600">¥ {m.totalAmount.toLocaleString()}</div>
                  </div>
                ))}
              </div>
            </div>
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
          <span>返回前置标注</span>
        </button>

        <button
          onClick={onNext}
          className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm shadow-md shadow-blue-500/20 transition"
        >
          <span>进入步骤五：后标注研判与证据勾选</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
