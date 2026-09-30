import { runQualityTrial } from './qualityTrialPipeline';
import { withAnalysisTypeChecks } from '../review/qualityDelivery';
import { buildQualitySources, stabilizeQualityMapping, rebaseEmptyPageRecovery } from './qualitySources';
import { decidePreflight, type ModelReply, type PageMetrics, type QualityRequest, type VerbatimPage } from './qualityProtocol';
import { planPrimaryRecovery } from './primaryRecoveryPlan';
import { selectPrimaryRecovery } from './primaryRecoverySelection';
import { planAccountRecovery } from './accountRecoveryPlan';
import { planCriticalFieldRecovery } from './criticalFieldRecovery';
import type { IndependentPage } from './independentComparison';
import type { FocusedAccounts } from './accountRecovery';
import { missingMappedTables, type TableMappingPlan } from './tableMapping';

export interface QualityWorkflowIO {
  totalPages: number;
  preflightImages(page: number): Promise<{ images: string[]; metrics: PageMetrics }>;
  image(page: number, rotation: number, dpi: number): Promise<string>;
  call(input: QualityRequest, page: number, options?: { refresh?: boolean }): Promise<ModelReply>;
  progress(message: string, percent: number, rows?: number): void;
  signal: AbortSignal;
}
/** The browser and replay tests use the same orchestration and bounded recovery policies. */
export async function runQualityWorkflow(io: QualityWorkflowIO) {
  const preflight: Array<{ reading: any; decision: ReturnType<typeof decidePreflight>; metrics: PageMetrics }> = [];
  const primary: VerbatimPage[] = [], context: VerbatimPage[] = [];
  const independent: Record<number, IndependentPage> = {}, accounts: Record<number, FocusedAccounts> = {}, critical: Record<number, IndependentPage> = {};
  const check = () => io.signal.throwIfAborted();
  const parallelPages = async (pages: number[], fn: (page: number) => Promise<void>) => {
    let index = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(3, pages.length) }, async () => {
      while (index < pages.length) { check(); await fn(pages[index++]); }
    }));
    check();
    const error = outcomes.find((r): r is PromiseRejectedResult => r.status === 'rejected'); if (error) throw error.reason;
  };
  const pages = Array.from({ length: io.totalPages }, (_, i) => i + 1);
  let completed = 0;
  // No transcription starts until the complete page inventory has passed Gemini preflight.
  await parallelPages(pages, async page => {
    io.progress(`检查空白页和方向：第 ${page}/${io.totalPages} 页`, 2 + completed / io.totalPages * 16);
    const { images, metrics } = await io.preflightImages(page);
    const { result: reading } = await io.call({ stage: 'preflight', images }, page); check();
    preflight[page - 1] = { reading, metrics, decision: decidePreflight(reading, metrics) }; completed++;
  });
  completed = 0;
  await parallelPages(pages, async page => {
    check(); const decision = preflight[page - 1].decision;
    if (decision.blankConfirmed) {
      primary[page - 1] = { nearTableText: [], tables: [] }; context[page - 1] = { nearTableText: [], tables: [] };
      independent[page] = { pageType: 'blank', coverage: 'complete', pageIssues: [], rows: [], bankName: '', ownerNames: [], ownerIdentifiers: [] };
    } else {
      io.progress(`照录整页原文：第 ${page}/${io.totalPages} 页`, 18 + completed / io.totalPages * 48);
      const image = await io.image(page, decision.clockwiseRotation, 350);
      // Independent reader receives only the image, never the primary transcript.
      const readings = await Promise.allSettled((['primary', 'independent', 'context'] as const)
        .map(stage => io.call({ stage, images: [image] }, page)));
      const failed = readings.find((r): r is PromiseRejectedResult => r.status === 'rejected'); if (failed) throw failed.reason;
      const values = readings.map(r => (r as PromiseFulfilledResult<ModelReply>).value.result);
      [primary[page - 1], independent[page], context[page - 1]] = values;
      if (decision.orientationUncertain) {
        independent[page] = { ...independent[page], coverage: 'uncertain',
          pageIssues: [...independent[page].pageIssues, '页面方向未能确认，请查看整页原件'] };
      }
    }
    completed++;
  });
  const merged = () => primary.map((p, i) => ({ ...p, nearTableText: [...new Set([...p.nearTableText, ...context[i].nearTableText])] }));
  let { registry, source } = buildQualitySources(merged());
  io.progress('按完整原文列表整理账户和流水…', 68);
  let mapping: TableMappingPlan = (await io.call({ stage: 'mapping', source }, 0)).result;
  // A PDF upload can contain multiple banks; do not assume a single issuer from a filename.
  const scope = { singleIssuerDocument: false };
  let result: ReturnType<typeof runQualityTrial> | undefined;
  let mappingFeedback = '';
  try {
    const missing = missingMappedTables(mapping, registry);
    if (missing.length) mappingFeedback = `遗漏输入表格（页:表）：${missing.join('、')}`;
    else result = runQualityTrial(mapping, registry, independent, scope);
  } catch (error) { mappingFeedback = error instanceof Error ? error.message : '来源引用无效'; }
  if (!result) {
    io.progress('重新整理遗漏表格或无效来源引用…', 70);
    // One bounded retry of the same full list bypasses only its cached reply.
    // A second invalid reference still fails; omissions remain REQUIRED issues.
    mapping = (await io.call({ stage: 'mapping', source, mappingFeedback: mappingFeedback.slice(0, 4000) }, 0, { refresh: true })).result;
    result = runQualityTrial(mapping, registry, independent, scope);
  }
  const primaryPlan = planPrimaryRecovery(result.pending, registry);
  const primarySelections: Record<number, ReturnType<typeof selectPrimaryRecovery>['decision']> = {};
  const primaryFailures: Array<{ page: number; reason: string }> = [];
  if (primaryPlan.selected.length) {
    let primaryChanged = false;
    let primaryCompleted = 0;
    io.progress(`重新读取 ${primaryPlan.selected.length} 页的原文差异…`, 74);
    await parallelPages(primaryPlan.selected.map(p => p.page), async page => {
      const image = await io.image(page, preflight[page - 1].decision.clockwiseRotation, 350);
      try {
        const reread = (await io.call({ stage: 'primaryRecovery', images: [image] }, page)).result;
        const selection = selectPrimaryRecovery(primary[page - 1], reread, independent[page]);
        primaryChanged ||= selection.selected !== primary[page - 1];
        primary[page - 1] = selection.selected;
        primarySelections[page] = selection.decision;
      } catch (error) {
        check();
        // A failed supplemental reading cannot erase a successful original.
        // Configuration changes still stop the run to avoid mixing policies.
        if (/配置已更新|缺少配置/.test(String(error))) throw error;
        primaryFailures.push({ page, reason: error instanceof Error ? error.message : String(error) });
      }
      primaryCompleted++;
      io.progress(`已处理 ${primaryCompleted}/${primaryPlan.selected.length} 页原文差异${primaryFailures.length ? '，未完成的重读已保留原结果' : ''}…`,
        74 + primaryCompleted / primaryPlan.selected.length * 5);
    });
    if (primaryChanged) {
      io.progress('根据补充原文重新整理流水…', 79);
      const next = buildQualitySources(merged());
      const rebased = rebaseEmptyPageRecovery(mapping, registry, next.registry);
      if (rebased) mapping = rebased;
      else {
        const fresh: TableMappingPlan = (await io.call({ stage: 'mapping', source: next.source }, 0)).result;
        mapping = stabilizeQualityMapping(mapping, fresh, registry, next.registry);
      }
      registry = next.registry; source = next.source;
      result = runQualityTrial(mapping, registry, independent, scope);
    }
  }
  const accountPlan = planAccountRecovery(result.pending, registry, independent);
  const accountFailures: Array<{ page: number; reason: string }> = [];
  io.progress(`核实账号归属${accountPlan.selected.length ? `（${accountPlan.selected.length} 页）` : ''}…`, 82, result.rows.length);
  await parallelPages(accountPlan.selected.map(p => p.page), async page => {
    try {
      accounts[page] = (await io.call({ stage: 'accounts', images: [await io.image(page, preflight[page - 1].decision.clockwiseRotation, 350)] }, page)).result;
    } catch (error) {
      check(); if (/配置已更新|缺少配置/.test(String(error))) throw error;
      accountFailures.push({ page, reason: error instanceof Error ? error.message : String(error) });
      io.progress(`第 ${page} 页账号补充读取未完成，已保留原结果和待确认提示…`, 82, result!.rows.length);
    }
  });
  result = runQualityTrial(mapping, registry, independent, scope, accounts);
  const criticalPlan = planCriticalFieldRecovery(result.pending, registry);
  const criticalFailures: Array<{ page: number; reason: string }> = [];
  io.progress(`核实关键字段差异${criticalPlan.selected.length ? `（${criticalPlan.selected.length} 页）` : ''}…`, 90, result.rows.length);
  await parallelPages(criticalPlan.selected.map(p => p.page), async page => {
    try {
      critical[page] = (await io.call({ stage: 'critical', images: [await io.image(page, preflight[page - 1].decision.clockwiseRotation, 350)] }, page)).result;
    } catch (error) {
      check(); if (/配置已更新|缺少配置/.test(String(error))) throw error;
      criticalFailures.push({ page, reason: error instanceof Error ? error.message : String(error) });
      io.progress(`第 ${page} 页关键字段补充读取未完成，已保留原结果和待确认提示…`, 90, result!.rows.length);
    }
  });
  check(); result = withAnalysisTypeChecks(runQualityTrial(mapping, registry, independent, scope, accounts, critical), registry);
  io.progress('已完成识别并列出待确认项', 100, result.rows.length);
  return { result, registry, mapping, preflight, primary, context, independent, accounts, critical,
    recoveryPlans: { primary: { ...primaryPlan, selections: primarySelections, failures: primaryFailures },
      accounts: { ...accountPlan, failures: accountFailures }, critical: { ...criticalPlan, failures: criticalFailures } } };
}
