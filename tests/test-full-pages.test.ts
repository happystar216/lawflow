import test from 'node:test';
import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist';

test('inspect full pages structure of hu yanhong pdf', async () => {
  const data = new Uint8Array(fs.readFileSync('/Users/happy/Documents/law-tools/胡艳红银行流水.pdf'));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  console.log('PDF Total Pages:', doc.numPages);

  // Check pages 1, 10, 20, 50, 100, 128
  const checkPages = [1, 5, 10, 20, 50, 80, 100, 128];
  for (const p of checkPages) {
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    console.log(`Page ${p}: fnArray length = ${ops.fnArray.length}`);
  }
});
