import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { CaseEvaluationReport } from '../types/evidence';
import { StandardTransaction } from '../types/transaction';
import { GitCommit, Network, X } from 'lucide-react';
import { effectiveCounterpartyName } from '../engine/bilateral';
import { classifyTransactionFlow } from '../engine/flowClassification';

interface VisualChartsProps {
  report: CaseEvaluationReport;
  transactions: StandardTransaction[];
  respondentName: string;
}

export const VisualCharts: React.FC<VisualChartsProps> = ({
  report,
  transactions,
  respondentName
}) => {
  const [chartType, setChartType] = useState<'sankey' | 'network'>('sankey');
  const [selectedFlow, setSelectedFlow] = useState<{ title: string; transactionIds: string[] } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  const selectedFlowTransactions = useMemo(() => {
    if (!selectedFlow) return [];
    const ids = new Set(selectedFlow.transactionIds);
    return transactions
      .filter(transaction => ids.has(transaction.id))
      .sort((left, right) => right.transactionTime.localeCompare(left.transactionTime));
  }, [selectedFlow, transactions]);

  useEffect(() => {
    if (!chartRef.current) return;

    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current);
    }

    const chart = chartInstance.current;

    if (chartType === 'sankey') {
      const nodesMap = new Map<string, any>();
      const links: any[] = [];
      const centerNode = `${respondentName || '被执行人'}的账户资金池`;
      nodesMap.set(centerNode, { name: centerNode, itemStyle: { color: '#1d4ed8' } });
      const flowCategories = report.analysisGraph?.flowCategories || (() => {
        const categories = new Map<string, any>();
        for (const transaction of transactions) {
          const classification = classifyTransactionFlow(transaction);
          if (!classification) continue;
          const current = categories.get(classification.code) || { ...classification, totalAmount: 0, transactionIds: [] };
          current.totalAmount += transaction.amount;
          current.transactionIds.push(transaction.id);
          categories.set(classification.code, current);
        }
        return [...categories.values()];
      })();

      flowCategories.forEach(category => {
        if (category.totalAmount <= 0 || !category.transactionIds.length) return;
        const nodeName = `${category.direction === 'IN' ? '流入' : '流出'}｜${category.label}`;
        const detail = {
          detailTitle: `${category.label}明细`,
          transactionIds: category.transactionIds,
          totalAmount: category.totalAmount,
          transactionCount: category.transactionIds.length
        };
        nodesMap.set(nodeName, { name: nodeName, itemStyle: { color: category.color }, ...detail });
        links.push(category.direction === 'IN'
          ? { source: nodeName, target: centerNode, value: category.totalAmount, ...detail }
          : { source: centerNode, target: nodeName, value: category.totalAmount, ...detail });
      });

      chart.setOption({
        tooltip: {
          trigger: 'item',
          triggerOn: 'mousemove',
          formatter: (params: any) => {
            if (params.dataType === 'edge') {
              return `${params.data.source} → ${params.data.target}<br/><b>¥ ${Number(params.data.value).toLocaleString()} 元</b><br/>${params.data.transactionCount || 0} 笔流水`;
            }
            const amount = params.data.totalAmount ? `<br/>¥ ${Number(params.data.totalAmount).toLocaleString()} 元 · ${params.data.transactionCount || 0} 笔` : '';
            return `<b>${params.name}</b>${amount}`;
          }
        },
        series: [
          {
            type: 'sankey',
            layout: 'none',
            nodeAlign: 'justify',
            layoutIterations: 64,
            nodeWidth: 16,
            nodeGap: 14,
            emphasis: { focus: 'adjacency' },
            data: Array.from(nodesMap.values()),
            links,
            lineStyle: {
              color: 'gradient',
              curveness: 0.5,
              opacity: 0.32
            },
            label: { fontSize: 11, color: '#334155', width: 135, overflow: 'break' }
          }
        ]
      }, true);
    } else {
      // 2. Prepare Force Network Data
      const nodes: any[] = [];
      const links: any[] = [];

      const centerId = 'MAIN_RESPONDENT';
      nodes.push({
        id: centerId,
        name: `${respondentName || '被执行人'}\n(核心账户群)`,
        symbolSize: 60,
        itemStyle: { color: '#1d4ed8' },
        label: { color: '#fff', fontSize: 11, fontWeight: 'bold' }
      });

      const topCps = Object.values(report.counterpartySummaries)
        .sort((a, b) => b.totalOut - a.totalOut)
        .slice(0, 10);

      topCps.forEach((cp, idx) => {
        const nodeId = `CP_${idx}`;
        const transactionIds = report.analysisGraph?.counterparties
          .filter(entity => entity.name === cp.name)
          .flatMap(entity => entity.outgoingTransactionIds)
          || transactions
            .filter(transaction => !transaction.isInternalTransfer
              && transaction.direction === 'OUT'
              && effectiveCounterpartyName(transaction) === cp.name)
            .map(transaction => transaction.id);
        let color = '#475569';
        if (cp.isSuspectedRelative) color = '#9333ea';
        else if (cp.isSuspectedAffiliate) color = '#ea580c';
        else if (/现金|ATM/.test(cp.name)) color = '#dc2626';
        else if (/证券|保险|理财/.test(cp.name)) color = '#059669';

        nodes.push({
          id: nodeId,
          name: `${cp.name}\n(¥${Math.round(cp.totalOut / 10000)}万)`,
          symbolSize: Math.max(30, Math.min(55, Math.sqrt(cp.totalOut / 1000) * 4)),
          itemStyle: { color },
          label: { fontSize: 10, color: '#334155' },
          detailTitle: `${cp.name}的流出流水`,
          transactionIds
        });

        links.push({
          source: centerId,
          target: nodeId,
          value: cp.totalOut,
          detailTitle: `${cp.name}的流出流水`,
          transactionIds,
          lineStyle: {
            width: Math.max(1, Math.min(6, cp.totalOut / 50000)),
            color,
            curveness: 0.1
          }
        });
      });

      chart.setOption({
        tooltip: {
          formatter: (params: any) => {
            if (params.dataType === 'edge') {
              return `资金流向：<b>¥ ${params.data.value.toLocaleString()} 元</b>`;
            }
            return `<b>${params.name}</b>`;
          }
        },
        series: [
          {
            type: 'graph',
            layout: 'force',
            animation: false,
            draggable: true,
            data: nodes,
            links,
            roam: true,
            label: { show: true, position: 'inside' },
            force: { repulsion: 350, edgeLength: [80, 160] }
          }
        ]
      }, true);
    }

    const clickHandler = (params: any) => {
      const transactionIds = Array.isArray(params?.data?.transactionIds)
        ? params.data.transactionIds as string[]
        : [];
      if (!transactionIds.length) return;
      setSelectedFlow({
        title: String(params.data.detailTitle || '对应流水明细'),
        transactionIds
      });
    };
    chart.off('click');
    chart.on('click', clickHandler);

    const resizeHandler = () => chart.resize();
    window.addEventListener('resize', resizeHandler);

    return () => {
      window.removeEventListener('resize', resizeHandler);
      chart.off('click', clickHandler);
    };
  }, [chartType, report, transactions, respondentName]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center space-x-2">
          <GitCommit className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-bold text-slate-800">
            资金来源、用途与关联方图谱
          </h3>
        </div>

        <div className="flex items-center bg-slate-100 p-1 rounded-xl">
          <button
            onClick={() => setChartType('sankey')}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition ${
              chartType === 'sankey'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <GitCommit className="w-3.5 h-3.5" />
            <span>资金用途分类</span>
          </button>

          <button
            onClick={() => setChartType('network')}
            className={`flex items-center space-x-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition ${
              chartType === 'network'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Network className="w-3.5 h-3.5" />
            <span>人物关系拓扑网络</span>
          </button>
        </div>
      </div>

      <div ref={chartRef} className="h-[420px] w-full" />

      <p className="text-xs text-slate-500 text-center">
        {chartType === 'sankey'
          ? '内部互转已剔除；按摘要、对手方和交易方向归类。司法划扣等重要类别不设金额门槛。点击节点或连线查看具体流水。'
          : '按具体对手方展示资金关系；点击节点或连线查看具体流水。'}
      </p>

      {selectedFlow && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/40 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-blue-100 bg-white/70">
            <div>
              <h4 className="text-sm font-semibold text-slate-800">{selectedFlow.title}</h4>
              <p className="text-[11px] text-slate-500 mt-0.5">共 {selectedFlowTransactions.length} 笔，以下为当前规范数据中的最新流水</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedFlow(null)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-white"
              aria-label="关闭流水明细"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="overflow-x-auto max-h-80">
            <table className="w-full min-w-[920px] text-xs">
              <thead className="sticky top-0 bg-slate-100 text-slate-600">
                <tr>
                  <th className="text-left font-medium px-3 py-2">交易时间</th>
                  <th className="text-left font-medium px-3 py-2">本方账户</th>
                  <th className="text-left font-medium px-3 py-2">方向</th>
                  <th className="text-right font-medium px-3 py-2">金额</th>
                  <th className="text-right font-medium px-3 py-2">余额</th>
                  <th className="text-left font-medium px-3 py-2">对手方/归类</th>
                  <th className="text-left font-medium px-3 py-2">摘要</th>
                  <th className="text-left font-medium px-3 py-2">原件位置</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {selectedFlowTransactions.map(transaction => (
                  <tr key={transaction.id} className="hover:bg-blue-50/50">
                    <td className="px-3 py-2 whitespace-nowrap text-slate-700">{transaction.transactionTime || '待核对'}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">{transaction.bankName} · …{transaction.accountNumber.slice(-4)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={transaction.direction === 'IN' ? 'text-emerald-600' : transaction.direction === 'OUT' ? 'text-rose-600' : 'text-amber-600'}>
                        {transaction.direction === 'IN' ? '收入' : transaction.direction === 'OUT' ? '支出' : '待核对'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-medium text-slate-800">¥{transaction.amount.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono text-slate-600">{transaction.balanceAvailable === false ? '未提供' : `¥${transaction.balance.toLocaleString()}`}</td>
                    <td className="px-3 py-2 text-slate-700">{transaction.counterpartyName || effectiveCounterpartyName(transaction)}</td>
                    <td className="px-3 py-2 text-slate-700">{transaction.summary || '—'}</td>
                    <td className="px-3 py-2 text-slate-500">{transaction.rawSourceFile}{transaction.rawPageNumber ? ` · 第${transaction.rawPageNumber}页` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-100 pt-2">
        {chartType === 'sankey' ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <LegendDot color="#be123c" label="司法划扣" />
            <LegendDot color="#b91c1c" label="现金取现" />
            <LegendDot color="#7c3aed" label="贷款还款" />
            <LegendDot color="#0891b2" label="投资理财" />
            <LegendDot color="#ea580c" label="消费支出" />
            <LegendDot color="#94a3b8" label="待核对" />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <LegendDot color="#9333ea" label="疑似亲属" />
            <LegendDot color="#ea580c" label="关联企业" />
            <LegendDot color="#dc2626" label="现金取现" />
            <LegendDot color="#059669" label="理财／保险" />
          </div>
        )}
        <span>{chartType === 'network' ? '支持拖拽节点与鼠标滚轮缩放' : '左侧为流入，右侧为流出'}</span>
      </div>
    </div>
  );
};

const LegendDot: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <span className="flex items-center space-x-1">
    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: color }} />
    <span>{label}</span>
  </span>
);
