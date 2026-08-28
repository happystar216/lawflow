import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { parsePdfBankStatement } from '../src/parsers/pdfParser';

test('end-to-end parsePdfBankStatement on real PDF file', async () => {
  const filePath = '/Users/happy/Documents/law-tools/胡艳红银行流水.pdf';
  const buffer = fs.readFileSync(filePath);
  const file = new File([buffer], '胡艳红银行流水.pdf', { type: 'application/pdf' });

  let progressReported = false;
  const result = await parsePdfBankStatement(file, (status, prog) => {
    progressReported = true;
    console.log(`[PDF Progress] ${status} (${Math.round(prog * 100)}%)`);
  });

  console.log('Result Account:', result.account.bankName, result.account.accountNumber, result.account.accountName);
  console.log('Result Transactions count:', result.transactions.length);
  console.log('Sample transaction:', result.transactions[0]);

  assert.ok(result.transactions.length > 0, 'Should extract transactions from PDF');
  assert.equal(result.account.fileName, '胡艳红银行流水.pdf');
  assert.ok(result.account.totalOut > 0, 'Total out should be positive');
  assert.ok(progressReported, 'Should report progress');
});
