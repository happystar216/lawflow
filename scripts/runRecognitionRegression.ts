import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { freezeQualityRecognitionRecord, type QualityRecognitionRecord } from '../src/recognition/qualityRunRecord';

/** A client of the existing web runner, never a second recognition pipeline.
 * The runner uploads to the deployed page; that page calls its own /api/recognize-quality.
 */
async function main() {
  const { values } = parseArgs({ options: {
    pdf: { type: 'string', multiple: true }, 'pdf-directory': { type: 'string' },
    output: { type: 'string' }, target: { type: 'string' }, server: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log('先启动 npm run debug:online，然后 npm run recognition:regression -- --pdf 文件.pdf --output 新目录 [--target 网页网址]');
    console.log('批量：--pdf-directory 目录。使用正式网页和同一识别接口；不接收模型密钥、图片目录或历史模型答案。');
    return;
  }
  const files = [...(values.pdf || [])];
  if (values['pdf-directory']) {
    const dir = resolve(values['pdf-directory']);
    files.push(...(await readdir(dir)).filter(n => n.toLowerCase().endsWith('.pdf')).sort().map(n => join(dir, n)));
  }
  if (!files.length || !values.output) throw new Error('需要 --pdf（或 --pdf-directory）和新的 --output 目录');
  const server = new URL(values.server || 'http://127.0.0.1:4318');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)) throw new Error('测试驱动服务必须在本机运行');
  const headers = process.env.LAWFLOW_DEBUG_TOKEN ? { Authorization: `Bearer ${process.env.LAWFLOW_DEBUG_TOKEN}` } : undefined;
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(new URL(path, server), { ...init, headers, signal: AbortSignal.timeout(60_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `测试驱动服务返回 HTTP ${response.status}`);
    return value;
  };
  await request('/health');
  const root = resolve(values.output);
  // Never replace a prior run or silently resume it.
  await mkdir(root, { recursive: false });
  await writeFile(join(root, 'run.json'), JSON.stringify({ protocol: 'PRODUCTION_WEB_FRESH',
    createdAt: new Date().toISOString(), files: files.map(p => basename(p)), standardAnswersRead: false }, null, 2));
  let failures = 0;
  for (const [index, path] of files.entries()) {
    const dir = join(root, String(index + 1).padStart(2, '0'));
    await mkdir(dir);
    try {
      const bytes = await readFile(path);
      const sourceSHA256 = createHash('sha256').update(bytes).digest('hex');
      const form = new FormData();
      form.set('file', new Blob([bytes], { type: 'application/pdf' }), basename(path));
      form.set('mode', 'recognition');
      form.set('respondentName', '正式识别回测');
      if (values.target) form.set('target', values.target);
      let run = await request('/debug/runs', { method: 'POST', body: form });
      await writeFile(join(dir, 'submission.json'), JSON.stringify({ ...run, sourceSHA256 }, null, 2));
      console.log(`${basename(path)}：已提交正式网页，运行 ${run.runId}`);
      let prior = '';
      while (['QUEUED', 'RUNNING'].includes(run.status)) {
        await new Promise(r => setTimeout(r, 2000));
        run = await request(`/debug/runs/${run.runId}`);
        const progress = run.progress?.statusText || run.status;
        if (progress !== prior) { console.log(`${basename(path)}：${progress}`); prior = progress; }
      }
      if (run.status !== 'SUCCESS') throw new Error(run.error || '网页运行未完成');
      const web = await request(`/debug/runs/${run.runId}/result`);
      // Freeze the deployed result before any optional standard answer is opened.
      await writeFile(join(dir, 'web-result.json'), JSON.stringify(web, null, 2));
      const record: QualityRecognitionRecord = web.qualityRecords?.[0];
      if (web.runKind !== 'PRODUCTION_WEB_FRESH' || web.qualityRecords?.length !== 1
        || record.evidence.run?.sourceSHA256 !== sourceSHA256 || record.evidence.run?.runKind !== 'FRESH')
        throw new Error('原始文件或全新运行记录不一致');
      const actual = { ...record, transactions: web.transactions, accounts: web.accounts };
      const frozen = freezeQualityRecognitionRecord(actual);
      await writeFile(join(dir, 'recognition-record.json'), JSON.stringify(actual, null, 2));
      await writeFile(join(dir, 'result.json'), JSON.stringify(frozen, null, 2));
      await writeFile(join(dir, 'registry.json'), JSON.stringify(record.evidence.registry, null, 2));
      await writeFile(join(dir, 'prediction-freeze.json'), JSON.stringify({ protocol: 'REGRESSION',
        sourceSHA256, runKind: 'PRODUCTION_WEB_FRESH', standardAnswersRead: false,
        predictionSHA256: createHash('sha256').update(JSON.stringify(frozen, null, 2)).digest('hex') }, null, 2));
      console.log(`${basename(path)}：已冻结 ${frozen.rows.length} 笔正式网页结果和完整提示`);
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(join(dir, 'error.json'), JSON.stringify({ error: message }, null, 2));
      console.error(`${basename(path)}：${message}`);
    }
  }
  if (failures) throw new Error(`${failures} 份文件未完成；不能宣称通过验收`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
