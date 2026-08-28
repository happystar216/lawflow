import test from 'node:test';
import path from 'path';
import { createWorker } from 'tesseract.js';

test('test local tessdata with page 1 of hu yanhong statement', async () => {
  const langPath = path.resolve(process.cwd(), 'public/tessdata');
  console.log('Using local langPath:', langPath);

  const worker = await createWorker(['chi_sim', 'eng'], 1, {
    langPath,
    gzip: true
  });

  console.log('Worker loaded successfully with local chi_sim and eng!');
  const ret = await worker.recognize('/Users/happy/Documents/law-tools/tests/page1.ppm');
  console.log('--- RECOGNIZED OCR TEXT FROM PAGE 1 ---');
  console.log(ret.data.text);
  console.log('--- END RECOGNIZED OCR TEXT ---');
  await worker.terminate();
});
