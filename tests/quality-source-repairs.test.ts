import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQualitySources } from '../src/recognition/qualitySources';
import { materializeTableMapping, type MappedTable } from '../src/recognition/tableMapping';
import { recoverDescriptionColumn, combinedPartySuffixColumn } from '../src/recognition/columnRecovery';
import { printedTransactionType } from '../src/recognition/printedTransactionType';
import { planPrimaryRecovery } from '../src/recognition/primaryRecoveryPlan';
import { runQualityTrial } from '../src/recognition/qualityTrialPipeline';

test('missing tables remain explicit required source issues and trigger recovery instead of aborting the whole PDF', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [['真实交易']] }] }]);
  const result = materializeTableMapping({ tables: [], typeRules: [] }, registry);
  assert.equal(result.complete, false);
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.issues.map(i => [i.code, i.severity, i.sourceRows]), [['UNASSIGNED_SOURCE_ROW', 'REQUIRED', [1]]]);
  assert.equal(planPrimaryRecovery(result.issues, registry).selected[0].page, 1);
});

test('empty nontransaction placeholders are harmless but invented transaction tables still fail', () => {
  const { registry } = buildQualitySources([{ nearTableText: ['公文标题'], tables: [] }]);
  const table: MappedTable = { page: 1, table: 1, kind: 'other', accountKind: 'unknown', groups: [], ignored: [], fields: {}, directionCodes: null };
  assert.equal(materializeTableMapping({ tables: [table], typeRules: [] }, registry).complete, true);
  for (const bad of [{ ...table, groups: [[1]] }, { ...table, kind: 'transactions' }, { ...table, page: 2 }])
    assert.throws(() => materializeTableMapping({ tables: [bad], typeRules: [] }, registry), /不存在的表格/);
});

test('a unique literal header corrects a wrong description column only in a uniform layout', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [
    ['交易日期', '交易描述', '商户名称'], ['2026-01-02', '手续费', '测试商户']
  ] }] }]);
  const table: MappedTable = { page: 1, table: 1, kind: 'transactions', accountKind: 'deposit',
    groups: [[2]], ignored: [{ r: [1], kind: 'header' }], fields: { description: { row: 0, col: 3 } }, directionCodes: null };
  assert.deepEqual(recoverDescriptionColumn(table, registry)?.selector, { row: 0, col: 2 });
  table.fields.description = { row: 0, col: 2 };
  assert.equal(recoverDescriptionColumn(table, registry), null);
  table.fields.description = { row: 0, col: 3 };
  registry.rows[2].cells.push(registry.rows[2].cells[2]);
  assert.equal(recoverDescriptionColumn(table, registry), null, 'ragged OCR needs a new mapping, not a guessed column');
});

test('combined suffix evidence survives an incorrect part selector and cannot produce a full account', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [
    ['对方信息', '摘要'], ['测试甲1234', '转账'], ['测试乙2345', '转账'], ['测试丙3456', '转账']
  ] }] }]);
  const table: MappedTable = { page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', groups: [[2], [3], [4]],
    ignored: [{ r: [1], kind: 'header' }], directionCodes: null,
    fields: { counterpartyName: { row: 0, col: 1, part: 'name' }, counterpartyAccount: { row: 0, col: 1, part: 'account' }, description: { row: 0, col: 2 } } };
  assert.equal(combinedPartySuffixColumn(table, registry), 1);
  const materialized = materializeTableMapping({ tables: [table], typeRules: [] }, registry);
  assert.equal(materialized.rows[0].values[9], '测试甲1234');
  assert.equal(materialized.rows[0].values[10], '');
  registry.cells[registry.rows[4].cells[0]].text = '一个无法拆分的名称';
  assert.equal(combinedPartySuffixColumn(table, registry), null);
});

test('an empty purpose column cannot overwrite a mapped summary-code column with printed words', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [['摘要代号', '用途'], ['138 利息', '']] }] }]);
  const table: MappedTable = { page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', groups: [[2]],
    ignored: [{ r: [1], kind: 'header' }], fields: { description: { row: 0, col: 1 } }, directionCodes: null };
  assert.equal(recoverDescriptionColumn(table, registry), null);
  const out = materializeTableMapping({ tables: [table], typeRules: [{ accountKind: 'deposit', text: '138 利息', type: '存款结息' }] }, registry);
  assert.equal(out.rows[0].values[8], '存款结息');
  assert.ok(out.rows[0].fields[8].some(f => f.text === '138 利息'));
});

test('printed deposit transfers are stable without model type dictionaries and repayment purpose still takes precedence', () => {
  for (const text of ['转账', '跨行汇款', '他行汇入', '网银转账', '超网汇兑往账', '电子账户资金转出', '网银跨行汇款跨行转出'])
    assert.equal(printedTransactionType(text, [text], 'OUT', 'deposit')?.type, '账户转账');
  assert.equal(printedTransactionType('网银跨行汇款跨行转出', ['网银支付收到轧差通知'], 'IN', 'deposit')?.type, '账户转账');
  assert.equal(printedTransactionType('转账', ['信用卡还款'], 'OUT', 'deposit')?.type, '信用卡还款');
  assert.equal(printedTransactionType('转账', ['贷款还款'], 'OUT', 'deposit')?.type, '贷款还款');
  assert.equal(printedTransactionType('批处理归还欠款', ['个人贷款每日扣款'], 'OUT', 'deposit')?.type, '贷款还款');
  assert.equal(printedTransactionType('批量还款', ['批量还款'], 'OUT', 'deposit')?.requiresReview, true);
  assert.equal(printedTransactionType('转账', ['转账'], 'IN', 'credit'), null);
  for (const text of ['代扣业务', '外围批量入帐(批前运行)', '存款', '通过转账存取交易'])
    assert.equal(printedTransactionType(text, [text], 'OUT', 'deposit'), null);
});

test('batch repayment needs the exact owner and loan account pair from a printed loan disbursement', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [
    ['001234567890', '009876543210', '2026-01-01', '收入', '100', '100', '个人贷款'],
    ['001234567890', '009876543210', '2026-01-02', '支出', '10', '90', '批量还款'],
    ['001234567890', '009876543211', '2026-01-03', '支出', '10', '80', '批量还款']
  ] }] }]);
  const table: MappedTable = { page: 1, table: 1, kind: 'transactions', accountKind: 'deposit', groups: [[1], [2], [3]], ignored: [], directionCodes: null,
    fields: Object.fromEntries(['accountNumber', 'counterpartyAccount', 'transactionDate', 'direction', 'amount', 'balance', 'description'].map((field, i) => [field, { row: 0, col: i + 1 }])) };
  const out = runQualityTrial({ tables: [table], typeRules: [] }, registry, {}, { singleIssuerDocument: false });
  assert.equal(out.rows[1].values[8], '贷款还款');
  assert.equal(out.rows[2].values[8], '');
  assert.ok(out.transformations.some(t => t.basis === 'PRINTED_BATCH_REPAYMENT_TO_SAME_DOCUMENTED_LOAN_ACCOUNT'));
});

test('installment refund retains a printed merchant when both counterparty fields are absent', () => {
  const { registry } = buildQualitySources([{ nearTableText: [], tables: [{ rows: [
    ['001234567890', '2026-01-01', '支出', '10', '-90', '分期付款退货', '某清算单位']
  ] }] }]);
  const table: MappedTable = { page: 1, table: 1, kind: 'transactions', accountKind: 'credit', groups: [[1]], ignored: [], directionCodes: null,
    fields: Object.fromEntries(['accountNumber', 'transactionDate', 'direction', 'amount', 'balance', 'description', 'merchantName'].map((field, i) => [field, { row: 0, col: i + 1 }])) };
  const out = runQualityTrial({ tables: [table], typeRules: [] }, registry, {}, { singleIssuerDocument: false });
  assert.equal(out.rows[0].values[9], '某清算单位');
});

test('remark evidence supports ordinary transfers without guessing a missing purpose or overriding a loan', () => {
  assert.equal(printedTransactionType('', ['往来款'], 'OUT', 'deposit', '001234567890')?.type, '账户转账');
  assert.equal(printedTransactionType('', ['往来款'], 'OUT', 'deposit'), null);
  assert.equal(printedTransactionType('', ['贷款还款', '往来款'], 'OUT', 'deposit', '001234567890')?.type, '贷款还款');
  assert.equal(printedTransactionType('', [], 'OUT', 'deposit', '001234567890'), null);
});
