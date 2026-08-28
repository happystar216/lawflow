import test from 'node:test';
import path from 'path';
import { createWorker } from 'tesseract.js';

test('test single language chi_sim', async () => {
  const langPath = path.resolve(process.cwd(), 'public/tessdata');
  const worker = await createWorker('chi_sim', 1, {
    langPath,
    gzip: false
  });

  const ret = await worker.recognize('/Users/happy/Documents/law-tools/tests/page1.ppm');
  console.log('--- RECOGNIZED TEXT WITH CHI_SIM ---');
  console.log(ret.data.text);
  console.log('--- END TEXT ---');
  await worker.terminate();
});
