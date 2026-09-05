import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, Download, FileSpreadsheet, FileText, FileCode2, Scale } from 'lucide-react';
import { CaseMetadata } from '../types/case';
import { CaseEvaluationReport } from '../types/evidence';
import { BankAccount, StandardTransaction } from '../types/transaction';
import { exportEvidenceAnalysisWord } from '../exporters/docxExporter';
import { exportEvidenceAnalysisExcel } from '../exporters/excelExporter';
import { exportEvidencePdfBooklet } from '../exporters/pdfEvidenceExporter';

interface Step6Props {
  caseMeta: CaseMetadata;
  evaluationReport: CaseEvaluationReport;
  transactions: StandardTransaction[];
  accounts: BankAccount[];
  onPrev: () => void;
}

export const Step6Export: React.FC<Step6Props> = ({ caseMeta, evaluationReport, transactions, accounts, onPrev }) => {
  const [isExportingWord, setIsExportingWord] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  const repaymentChecks = evaluationReport.matches.filter(match => match.ruleId === 'RULE_FABRICATED_REMARKS_BILATERAL');
  const pendingRepaymentChecks = repaymentChecks.filter(match => !match.verificationStatus || match.verificationStatus === 'PENDING');
  const hiddenAssetClues = evaluationReport.matches.filter(match => match.category === 'ASSET_CLUE');
  const unresolvedDataChecks = accounts.flatMap(account => account.reviewIssues || []).filter(issue => issue.status === 'PENDING' || issue.status === 'UNRESOLVED');

  const handleExportWord = async () => {
    setIsExportingWord(true);
    try {
      await exportEvidenceAnalysisWord(caseMeta, evaluationReport, transactions, accounts);
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
      await exportEvidenceAnalysisExcel(caseMeta, evaluationReport, transactions, accounts);
      setDownloadSuccess(true);
    } catch (error) {
      console.error('Excel export error:', error);
    } finally {
      setIsExportingExcel(false);
    }
  };

  const handleExportPdf = async () => {
    setIsExportingPdf(true);
    try {
      await exportEvidencePdfBooklet(caseMeta, evaluationReport, transactions);
      setDownloadSuccess(true);
    } catch (error) {
      console.error('PDF export error:', error);
    } finally {
      setIsExportingPdf(false);
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
          最终交付包含资金事实、异常线索、原件定位、核验状态和待补证事项，支持 Word 报告、Excel 工作底表与 PDF 证据对照册。
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
      {unresolvedDataChecks.length > 0 && <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 text-xs text-rose-900 leading-relaxed">仍有 {unresolvedDataChecks.length} 项原始数据核对事项未完成。导出的分析报告会逐项列明页码、问题和律师处理状态，不会将其隐藏。</div>}

      {/* Download Action Cards */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
          <Download className="w-4 h-4 text-blue-600" />
          <span>下载分析底表与呈庭证据包</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
          {/* Word Exporter */}
          <div className="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-3 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="w-9 h-9 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
                <FileText className="w-5 h-5" />
              </div>
              <div>
                <div className="font-bold text-xs text-slate-800">证据分析报告 (.docx)</div>
                <div className="text-[11px] text-slate-400">含分析说明、事实要点、法条与核验清单</div>
              </div>
            </div>
            <button
              onClick={handleExportWord}
              disabled={isExportingWord}
              className="w-full flex items-center justify-center space-x-1.5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold shadow-sm transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExportingWord ? '生成中...' : '下载 Word 报告'}</span>
            </button>
          </div>

          {/* Excel Exporter */}
          <div className="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-3 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div>
                <div className="font-bold text-xs text-slate-800">证据分析工作底表 (.xlsx)</div>
                <div className="text-[11px] text-slate-400">结构化全量明细、线索清单与核销记录</div>
              </div>
            </div>
            <button
              onClick={handleExportExcel}
              disabled={isExportingExcel}
              className="w-full flex items-center justify-center space-x-1.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-sm transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExportingExcel ? '生成中...' : '下载 Excel 底表'}</span>
            </button>
          </div>

          {/* PDF Visual Booklet Exporter */}
          <div className="p-4 rounded-2xl border border-slate-200 bg-slate-50/50 space-y-3 flex flex-col justify-between">
            <div className="space-y-2">
              <div className="w-9 h-9 rounded-xl bg-purple-100 text-purple-600 flex items-center justify-center">
                <FileCode2 className="w-5 h-5" />
              </div>
              <div>
                <div className="font-bold text-xs text-slate-800">证据切片对照册 (.pdf)</div>
                <div className="text-[11px] text-slate-400">带证据编号徽章与页码定位的切片册</div>
              </div>
            </div>
            <button
              onClick={handleExportPdf}
              disabled={isExportingPdf}
              className="w-full flex items-center justify-center space-x-1.5 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-semibold shadow-sm transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExportingPdf ? '生成中...' : '下载 PDF 证据册'}</span>
            </button>
          </div>
        </div>

        {downloadSuccess && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <span>文书已成功生成并下载至您的电脑。祝执行办案顺利！</span>
          </div>
        )}
      </div>

      <div className="flex justify-between items-center pt-4">
        <button
          onClick={onPrev}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 text-xs font-medium transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>返回后标注</span>
        </button>

        <div className="text-xs text-slate-400 flex items-center space-x-1">
          <Scale className="w-3.5 h-3.5 text-blue-500" />
          <span>执析宝 - 让执行银行流水转化为坚不可摧的法庭证据</span>
        </div>
      </div>
    </div>
  );
};
