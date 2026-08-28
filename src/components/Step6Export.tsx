import React, { useState } from 'react';
import { CaseMetadata } from '../types/case';
import { CaseEvaluationReport, DocumentPackageType } from '../types/evidence';
import { StandardTransaction } from '../types/transaction';
import { exportCourtEvidenceWord } from '../exporters/docxExporter';
import { exportCourtEvidenceExcel } from '../exporters/excelExporter';
import { 
  FileCheck2, 
  FileSpreadsheet, 
  FileText, 
  Download, 
  ArrowLeft, 
  Sparkles, 
  CheckCircle2,
  Scale
} from 'lucide-react';

interface Step6Props {
  caseMeta: CaseMetadata;
  evaluationReport: CaseEvaluationReport;
  transactions: StandardTransaction[];
  onPrev: () => void;
}

export const Step6Export: React.FC<Step6Props> = ({
  caseMeta,
  evaluationReport,
  transactions,
  onPrev
}) => {
  const [packageType, setPackageType] = useState<DocumentPackageType>('PACKAGE_CRIMINAL_REFUSAL');
  const [isExportingWord, setIsExportingWord] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  const packages = [
    {
      id: 'PACKAGE_CRIMINAL_REFUSAL' as DocumentPackageType,
      title: '方案 A: 拒执罪刑事自诉 / 移送公安证据包',
      badge: '刑民交叉·最硬证据',
      desc: '严格依据法释〔2024〕13号第3条，重点输出执行立案/报告财产令后大额恶意转出、现金拆分取现与隐匿财产清单。',
      primaryStatute: '《刑法》第313条、法释〔2024〕13号'
    },
    {
      id: 'PACKAGE_RESUME_DETENTION' as DocumentPackageType,
      title: '方案 B: 恢复执行 / 拘留罚款申请书附件',
      badge: '对抗终本·迫使和解',
      desc: '重点提取被执行人执行期间持续稳定收入、大额消费与理财，铁证其具备履行能力，申请法院采取拘留、罚款强制措施。',
      primaryStatute: '《民诉法》第114条、第253条'
    },
    {
      id: 'PACKAGE_CREDITOR_REVOCATION' as DocumentPackageType,
      title: '方案 C: 债权人撤销权诉讼事实与交易清单',
      badge: '民法典538/539条',
      desc: '输出债务发生后向家庭成员或案外人的无偿转让、明显不合理低价处分交易明细，直接作为撤销权起诉状事实附件。',
      primaryStatute: '《民法典》第538条、第539条'
    },
    {
      id: 'PACKAGE_PIERCE_COMPANY' as DocumentPackageType,
      title: '方案 D: 追加股东 / 公私财产混同证据册',
      badge: '追加被执行人',
      desc: '汇总一人有限责任公司公户与被执行人个人账户无业务背景频繁混转明细，证明财产混同，申请追加股东为被执行人。',
      primaryStatute: '《公司法》第23条、《变更追加规定》第20条'
    },
    {
      id: 'PACKAGE_FALSE_REPORT_PUNISH' as DocumentPackageType,
      title: '方案 E: 虚假报告财产差异核验与处罚申请包',
      badge: '法释〔2024〕13号第(三)项',
      desc: '将被执行人《财产申报表》声称的“无收入/无存款”与流水实际进出碰撞比对，输出差异证据清单，申请拘留罚款。',
      primaryStatute: '《民诉法》第248条'
    }
  ];

  const handleExportWord = async () => {
    setIsExportingWord(true);
    try {
      await exportCourtEvidenceWord(caseMeta, evaluationReport, transactions, packageType);
      setDownloadSuccess(true);
    } catch (err) {
      console.error('Word export error:', err);
    } finally {
      setIsExportingWord(false);
    }
  };

  const handleExportExcel = () => {
    setIsExportingExcel(true);
    try {
      exportCourtEvidenceExcel(caseMeta, evaluationReport, transactions);
      setDownloadSuccess(true);
    } catch (err) {
      console.error('Excel export error:', err);
    } finally {
      setIsExportingExcel(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 sm:px-6 space-y-6">
      {/* Step Header */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
          Step 6 / 6 成果一键导出
        </span>
        <h2 className="text-xl font-bold text-slate-900 mt-2">选择诉讼/执行行动目标，一键生成法庭级文书包</h2>
        <p className="text-xs text-slate-500 mt-1">
          文书已内置司法排版规范、法条自动映射及原始流水页码索引，下载后可直接打印盖章递交法院。
        </p>
      </div>

      {/* Package Selector */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-slate-800">1. 选择本次行动目标与文书方案</h3>
        <div className="grid grid-cols-1 gap-3">
          {packages.map(pkg => (
            <label
              key={pkg.id}
              className={`block rounded-2xl border p-5 cursor-pointer transition ${
                packageType === pkg.id
                  ? 'border-blue-600 bg-blue-50/40 ring-2 ring-blue-600/20 shadow-sm'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start space-x-3">
                  <input
                    type="radio"
                    name="packageType"
                    checked={packageType === pkg.id}
                    onChange={() => setPackageType(pkg.id)}
                    className="w-4 h-4 text-blue-600 mt-0.5"
                  />
                  <div>
                    <div className="flex items-center space-x-2">
                      <span className="font-bold text-sm text-slate-900">{pkg.title}</span>
                      <span className="px-2 py-0.5 rounded bg-blue-100/70 text-blue-700 text-[10px] font-semibold">
                        {pkg.badge}
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 mt-1">{pkg.desc}</p>
                  </div>
                </div>
                <div className="text-[10px] text-slate-400 font-mono hidden sm:block">
                  {pkg.primaryStatute}
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Download Actions */}
      <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
          <Download className="w-4 h-4 text-blue-600" />
          <span>2. 下载呈庭成果文书附件</span>
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          {/* Word Download */}
          <div className="p-5 rounded-xl border border-slate-200 bg-slate-50/50 space-y-3">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
                <FileText className="w-5 h-5" />
              </div>
              <div>
                <div className="font-bold text-xs text-slate-800">法律意见书与事实说明 (.docx)</div>
                <div className="text-[11px] text-slate-400">标准法庭排版，带原件页码索引与法条依据</div>
              </div>
            </div>
            <button
              onClick={handleExportWord}
              disabled={isExportingWord}
              className="w-full flex items-center justify-center space-x-2 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold shadow-md shadow-blue-500/20 transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExportingWord ? '正在生成 Word...' : '下载呈庭 Word 说明书'}</span>
            </button>
          </div>

          {/* Excel Download */}
          <div className="p-5 rounded-xl border border-slate-200 bg-slate-50/50 space-y-3">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div>
                <div className="font-bold text-xs text-slate-800">法庭质证交易明细表 (.xlsx)</div>
                <div className="text-[11px] text-slate-400">包含可疑交易清单、标准化流水、对手方排行三张表</div>
              </div>
            </div>
            <button
              onClick={handleExportExcel}
              disabled={isExportingExcel}
              className="w-full flex items-center justify-center space-x-2 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-md shadow-emerald-500/20 transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExportingExcel ? '正在生成 Excel...' : '下载多工作表 Excel 质证表'}</span>
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

      {/* Navigation */}
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
