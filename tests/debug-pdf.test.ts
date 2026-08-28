import test from 'node:test';
import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist';

test('inspect hu yanhong pdf', async () => {
  const filePath = '/Users/happy/Documents/law-tools/胡艳红银行流水.pdf';
  if (!fs.existsSync(filePath)) {
    console.log('File does not exist');
    return;
  }

  const data = new Uint8Array(fs.readFileSync(filePath));
  console.log('PDF File byte length:', data.length);

  const doc = await pdfjsLib.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true
  }).promise;

  console.log('Total pages:', doc.numPages);

  for (let i = 1; i <= Math.min(doc.numPages, 5); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    console.log(`Page ${i}: items = ${content.items.length}`);
    const text = content.items.map((it: any) => it.str).join(' ');
    console.log(`Page ${i} text preview: "${text.slice(0, 100)}"`);
  }
});
