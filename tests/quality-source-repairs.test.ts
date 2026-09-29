import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQualitySources } from '../src/recognition/qualitySources';
import { materializeTableMapping, type MappedTable } from '../src/recognition/tableMapping';
import { recoverDescriptionColumn, combinedPartySuffixColumn } from '../src/recognition/columnRecovery';
import { printedTransactionType } from '../src/recognition/printedTransactionType';
import { planPrimaryRecovery } from '../src/recognition/primaryRecoveryPlan';

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

test('printed deposit transfers are stable without model type dictionaries and repayment purpose still takes precedence', () => {
  for (const text of ['转账', '跨行汇款', '他行汇入', '网银转账', '超网汇兑往账'])
    assert.equal(printedTransactionType(text, [text], 'OUT', 'deposit')?.type, '账户转账');
  assert.equal(printedTransactionType('转账', ['信用卡还款'], 'OUT', 'deposit')?.type, '信用卡还款');
  assert.equal(printedTransactionType('转账', ['贷款还款'], 'OUT', 'deposit')?.type, '贷款还款');
  assert.equal(printedTransactionType('转账', ['转账'], 'IN', 'credit'), null);
  for (const text of ['代扣业务', '外围批量入帐(批前运行)', '存款', '通过转账存取交易'])
    assert.equal(printedTransactionType(text, [text], 'OUT', 'deposit'), null);
});
