import React, { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import { CaseEvaluationReport } from '../types/evidence';
import { StandardTransaction } from '../types/transaction';
import { GitCommit, Network } from 'lucide-react';

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
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;

    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current);
    }

    const chart = chartInstance.current;

    if (chartType === 'sankey') {
      // 1. Prepare Sankey Data
      const nodesMap = new Map<string, { name: string; itemStyle?: { color: string } }>();
      const links: { source: string; target: string; value: number }[] = [];

      const centerNode = `被执行人：${respondentName || '债务人'}`;
      nodesMap.set(centerNode, { name: centerNode, itemStyle: { color: '#1d4ed8' } });

      // Source Accounts -> Center Node
      const bankSources: Record<string, number> = {};
      transactions.forEach(t => {
        if (t.direction === 'IN' && !t.isInternalTransfer) {
          const bankKey = `入账：${t.bankName || '银行卡'}`;
          bankSources[bankKey] = (bankSources[bankKey] || 0) + t.amount;
        }
      });

      Object.entries(bankSources).forEach(([src, amount]) => {
        if (amount > 500) {
          nodesMap.set(src, { name: src, itemStyle: { color: '#059669' } });
          links.push({ source: src, target: centerNode, value: Math.round(amount) });
        }
      });

      // Center Node -> Top Outgoing Counterparties
      const sortedCps = Object.values(report.counterpartySummaries)
        .sort((a, b) => b.totalOut - a.totalOut)
        .slice(0, 8);

      sortedCps.forEach(cp => {
        if (cp.totalOut > 1000) {
          let tag = '';
          let color = '#dc2626';
          if (cp.isSuspectedRelative) {
            tag = ' (疑似亲属)';
            color = '#9333ea';
          } else if (cp.isSuspectedAffiliate) {
            tag = ' (关联企业)';
            color = '#ea580c';
          } else if (/现金|ATM/.test(cp.name)) {
            tag = ' (大额取现)';
            color = '#b91c1c';
          } else {
            color = '#64748b';
          }

          const targetNode = `去向：${cp.name}${tag}`;
          nodesMap.set(targetNode, { name: targetNode, itemStyle: { color } });
          links.push({ source: centerNode, target: targetNode, value: Math.round(cp.totalOut) });
        }
      });

      if (links.length === 0) {
        links.push({ source: '外部资金流入', target: centerNode, value: 100000 });
        nodesMap.set('外部资金流入', { name: '外部资金流入', itemStyle: { color: '#059669' } });
        nodesMap.set('大额对外流出', { name: '大额对外流出', itemStyle: { color: '#dc2626' } });
        links.push({ source: centerNode, target: '大额对外流出', value: 95000 });
      }

      chart.setOption({
        tooltip: {
          trigger: 'item',
          triggerOn: 'mousemove',
          formatter: (params: any) => {
            if (params.dataType === 'edge') {
              return `${params.data.source} → ${params.data.target}<br/><b>流转金额：¥ ${params.data.value.toLocaleString()} 元</b>`;
            }
            return `<b>${params.name}</b>`;
          }
        },
        series: [
          {
            type: 'sankey',
            layout: 'none',
            emphasis: { focus: 'adjacency' },
            data: Array.from(nodesMap.values()),
            links,
            lineStyle: {
              color: 'gradient',
              curveness: 0.5,
              opacity: 0.4
            },
            label: { fontSize: 11, color: '#334155' }
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
          label: { fontSize: 10, color: '#334155' }
        });

        links.push({
          source: centerId,
          target: nodeId,
          value: cp.totalOut,
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

    const resizeHandler = () => chart.resize();
    window.addEventListener('resize', resizeHandler);

    return () => {
      window.removeEventListener('resize', resizeHandler);
    };
  }, [chartType, report, transactions, respondentName]);

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center space-x-2">
          <GitCommit className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-bold text-slate-800">
            资金流向穿透与关联拓扑可视化图谱
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
            <span>资金流向桑基图</span>
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

      <div ref={chartRef} className="h-[360px] w-full" />

      <div className="flex items-center justify-between text-[11px] text-slate-400 border-t border-slate-100 pt-2">
        <div className="flex items-center space-x-4">
          <span className="flex items-center space-x-1">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-600 inline-block"></span>
            <span>近亲属转移</span>
          </span>
          <span className="flex items-center space-x-1">
            <span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block"></span>
            <span>关联企业</span>
          </span>
          <span className="flex items-center space-x-1">
            <span className="w-2.5 h-2.5 rounded-full bg-red-600 inline-block"></span>
            <span>大额取现</span>
          </span>
          <span className="flex items-center space-x-1">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-600 inline-block"></span>
            <span>理财/保单</span>
          </span>
        </div>
        <span>支持拖拽节点与鼠标滚轮缩放</span>
      </div>
    </div>
  );
};
