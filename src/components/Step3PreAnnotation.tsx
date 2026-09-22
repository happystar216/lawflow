import React, { useMemo, useState } from 'react';
import { BankAccount, AccountOwnerType } from '../types/transaction';
import { CaseMetadata, AssetDeclarationItem } from '../types/case';
import { ArrowRight, ArrowLeft, Calendar, UserCheck, FileText, Plus, Trash2 } from 'lucide-react';
import { accountIdentityKey } from '../utils/accountIdentity';
import { cleanAccountHolderName } from '../utils/recognizedDataNormalizer';

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
  const [missingFields, setMissingFields] = useState<string[]>([]);

  const ownershipGroups = useMemo(() => {
    const groups = new Map<string, BankAccount[]>();
    for (const account of accounts.filter(item => item.ownerType !== 'UNKNOWN' && item.transactionCount > 0)) {
      const holder = cleanAccountHolderName(account.accountName);
      groups.set(holder, [...(groups.get(holder) || []), account]);
    }
    return [...groups.entries()].map(([holder, holderAccounts]) => ({ holder, accounts: holderAccounts }));
  }, [accounts]);

  const handleAccountOwnerChange = (accountKey: string, ownerType: AccountOwnerType) => {
    const updated = accounts.map(a => {
      if (accountIdentityKey(a) === accountKey) {
        return { ...a, ownerType };
      }
      return a;
    });
    onAccountsUpdated(updated);
  };

  const handleHolderOwnerChange = (holder: string, ownerType: AccountOwnerType) => {
    onAccountsUpdated(accounts.map(account => (
      cleanAccountHolderName(account.accountName) === holder && account.ownerType !== 'UNKNOWN'
        ? { ...account, ownerType }
        : account
    )));
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

  const handleNext = () => {
    const missing = [
      !caseMeta.timeline.debtFormationDate && 'T0 债务形成/借款日',
      !caseMeta.timeline.lawsuitFilingDate && 'T1 诉讼立案/财产保全日',
      !caseMeta.timeline.judgmentEffectiveDate && 'T2 裁判文书生效日',
      !caseMeta.timeline.executionFilingDate && 'T3 执行立案日',
      !caseMeta.timeline.reportOrderServedDate && 'T4 《报告财产令》送达日',
      !caseMeta.timeline.settlementDate && 'T6 执行和解协议签署日'
    ].filter(Boolean) as string[];
    if (missing.length) {
      setMissingFields(missing);
      return;
    }
    const t = caseMeta.timeline;
    const pairs: Array<[string, string, string, string]> = [
      ['债务形成/借款日', t.debtFormationDate!, '诉讼立案/财产保全日', t.lawsuitFilingDate!],
      ['诉讼立案/财产保全日', t.lawsuitFilingDate!, '裁判文书生效日', t.judgmentEffectiveDate!],
      ['裁判文书生效日', t.judgmentEffectiveDate!, '执行立案日', t.executionFilingDate!],
      ['执行立案日', t.executionFilingDate!, '《报告财产令》送达日', t.reportOrderServedDate!],
      ['执行立案日', t.executionFilingDate!, '执行和解协议签署日', t.settlementDate!]
    ];
    const orderErrors = pairs.filter(([, from, , to]) => from > to)
      .map(([fromLabel, from, toLabel, to]) => `时间节点错误：${fromLabel}（${from}）必须早于${toLabel}（${to}）`);
    if (orderErrors.length) {
      setMissingFields(orderErrors);
      return;
    }
    setMissingFields([]);
    onNext();
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
          {ownershipGroups.map(group => {
            const ownerTypes = [...new Set(group.accounts.map(account => account.ownerType))];
            const groupOwnerType = ownerTypes.length === 1 ? ownerTypes[0] : 'UNKNOWN';
            return (
              <div key={group.holder} className="py-4">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <div className="text-sm font-bold text-slate-800">{group.holder}</div>
                    <div className="text-[11px] text-slate-500">名下共 {group.accounts.length} 个识别账户，一次确认即可应用到全部账户</div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-xs text-slate-500">账户归属:</span>
                    <select
                      value={groupOwnerType}
                      onChange={event => handleHolderOwnerChange(group.holder, event.target.value as AccountOwnerType)}
                      className="px-3 py-1.5 text-xs rounded-lg border border-slate-300 bg-white font-medium text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {groupOwnerType === 'UNKNOWN' && <option value="UNKNOWN">各账户归属不一致</option>}
                      <option value="DEBTOR_MAIN">被执行人本人账户</option>
                      <option value="SPOUSE">配偶名下账户</option>
                      <option value="SOLE_CORP">名下一人独资企业公户</option>
                      <option value="SUSPECT_PROXY">疑似代持人/关联人账户</option>
                    </select>
                  </div>
                </div>
                <details className="mt-3 rounded-lg bg-slate-50 border border-slate-100">
                  <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600">查看并单独调整账户</summary>
                  <div className="divide-y divide-slate-200 border-t border-slate-200">
                    {group.accounts.map(account => (
                      <div key={accountIdentityKey(account)} className="px-3 py-2 flex items-center justify-between gap-3 flex-wrap">
                        <div>
                          <div className="text-xs font-medium text-slate-700">{account.bankName}</div>
                          <div className="text-[11px] text-slate-400 font-mono">{account.accountNumber}</div>
                        </div>
                        <select
                          value={account.ownerType}
                          onChange={event => handleAccountOwnerChange(accountIdentityKey(account), event.target.value as AccountOwnerType)}
                          className="px-2 py-1 text-[11px] rounded-md border border-slate-300 bg-white"
                        >
                          <option value="DEBTOR_MAIN">被执行人本人账户</option>
                          <option value="SPOUSE">配偶名下账户</option>
                          <option value="SOLE_CORP">名下一人独资企业公户</option>
                          <option value="SUSPECT_PROXY">疑似代持人/关联人账户</option>
                        </select>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            );
          })}
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
        <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-[11px] leading-5 text-slate-600">
          <div><b>T0 债务形成/借款日：</b>债务实际发生的起点。</div>
          <div><b>T1 诉讼立案/财产保全日：</b>法院正式受理维权的日期，必须晚于 T0。</div>
          <div><b>T2 裁判文书生效日：</b>判决或调解书产生法律效力的日期，必须晚于 T1。</div>
          <div><b>T3 执行立案日：</b>申请强制执行并由法院正式立案的日期，必须晚于 T2。</div>
          <div><b>T4 报告财产令送达日：</b>执行中法院要求报告财产的送达日期，必须晚于 T3。</div>
          <div><b>T6 执行和解协议签署日：</b>执行过程中达成分期或其他和解的日期，必须晚于 T3。</div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 pt-2">
          <div>
            <label className="block text-xs text-slate-600 mb-1">T0 债务形成/借款日 <span className="text-rose-600">*</span></label>
            <input
              type="date"
              value={caseMeta.timeline.debtFormationDate || ''}
              onChange={e => handleTimelineChange('debtFormationDate', e.target.value)}
              className={`w-full px-3 py-2 text-xs rounded-lg border ${missingFields.includes('T0 债务形成/借款日') ? 'border-rose-500 bg-rose-50 ring-2 ring-rose-200' : 'border-slate-300'}`}
            />
          </div>

          <div>
            <label className="block text-xs text-slate-600 mb-1">T1 诉讼立案/财产保全日 <span className="text-rose-600">*</span></label>
            <input
              type="date"
              value={caseMeta.timeline.lawsuitFilingDate || ''}
              onChange={e => handleTimelineChange('lawsuitFilingDate', e.target.value)}
              className={`w-full px-3 py-2 text-xs rounded-lg border ${missingFields.includes('T1 诉讼立案/财产保全日') ? 'border-rose-500 bg-rose-50 ring-2 ring-rose-200' : 'border-slate-300'}`}
            />
          </div>

          <div>
            <label className="block text-xs text-slate-600 mb-1">T2 裁判文书生效日 <span className="text-rose-600">*</span></label>
            <input
              type="date"
              value={caseMeta.timeline.judgmentEffectiveDate || ''}
              onChange={e => handleTimelineChange('judgmentEffectiveDate', e.target.value)}
              className={`w-full px-3 py-2 text-xs rounded-lg border ${missingFields.includes('T2 裁判文书生效日') ? 'border-rose-500 bg-rose-50 ring-2 ring-rose-200' : 'border-slate-300'}`}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-blue-700 mb-1">
              T3 执行立案日 ⭐ (核心锚点) <span className="text-rose-600">*</span>
            </label>
            <input
              type="date"
              value={caseMeta.timeline.executionFilingDate || ''}
              onChange={e => handleTimelineChange('executionFilingDate', e.target.value)}
              className={`w-full px-3 py-2 text-xs rounded-lg border font-medium ${missingFields.includes('T3 执行立案日') ? 'border-rose-500 bg-rose-50 ring-2 ring-rose-200' : 'border-blue-300 bg-blue-50/20'}`}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-rose-700 mb-1">
              T4 《报告财产令》送达日 ⭐⭐（重点核查节点） <span className="text-rose-600">*</span>
            </label>
            <input
              type="date"
              value={caseMeta.timeline.reportOrderServedDate || ''}
              onChange={e => handleTimelineChange('reportOrderServedDate', e.target.value)}
              className={`w-full px-3 py-2 text-xs rounded-lg border font-medium ${missingFields.includes('T4 《报告财产令》送达日') ? 'border-rose-500 bg-rose-50 ring-2 ring-rose-200' : 'border-rose-300 bg-rose-50/20'}`}
            />
          </div>

          <div>
            <label className="block text-xs text-slate-600 mb-1">T6 执行和解协议签署日 <span className="text-rose-600">*</span></label>
            <input
              type="date"
              value={caseMeta.timeline.settlementDate || ''}
              onChange={e => handleTimelineChange('settlementDate', e.target.value)}
              className={`w-full px-3 py-2 text-xs rounded-lg border ${missingFields.includes('T6 执行和解协议签署日') ? 'border-rose-500 bg-rose-50 ring-2 ring-rose-200' : 'border-slate-300'}`}
            />
          </div>
        </div>
      </div>

      {/* Section 3: False Asset Declaration Inputs (Rule 11) */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 space-y-4">
        <h3 className="text-sm font-bold text-slate-800 flex items-center space-x-2">
          <FileText className="w-4 h-4 text-blue-600" />
          <span>3. 被执行人《财产申报表》内容录入（用于申报差异核对）</span>
        </h3>
        <p className="text-xs text-slate-500">
          将被执行人向法院申报的“无收入/无存款”等内容录入，系统会与银行流水进行差异比对。是否属于虚假报告，仍需律师结合申报义务、时间范围和其他证据判断。
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
          onClick={handleNext}
          className="flex items-center space-x-2 px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-medium text-sm shadow-md shadow-blue-500/20 transition"
        >
          <span>进入步骤四：运行核心算法计算</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
      {missingFields.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-rose-200 p-6">
            <h3 className="text-base font-bold text-rose-700">{missingFields.some(field => field.startsWith('时间节点错误')) ? '时间节点错误' : '还有未填写的必填项'}</h3>
            <p className="mt-2 text-xs text-slate-600">{missingFields.some(field => field.startsWith('时间节点错误')) ? '请按案件时间先后关系修改以下日期：' : '请填写以下内容后，才能进入下一分页：'}</p>
            <ul className="mt-3 space-y-2 text-sm text-rose-700 list-disc pl-5">
              {missingFields.map(field => <li key={field}>{field}</li>)}
            </ul>
            <button type="button" onClick={() => setMissingFields([])} className="mt-5 w-full rounded-xl bg-rose-600 py-2.5 text-sm font-semibold text-white hover:bg-rose-700">返回填写</button>
          </div>
        </div>
      )}
    </div>
  );
};
