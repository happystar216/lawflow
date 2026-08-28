import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, Download, FileSpreadsheet, FileText, Scale } from 'lucide-react';
import { CaseMetadata } from '../types/case';
import { CaseEvaluationReport } from '../types/evidence';
import { StandardTransaction } from '../types/transaction';
import { exportEvidenceAnalysisWord } from '../exporters/docxExporter';
import { exportEvidenceAnalysisExcel } from '../exporters/excelExporter';

interface Step6Props {
  caseMeta: CaseMetadata;
  evaluationReport: CaseEvaluationReport;
  transactions: StandardTransaction[];
  onPrev: () => void;
}

export const Step6Export: React.FC<Step6Props> = ({ caseMeta, evaluationReport, transactions, onPrev }) => {
  const [isExportingWord, setIsExportingWord] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const repaymentChecks = evaluationReport.matches.filter(match => match.ruleId === 'RULE_FABRICATED_REMARKS_BILATERAL');
  const pendingRepaymentChecks = repaymentChecks.filter(match => !match.verificationStatus || match.verificationStatus === 'PENDING');
  const hiddenAssetClues = evaluationReport.matches.filter(match => match.category === 'ASSET_CLUE');

  const handleExportWord = async () => {
    setIsExportingWord(true);
    try {
      await exportEvidenceAnalysisWord(caseMeta, evaluationReport, transactions);
      setDownloadSuccess(true);
    } catch (error) {
      console.error('Word export error:', error);
    } finally {
      setIsExportingWord(false);
    }
  };

  const handleExportExcel = async () => {
    setIsExportingExcel(true);
    try {
      await exportEvidenceAnalysisExcel(caseMeta, evaluationReport, transactions);
      setDownloadSuccess(true);
    } catch (error) {
      console.error('Excel export error:', error);
    } finally {
      setIsExportingExcel(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 sm:px-6 space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
          Step 6 / 6 证据分析导出
        </span>
        <h2 className="text-xl font-bold text-slate-900 mt-2">导出银行流水证据分析报告</h2>
        <p className="text-xs text-slate-500 mt-1">
          最终交付只包含资金事实、异常线索、原件定位、核验状态和待补证事项，不生成申请书、起诉状、刑事移送书或其他法律文书。
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs text-slate-400">分析线索</div>
          <div className="text-2xl font-bold text-slate-900 mt-1">{evaluationReport.matches.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">律师标记重点 {evaluationReport.matches.filter(match => match.lawyerAdopted).length} 项</div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="text-xs text-slate-400">隐形财产线索</div>
          <div className="text-2xl font-bold text-indigo-700 mt-1">{hiddenAssetClues.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">保险、证券、理财及对外债权</div>
        </div>
        <div className={`rounded-xl border p-4 ${pendingRepaymentChecks.length > 0 ? 'bg-amber-50 border-amber-200' : 'bg-white border-slate-200'}`}>
          <div className="text-xs text-slate-400">“还借款”待核验</div>
          <div className={`text-2xl font-bold mt-1 ${pendingRepaymentChecks.length > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{pendingRepaymentChecks.length}</div>
          <div className="text-[11px] text-slate-500 mt-1">共识别 {repaymentChecks.length} 笔还款备注交易</div>
        </div>
      </div>

      {pendingRepaymentChecks.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-900 leading-relaxed">
          仍有 {pendingRepaymentChecks.length} 笔“还借款/还款”交易未完成律师真实性核验。报告可以导出，但会明确标注为“待核验”，不会把备注内容当作真实借款事实。
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
          <Download className="w-4 h-4 text-blue-600" />
          <span>下载分析成果</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <ExportCard
            icon={<FileText className="w-5 h-5" />}
            iconClass="bg-blue-100 text-blue-600"
            title="银行流水证据分析报告 (.docx)"
            description="资金概览、隐形财产、还款核验、异常交易及待补证事项"
            buttonClass="bg-blue-600 hover:bg-blue-700 shadow-blue-500/20"
            buttonText={isExportingWord ? '正在生成 Word...' : '下载 Word 分析报告'}
            disabled={isExportingWord}
            onClick={handleExportWord}
          />
          <ExportCard
            icon={<FileSpreadsheet className="w-5 h-5" />}
            iconClass="bg-emerald-100 text-emerald-600"
            title="证据分析工作底表 (.xlsx)"
            description="全部线索、还款核验、标准化流水、对手方汇总"
            buttonClass="bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/20"
            buttonText={isExportingExcel ? '正在生成 Excel...' : '下载 Excel 分析底表'}
            disabled={isExportingExcel}
            onClick={handleExportExcel}
          />
        </div>

        {downloadSuccess && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>证据分析文件已生成。请在对外使用前再次核对原始流水和律师核验记录。</span>
          </div>
        )}
      </div>

      <div className="flex justify-between items-center pt-4">
        <button onClick={onPrev} className="flex items-center space-x-1.5 px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 text-xs font-medium transition">
          <ArrowLeft className="w-4 h-4" />
          <span>返回线索复核</span>
        </button>
        <div className="text-xs text-slate-400 flex items-center space-x-1">
          <Scale className="w-3.5 h-3.5 text-blue-500" />
          <span>只做证据分析，不自动生成法律文书</span>
        </div>
      </div>
    </div>
  );
};

interface ExportCardProps {
  icon: React.ReactNode;
  iconClass: string;
  title: string;
  description: string;
  buttonClass: string;
  buttonText: string;
  disabled: boolean;
  onClick: () => void;
}

const ExportCard: React.FC<ExportCardProps> = ({ icon, iconClass, title, description, buttonClass, buttonText, disabled, onClick }) => (
  <div className="p-5 rounded-xl border border-slate-200 bg-slate-50/50 space-y-3">
    <div className="flex items-center space-x-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${iconClass}`}>{icon}</div>
      <div>
        <div className="font-bold text-xs text-slate-800">{title}</div>
        <div className="text-[11px] text-slate-400">{description}</div>
      </div>
    </div>
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center justify-center space-x-2 py-2.5 disabled:bg-slate-300 text-white rounded-xl text-xs font-semibold shadow-md transition ${buttonClass}`}
    >
      <Download className="w-3.5 h-3.5" />
      <span>{buttonText}</span>
    </button>
  </div>
);
