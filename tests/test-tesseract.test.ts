import test from 'node:test';
import { createWorker } from 'tesseract.js';

test('test tesseract initialization', async () => {
  console.log('Starting tesseract createWorker...');
  try {
    const worker = await createWorker('eng');
    console.log('Worker created successfully with eng!');
    await worker.terminate();
  } catch (err) {
    console.error('Tesseract createWorker error:', err);
  }
});
