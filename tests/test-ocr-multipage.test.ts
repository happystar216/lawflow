import test from 'node:test';
import fs from 'fs';
import path from 'path';
import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';

test('test OCR across pages 1 to 5 of statement', async () => {
  const data = new Uint8Array(fs.readFileSync('/Users/happy/Documents/law-tools/胡艳红银行流水.pdf'));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  console.log('PDF pages:', doc.numPages);

  const langPath = path.resolve(process.cwd(), 'public/tessdata');
  const worker = await createWorker('chi_sim', 1, { langPath, gzip: false });

  for (let p = 1; p <= Math.min(doc.numPages, 4); p++) {
    const page = await doc.getPage(p);
    const ops = await page.getOperatorList();
    
    const imgObj: any = await new Promise((resolve) => {
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject || ops.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject) {
          const imgName = ops.argsArray[i][0];
          page.objs.get(imgName, (image: any) => {
            if (image) resolve(image);
          });
          return;
        }
      }
      resolve(null);
    });

    if (imgObj) {
      const totalPixels = imgObj.width * imgObj.height;
      let rgbData = Buffer.from(imgObj.data);
      if (imgObj.data.length === totalPixels * 4) {
        rgbData = Buffer.alloc(totalPixels * 3);
        for (let i = 0; i < totalPixels; i++) {
          rgbData[i * 3] = imgObj.data[i * 4];
          rgbData[i * 3 + 1] = imgObj.data[i * 4 + 1];
          rgbData[i * 3 + 2] = imgObj.data[i * 4 + 2];
        }
      }
      const ppmHeader = `P6\n${imgObj.width} ${imgObj.height}\n255\n`;
      const ppmBuffer = Buffer.concat([Buffer.from(ppmHeader), rgbData]);
      const tmpPath = `/Users/happy/Documents/law-tools/tests/page_${p}.ppm`;
      fs.writeFileSync(tmpPath, ppmBuffer);

      const ret = await worker.recognize(tmpPath);
      console.log(`\n=== PAGE ${p} OCR RESULT (${ret.data.text.length} chars) ===`);
      console.log(ret.data.text.slice(0, 300));
    }
  }

  await worker.terminate();
});
