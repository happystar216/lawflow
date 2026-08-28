import React, { useState } from 'react';
import { BankAccount, AccountOwnerType } from '../types/transaction';
import { CaseMetadata, AssetDeclarationItem } from '../types/case';
import { ArrowRight, ArrowLeft, Calendar, UserCheck, FileText, Plus, Trash2 } from 'lucide-react';

interface Step3Props {
  caseMeta: CaseMetadata;
  accounts: BankAccount[];
  onCaseMetaUpdated: (meta: CaseMetadata) => void;
  onAccountsUpdated: (accounts: BankAccount[]) => void;
  onNext: () => void;
  onPrev: () => void;
}

export const Step3PreAnnotation: React.FC<Step3Props> = ({
  caseMeta,
  accounts,
  onCaseMetaUpdated,
  onAccountsUpdated,
  onNext,
  onPrev
}) => {
  const [declaredCategory, setDeclaredCategory] = useState<AssetDeclarationItem['category']>('income');
  const [declaredContent, setDeclaredContent] = useState('');
  const [declaredValue, setDeclaredValue] = useState<number>(0);

  const handleAccountOwnerChange = (accNum: string, ownerType: AccountOwnerType) => {
    const updated = accounts.map(a => {
      if (a.accountNumber === accNum) {
        return { ...a, ownerType };
      }
      return a;
    });
    onAccountsUpdated(updated);
  };

  const handleTimelineChange = (field: keyof CaseMetadata['timeline'], value: string) => {
    onCaseMetaUpdated({
      ...caseMeta,
      timeline: {
        ...caseMeta.timeline,
        [field]: value
      }
    });
  };

  const handleAddDeclaredAsset = () => {
    if (!declaredContent.trim()) return;
    const newItem: AssetDeclarationItem = {
      id: `DEC_${Date.now()}`,
      category: declaredCategory,
      declaredContent,
      declaredValue
    };
    onCaseMetaUpdated({
      ...caseMeta,
      declaredAssets: [...(caseMeta.declaredAssets || []), newItem]
    });
    setDeclaredContent('');
    setDeclaredValue(0);
  };

  const handleRemoveDeclaredAsset = (id: string) => {
    onCaseMetaUpdated({
      ...caseMeta,
      declaredAssets: (caseMeta.declaredAssets || []).filter(a => a.id !== id)
    });
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 sm:px-6 space-y-6">
      {/* Step Header */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6">
        <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-md">
          Step 3 / 6 前置标注
        </span>
        <h2 className="text-xl font-bold text-slate-900 mt-2">账户归属认领、时间轴对齐与财产申报录入</h2>
        <p className="text-xs text-slate-500 mt-1">
          向算法注入案件上下文：标记哪些账户属于被执行人以执行内部对冲核销；精准校准案件关键时间节点；录入财产申报表以比对申报差异。
        </p>
      </div>

      {/* Section 1: Account Ownership Matrix */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
        <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
          <UserCheck className="w-4 h-4 text-blue-600" />
          <span>1. 银行账户归属矩阵认领（用于本人账户内部自转核销）</span>
        </h3>
        <p className="text-xs text-slate-500">
          仅被执行人本人账户之间金额一致、方向相反且时间接近的双边记录会自动核销。配偶、公司及疑似代持人账户仍作为外部流向保留，交由律师判断。
        </p>

        <div className="divide-y divide-slate-100">
          {accounts.map(acc => (
            <div key={acc.accountNumber} className="py-3 flex items-center justify-between flex-wrap gap-3">
              <div>
                <div className="text-xs font-bold text-slate-800">
                  {acc.bankName} - {acc.accountName || '未知户名'}
                </div>
                <div className="text-[11px] text-slate-400 font-mono">{acc.accountNumber}</div>
              </div>

              <div className="flex items-center space-x-2">
                <span className="text-xs text-slate-500">账户归属:</span>
                <select
                  value={acc.ownerType}
                  onChange={e => handleAccountOwnerChange(acc.accountNumber, e.target.value as AccountOwnerType)}
                  className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white font-medium text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="DEBTOR_MAIN">被执行人本人账户</option>
                  <option value="SPOUSE">配偶名下账户</option>
                  <option value="SOLE_CORP">名下一人独资企业公户</option>
                  <option value="SUSPECT_PROXY">疑似代持人/关联人账户</option>
                </select>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Section 2: Precise Legal Timeline */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
        <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
          <Calendar className="w-4 h-4 text-blue-600" />
          <span>2. 案件法律时间轴 (赋予流水法律证据效力)</span>
        </h3>
        <p className="text-xs text-slate-500">
          每一笔交易将根据下列时点被打上法律阶段标签。节点后的流出会被优先提示，但仅作为复核线索，不自动认定为转移财产。
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 pt-2">
          <div>
            <label className="block text-xs text-slate-600 mb-1">T0 债务形成/借款日</label>
            <input
              type="date"
              value={caseMeta.timeline.debtFormationDate || ''}
              onChange={e => handleTimelineChange('debtFormationDate', e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-600 mb-1">T1 诉讼立案/财产保全日</label>
            <input
              type="date"
              value={caseMeta.timeline.lawsuitFilingDate || ''}
              onChange={e => handleTimelineChange('lawsuitFilingDate', e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-600 mb-1">T2 裁判文书生效日</label>
            <input
              type="date"
              value={caseMeta.timeline.judgmentEffectiveDate || ''}
              onChange={e => handleTimelineChange('judgmentEffectiveDate', e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-blue-700 mb-1">
              T3 执行立案日 ⭐ (核心锚点)
            </label>
            <input
              type="date"
              value={caseMeta.timeline.executionFilingDate || ''}
              onChange={e => handleTimelineChange('executionFilingDate', e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-blue-300 bg-blue-50/20 font-medium"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-rose-700 mb-1">
              T4 《报告财产令》送达日 ⭐⭐ (拒执关键)
            </label>
            <input
              type="date"
              value={caseMeta.timeline.reportOrderServedDate || ''}
              onChange={e => handleTimelineChange('reportOrderServedDate', e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-rose-300 bg-rose-50/20 font-medium"
            />
          </div>

          <div>
            <label className="block text-xs text-slate-600 mb-1">T6 执行和解协议签署日</label>
            <input
              type="date"
              value={caseMeta.timeline.settlementDate || ''}
              onChange={e => handleTimelineChange('settlementDate', e.target.value)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300"
            />
          </div>
        </div>
      </div>

      {/* Section 3: False Asset Declaration Inputs (Rule 11) */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
        <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
          <FileText className="w-4 h-4 text-blue-600" />
          <span>3. 被执行人《财产申报表》内容录入 (用于虚假报告交叉核验)</span>
        </h3>
        <p className="text-xs text-slate-500">
          将被执行人向法院申报的“无收入/无存款”内容录入，算法将自动与其银行流水实际入账与存款进行碰撞比对，输出《虚假报告差异报告》。
        </p>

        {/* Declared Assets List */}
        <div className="space-y-2">
          {(caseMeta.declaredAssets || []).map(item => (
            <div key={item.id} className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between text-xs">
              <div>
                <span className="font-semibold text-slate-700 mr-2">
                  [{item.category === 'income' ? '申报收入' : (item.category === 'bank_account' ? '申报银行卡' : '其他财产')}]:
                </span>
                <span className="text-slate-800">{item.declaredContent}</span>
                <span className="text-slate-500 ml-2 font-mono">(申报价: ¥{item.declaredValue.toLocaleString()})</span>
              </div>
              <button
                onClick={() => handleRemoveDeclaredAsset(item.id)}
                className="text-slate-400 hover:text-rose-600 p-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        {/* Add Declaration Item */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-2">
          <select
            value={declaredCategory}
            onChange={e => setDeclaredCategory(e.target.value as any)}
            className="px-3 py-2 text-xs rounded-lg border border-slate-300 bg-white"
          >
            <option value="income">收入申报 (如声称无收入)</option>
            <option value="bank_account">银行存款申报</option>
            <option value="real_estate">房产车辆等</option>
            <option value="other">其他财产</option>
          </select>

          <input
            type="text"
            value={declaredContent}
            onChange={e => setDeclaredContent(e.target.value)}
            placeholder="申报描述，如：名下仅有一张建行卡，无稳定收入"
            className="sm:col-span-2 px-3 py-2 text-xs rounded-lg border border-slate-300"
          />

          <button
            onClick={handleAddDeclaredAsset}
            className="flex items-center justify-center space-x-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-xs font-medium transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>添加申报项</span>
          </button>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex justify-between items-center pt-4">
        <button
          onClick={onPrev}
          className="flex items-center space-x-1.5 px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 text-xs font-medium transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>返回确认</span>
        </button>

        <button
          onClick={onNext}
          className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm shadow-md shadow-blue-500/20 transition"
        >
          <span>进入步骤四：运行核心算法计算</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
