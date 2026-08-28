import React from 'react';
import { CaseMetadata } from '../types/case';
import { Scale, ArrowRight, Calendar, Coins, Building2, User, FileSpreadsheet } from 'lucide-react';

interface Step0Props {
  caseMeta: CaseMetadata;
  onChange: (updated: CaseMetadata) => void;
  onNext: () => void;
}

export const Step0CaseSetup: React.FC<Step0Props> = ({
  caseMeta,
  onChange,
  onNext
}) => {
  // Allow proceeding as long as user provides a case identifier or respondent name
  const canProceed = Boolean(
    caseMeta.respondentName?.trim() || caseMeta.caseNumber?.trim()
  );

  const handleChange = (field: keyof CaseMetadata, value: any) => {
    onChange({
      ...caseMeta,
      [field]: value
    });
  };

  const handleTimelineChange = (field: keyof CaseMetadata['timeline'], value: string) => {
    onChange({
      ...caseMeta,
      timeline: {
        ...caseMeta.timeline,
        [field]: value
      }
    });
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6">
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 sm:p-8 space-y-6">
        <div className="flex items-start justify-between border-b border-slate-100 pb-5">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
              Step 0 / 6 案件建档
            </span>
            <h2 className="text-xl font-bold text-slate-900 mt-2">创建执行案件并设定标的与时间坐标</h2>
            <p className="text-xs text-slate-500 mt-1">
              录入案号与执行标的金额，用于后续与流水进账自动比对清偿履约能力；设定法律时间轴赋予流水法律证据价值。
            </p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0">
            <Scale className="w-6 h-6" />
          </div>
        </div>

        {/* Form Fields */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1 flex items-center space-x-1.5">
              <FileSpreadsheet className="w-3.5 h-3.5 text-slate-400" />
              <span>执行案号</span>
            </label>
            <input
              type="text"
              value={caseMeta.caseNumber || ''}
              onChange={e => handleChange('caseNumber', e.target.value)}
              placeholder="如：(2024)京01执1234号"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1 flex items-center space-x-1.5">
              <Building2 className="w-3.5 h-3.5 text-slate-400" />
              <span>执行法院</span>
            </label>
            <input
              type="text"
              value={caseMeta.courtName || ''}
              onChange={e => handleChange('courtName', e.target.value)}
              placeholder="如：北京市第一中级人民法院"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1 flex items-center space-x-1.5">
              <User className="w-3.5 h-3.5 text-slate-400" />
              <span>申请执行人 (债权人)</span>
            </label>
            <input
              type="text"
              value={caseMeta.applicantName || ''}
              onChange={e => handleChange('applicantName', e.target.value)}
              placeholder="申请人姓名或企业全称"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1 flex items-center space-x-1.5">
              <User className="w-3.5 h-3.5 text-rose-500" />
              <span>被执行人 (目标债务人) <span className="text-rose-500">*</span></span>
            </label>
            <input
              type="text"
              required
              value={caseMeta.respondentName || ''}
              onChange={e => handleChange('respondentName', e.target.value)}
              placeholder="请输入被执行人姓名或企业全称"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-medium"
            />
            <p className="text-[11px] text-slate-400 mt-1">系统将自动以该名称进行同姓近亲属推断与核心账户匹配</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1 flex items-center space-x-1.5">
              <Coins className="w-3.5 h-3.5 text-slate-400" />
              <span>执行标的本息总额 (元)</span>
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-2.5 text-slate-400 text-sm">¥</span>
              <input
                type="number"
                value={caseMeta.targetAmount || ''}
                onChange={e => handleChange('targetAmount', parseFloat(e.target.value) || 0)}
                placeholder="请输入申请执行标的金额，如 500000"
                className="w-full pl-8 pr-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-mono"
              />
            </div>
            <p className="text-[11px] text-slate-400 mt-1">用于自动计算执行期间进账对债务的履行覆盖率</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              被执行人身份证号 / 统一信用代码 (选填)
            </label>
            <input
              type="text"
              value={caseMeta.respondentIdCard || ''}
              onChange={e => handleChange('respondentIdCard', e.target.value)}
              placeholder="用于工商穿透与多卡归集"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-mono"
            />
          </div>
        </div>

        {/* Section: Timeline Setup */}
        <div className="pt-4 border-t border-slate-100 space-y-4">
          <div className="flex items-center space-x-2">
            <Calendar className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-bold text-slate-800">
              法律时间轴关键节点配置（用于时间切片打标）
            </h3>
          </div>
          <p className="text-xs text-slate-500">
            算法引擎将根据上述时间锚点，自动将流水划分为：立案前、立案后、财产令后及冻结后阶段，精准识别不同司法阶段的转移行为。
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                执行立案日期
              </label>
              <input
                type="date"
                value={caseMeta.timeline.executionFilingDate || ''}
                onChange={e => handleTimelineChange('executionFilingDate', e.target.value)}
                className="w-full px-3.5 py-2.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <p className="text-[10px] text-slate-400 mt-1">立案后转出即构成转移嫌疑</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                《报告财产令》送达日
              </label>
              <input
                type="date"
                value={caseMeta.timeline.reportOrderServedDate || ''}
                onChange={e => handleTimelineChange('reportOrderServedDate', e.target.value)}
                className="w-full px-3.5 py-2.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <p className="text-[10px] text-rose-500 mt-1">送达后转出直接构成拒执线索</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                账户冻结 / 终本裁定日 (选填)
              </label>
              <input
                type="date"
                value={caseMeta.timeline.freezeDate || ''}
                onChange={e => handleTimelineChange('freezeDate', e.target.value)}
                className="w-full px-3.5 py-2.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <p className="text-[10px] text-slate-400 mt-1">用于锁定突发大额转出节点</p>
            </div>
          </div>
        </div>

        {/* Submit Actions */}
        <div className="flex justify-end pt-4 border-t border-slate-100">
          <button
            onClick={onNext}
            disabled={!canProceed}
            className={`flex items-center space-x-2 px-6 py-2.5 rounded-xl font-medium text-sm transition ${
              canProceed
                ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-500/20'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            <span>保存建档，进入下一步上传流水</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
