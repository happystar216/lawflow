import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { freezeQualityRecognitionRecord, type QualityRecognitionRecord } from '../src/recognition/qualityRunRecord';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('用法：tsx scripts/freezeWebRecognition.ts 下载的识别记录.json 新输出目录');
const record: QualityRecognitionRecord = JSON.parse(await readFile(input, 'utf8'));
const frozen = JSON.stringify(freezeQualityRecognitionRecord(record), null, 2);
await mkdir(output, { recursive: false });
await writeFile(join(output, 'result.json'), frozen);
await writeFile(join(output, 'registry.json'), JSON.stringify(record.evidence.registry, null, 2));
await writeFile(join(output, 'prediction-freeze.json'), JSON.stringify({ sourceRecord: resolve(input),
  predictionSHA256: createHash('sha256').update(frozen).digest('hex'), protocol: 'REGRESSION',
  runKind: record.evidence.run?.runKind || 'LEGACY_UNKNOWN', standardAnswersRead: false,
  verifiedWebRows: record.transactions.length }, null, 2));
console.log(`已核对并冻结网页实际 ${record.transactions.length} 笔 × 12 列，以及原始待确认提示。`);
