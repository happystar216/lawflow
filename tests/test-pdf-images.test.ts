import test from 'node:test';
import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist';

test('inspect images in pdf', async () => {
  const data = new Uint8Array(fs.readFileSync('/Users/happy/Documents/law-tools/胡艳红银行流水.pdf'));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  console.log('Total pages:', doc.numPages);

  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  console.log('Operator list total fnArray length:', ops.fnArray.length);

  // Check image objects
  const imageNames: string[] = [];
  ops.fnArray.forEach((fn: number, idx: number) => {
    if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) {
      const imgName = ops.argsArray[idx][0];
      imageNames.push(imgName);
    }
  });

  console.log('Image objects on Page 1:', imageNames);
});
