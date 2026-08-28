import test from 'node:test';
import path from 'path';
import { createWorker } from 'tesseract.js';

test('test uncompressed local tessdata on page 1', async () => {
  const langPath = path.resolve(process.cwd(), 'public/tessdata');
  const worker = await createWorker('chi_sim+eng', 1, {
    langPath,
    gzip: false
  });

  const ret = await worker.recognize('/Users/happy/Documents/law-tools/tests/page1.ppm');
  console.log('--- RECOGNIZED TEXT ---');
  console.log(ret.data.text);
  console.log('--- END TEXT ---');
  await worker.terminate();
});
