import { planningPages, validateStatementPages, unknownStatementPage, type PlanningPage, type StatementPage } from './statementPlan';
import { recognitionInputKey, type RecognitionResumeStore } from './resume';

export async function requestStatementPlan(pages: PlanningPage[], options: {
  signal?: AbortSignal;
  resumeStore?: RecognitionResumeStore;
  forceFresh?: boolean;
  onProgress?: (completed: number) => void;
  onWarning?: (message: string) => void;
} = {}): Promise<StatementPage[]> {
  const excerpts = planningPages(pages);
  const batches: Array<{ targetPages: number[]; pages: PlanningPage[] }> = [];
  for (let start = 0; start < excerpts.length; start += 8) batches.push({
    targetPages: excerpts.slice(start, start + 8).map(page => page.page),
    pages: excerpts.slice(Math.max(0, start - 1), start + 8)
  });
  const results: StatementPage[] = [];
  let cursor = 0;
  let completed = 0;
  let serviceUnavailable = false;
  let failureReason = '';
  let outageFailures = 0;
  const worker = async () => {
    while (cursor < batches.length) {
      options.signal?.throwIfAborted();
      const batch = batches[cursor++];
      const key = await recognitionInputKey(batch);
      let raw: StatementPage[] | undefined;
      if (!options.forceFresh && options.resumeStore?.loadPlanningBatch) {
        try { raw = await options.resumeStore.loadPlanningBatch(batch.targetPages[0], key); }
        catch { options.onWarning?.('未能读取分组进度，将重新分析账单边界。'); }
      }
      if (!raw && serviceUnavailable) raw = batch.targetPages.map(page =>
        unknownStatementPage(page, `分组服务不可用${failureReason}，本页独立处理`));
      if (!raw) {
        const controller = new AbortController();
        const abort = () => controller.abort(options.signal?.reason);
        const timer = setTimeout(() => controller.abort(new Error('账单分组超时')), 50_000);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        let outage = false;
        try {
          let response = await fetch('/api/plan-statements', { method: 'POST', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
          if (!response.ok) {
            outage = [401, 403, 429, 503, 504].includes(response.status);
            const detail = await response.json().catch(() => ({})) as { error?: string; code?: string };
            if (response.status === 502 && (detail.code === 'OUTPUT_LIMIT' || /未完整返回/.test(detail.error || ''))
              && batch.targetPages.length > 1) {
              // One bounded split retry, preserving successful halves. The
              // original timeout still bounds this batch's total wall time.
              const recovered: StatementPage[] = [];
              const size = Math.ceil(batch.targetPages.length / 2);
              for (let offset = 0; offset < batch.targetPages.length; offset += size) {
                options.signal?.throwIfAborted();
                const targetPages = batch.targetPages.slice(offset, offset + size);
                const sub = { targetPages, pages: batch.pages.filter(page => targetPages.includes(page.page) || page.page === targetPages[0] - 1) };
                try {
                  const retry = await fetch('/api/plan-statements', { method: 'POST', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
                  if (!retry.ok) throw new Error(`服务返回异常（${retry.status}）`);
                  recovered.push(...validateStatementPages((await retry.json()).pages, sub.pages, targetPages));
                } catch (error) {
                  options.signal?.throwIfAborted();
                  recovered.push(...targetPages.map(page => unknownStatementPage(page,
                    `缩小分组范围后仍未完成（${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}），本页独立处理`)));
                }
              }
              response = new Response(JSON.stringify({ pages: recovered }));
              options.onWarning?.('部分分组结果过长，已缩小范围重试；成功页面保留，其他批次继续。');
            } else throw new Error(`服务返回异常（${response.status}）${detail.error ? `：${detail.error.slice(0, 400)}` : ''}`);
          }
          raw = validateStatementPages((await response.json()).pages, batch.pages, batch.targetPages);
          outageFailures = 0;
          if (raw.every(page => page.type !== 'UNKNOWN' && page.relation !== 'UNKNOWN'
            && page.confidence >= 0.9 && !page.issues.length) && options.resumeStore?.savePlanningBatch) {
            try { await options.resumeStore.savePlanningBatch(batch.targetPages[0], key, raw); }
            catch { options.onWarning?.('本次分组结果无法保存，重新上传时可能需要再次分组。'); }
          }
        } catch (error) {
          options.signal?.throwIfAborted();
          // A malformed batch is not a document-wide outage.
          outage ||= controller.signal.aborted || error instanceof TypeError;
          outageFailures = outage ? outageFailures + 1 : 0;
          serviceUnavailable = outageFailures >= 2;
          failureReason = `（${error instanceof Error ? error.message.slice(0, 500) : '未知错误'}）`;
          raw = batch.targetPages.map(page => unknownStatementPage(page, `分组服务未完成${failureReason}，本页独立处理`));
          options.onWarning?.(serviceUnavailable
            ? '账单分组服务连续不可用，其余页面将独立识别，已有结果仍保留。'
            : `第 ${batch.targetPages[0]}—${batch.targetPages.at(-1)} 页分组未完成；只影响本批，其他页面继续分组。`);
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        }
      }
      // Revalidate persisted descriptors against the current input, never trust cache blindly.
      results.push(...validateStatementPages(raw, pages, batch.targetPages));
      completed += batch.targetPages.length;
      options.onProgress?.(completed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, () => worker()));
  return results.sort((a, b) => a.page - b.page);
}
