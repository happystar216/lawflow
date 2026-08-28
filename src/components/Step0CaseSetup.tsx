import React from 'react';
import { CaseMetadata } from '../types/case';
import { Scale, ArrowRight, ShieldCheck } from 'lucide-react';

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
            <label className="block text-xs font-medium text-slate-700 mb-1">
              执行案号 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={caseMeta.caseNumber}
              onChange={e => handleChange('caseNumber', e.target.value)}
              placeholder="例如：(2024)京0105执8890号"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              执行法院 <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={caseMeta.courtName}
              onChange={e => handleChange('courtName', e.target.value)}
              placeholder="例如：北京市朝阳区人民法院"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              申请执行人 (债权人) <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={caseMeta.applicantName}
              onChange={e => handleChange('applicantName', e.target.value)}
              placeholder="个人姓名或企业名称"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              被执行人 (目标债务人) <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={caseMeta.respondentName}
              onChange={e => handleChange('respondentName', e.target.value)}
              placeholder="例如：胡艳红"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              执行标的本息总额 (元) <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-2.5 text-slate-400 text-sm">¥</span>
              <input
                type="number"
                value={caseMeta.targetAmount || ''}
                onChange={e => handleChange('targetAmount', parseFloat(e.target.value) || 0)}
                placeholder="1200000"
                className="w-full pl-8 pr-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
            </div>
            <p className="text-[11px] text-slate-400 mt-1">用于计算被执行人进账收入对债务的覆盖率</p>
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
              className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>
        </div>

        {/* Timeline Quick Settings */}
        <div className="border-t border-slate-100 pt-5">
          <h3 className="text-sm font-semibold text-slate-800 mb-3 flex items-center space-x-2">
            <span>关键法律时间锚点</span>
            <span className="text-xs text-slate-400 font-normal">（可在此快速录入，亦可在后续步骤调整）</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-slate-600 mb-1">T2 判决生效日</label>
              <input
                type="date"
                value={caseMeta.timeline.judgmentEffectiveDate || ''}
                onChange={e => handleTimelineChange('judgmentEffectiveDate', e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-600 mb-1 font-semibold text-blue-700">
                T3 执行立案日 ⭐
              </label>
              <input
                type="date"
                value={caseMeta.timeline.executionFilingDate || ''}
                onChange={e => handleTimelineChange('executionFilingDate', e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-blue-300 bg-blue-50/30 focus:border-blue-500 font-medium"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-600 mb-1 font-semibold text-rose-700">
                T4 《报告财产令》送达日 ⭐⭐
              </label>
              <input
                type="date"
                value={caseMeta.timeline.reportOrderServedDate || ''}
                onChange={e => handleTimelineChange('reportOrderServedDate', e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-rose-300 bg-rose-50/30 focus:border-rose-500 font-medium"
              />
            </div>
          </div>
        </div>

        {/* Privacy Note */}
        <div className="bg-slate-50 rounded-xl p-4 flex items-start space-x-3 border border-slate-200/60">
          <ShieldCheck className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs text-slate-600 leading-relaxed">
            <span className="font-semibold text-slate-800">CF 隐私与合规保障：</span>
            本工具采用 Cloudflare 边缘计算与浏览器端本地解析技术，银行流水明细数据仅在您的浏览器端进行内存对账运算，不进行明细落地存储，完全满足司法案件保密合规要求。
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="flex justify-end pt-4 border-t border-slate-100">
          <button
            onClick={onNext}
            className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm shadow-md shadow-blue-500/20 transition"
          >
            <span>保存并进入步骤一：上传流水</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
