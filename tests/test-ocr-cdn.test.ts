import test from 'node:test';
import fs from 'fs';
import { createWorker } from 'tesseract.js';

test('test tesseract with jsdelivr fast CDN', async () => {
  const worker = await createWorker(['chi_sim', 'eng'], 1, {
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/'
  });

  const ret = await worker.recognize('/Users/happy/Documents/law-tools/tests/page1.ppm');
  console.log('--- OCR EXTRACTED TEXT ---');
  console.log(ret.data.text);
  console.log('--- END OCR EXTRACTED TEXT ---');
  await worker.terminate();
});
