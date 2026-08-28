import test from 'node:test';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';

test('extract page 1 image from hu yanhong pdf', async () => {
  const data = new Uint8Array(fs.readFileSync('/Users/happy/Documents/law-tools/胡艳红银行流水.pdf'));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  console.log('PDF numPages:', doc.numPages);

  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  
  console.log('Looking for image objects on Page 1...');
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject || ops.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject) {
      const imgName = ops.argsArray[i][0];
      console.log('Found image:', imgName);
      
      // Try to get image from page objs
      page.objs.get(imgName, (image: any) => {
        if (image) {
          console.log('Image width:', image.width, 'height:', image.height, 'kind:', image.kind);
        }
      });
    }
  }
});
