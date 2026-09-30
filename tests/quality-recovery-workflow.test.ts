import test from 'node:test';
import assert from 'node:assert/strict';
import { runQualityWorkflow } from '../src/recognition/qualityWorkflow';
import { qualityPrompts } from '../functions/lib/qualityPrompts.generated';

test('an independently observed second statement triggers a full-page reread at source resolution', async () => {
  const first = ['2026-07-10', '支出', '10.00', '90.00', '转账', '测试甲', '009876543210'];
  const second = ['2026-07-11', '支出', '20.00', '70.00', '转账', '测试乙', '009876543211'];
  const table = (rows: string[][]) => ({ nearTableText: ['测试银行', '001234567890'], tables: [{ rows }] });
  const independent = { pageType: 'transactions', coverage: 'complete', pageIssues: [], bankName: '测试银行',
    rows: [first, second].map((r, i) => ({ row: i + 1,
      values: ['001234567890', r[0], '', 'OUT', r[2], r[3], r[5], r[6]], rawDirection: r[1], issues: [] })) };
  const map = (rows: number[]) => ({ tables: [{ page: 1, table: 1, kind: 'transactions', accountKind: 'deposit',
    groups: rows.map(r => [r]), ignored: [], directionCodes: null,
    fields: { bankName: { fixed: 1 }, accountNumber: { fixed: 2 }, transactionDate: { row: 0, col: 1 },
      direction: { row: 0, col: 2 }, amount: { row: 0, col: 3 }, balance: { row: 0, col: 4 },
      description: { row: 0, col: 5 }, counterpartyName: { row: 0, col: 6 }, counterpartyAccount: { row: 0, col: 7 } }
  }], typeRules: [{ accountKind: 'deposit', text: '转账', type: '账户转账' }] });
  const requested: Array<{ stage: string; dpi: number }> = [];
  let mapped = 0;
  const delivery = await runQualityWorkflow({ totalPages: 1, signal: new AbortController().signal, progress() {},
    preflightImages: async () => ({ images: Array(4).fill('YQ=='), metrics: { darkFraction160: .1, darkFraction210: .1, hasPdfText: false } }),
    image: async (_page, _rotation, dpi) => { requested.push({ stage: 'image', dpi }); return 'YQ=='; },
    call: async input => {
      const result = input.stage === 'preflight' ? { pageKind: 'content', uprightCandidate: 'A', reason: 'fixture' }
        : input.stage === 'primary' ? table([first])
        : input.stage === 'primaryRecovery' ? table([first, second])
        : input.stage === 'context' ? { nearTableText: [], tables: [] }
        : input.stage === 'independent' || input.stage === 'critical' ? independent
        : input.stage === 'mapping' ? map(++mapped === 1 ? [1] : [1, 2])
        : { bankName: '测试银行', identifiers: [], issues: [] };
      return { result, finishReason: 'STOP', model: 'fixture', promptSHA256: 'fixture' };
    }
  });
  assert.deepEqual(delivery.recoveryPlans.primary.selected.map(p => p.page), [1]);
  assert.deepEqual(delivery.primary[0].tables.map(t => t.rows.length), [2]);
  assert.equal(delivery.result.rows.length, 2);
  assert.deepEqual(requested.slice(0, 2).map(r => r.dpi), [350, 350]);
  assert.notEqual(qualityPrompts.primaryRecovery.sha256, qualityPrompts.primary.sha256);
});
