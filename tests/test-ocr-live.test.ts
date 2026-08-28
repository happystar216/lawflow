import test from 'node:test';
import fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';

test('run OCR directly on Page 1 extracted image', async () => {
  const data = new Uint8Array(fs.readFileSync('/Users/happy/Documents/law-tools/胡艳红银行流水.pdf'));
  const doc = await pdfjsLib.getDocument({ data }).promise;

  const page = await doc.getPage(1);
  const ops = await page.getOperatorList();
  
  const imgObj = await new Promise((resolve) => {
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject || ops.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject) {
        const imgName = ops.argsArray[i][0];
        console.log('Fetching image from objs:', imgName);
        page.objs.get(imgName, (image: any) => {
          if (image) {
            resolve(image);
          }
        });
        return;
      }
    }
    resolve(null);
  });

  if (!imgObj) {
    console.log('No image obj resolved');
    return;
  }

  const img: any = imgObj;
  console.log('Got image object:', img.width, 'x', img.height, 'kind:', img.kind, 'data bytes:', img.data.length);

  const totalPixels = img.width * img.height;
  let rgbData: Buffer;

  if (img.data.length === totalPixels * 3) {
    rgbData = Buffer.from(img.data);
  } else if (img.data.length === totalPixels * 4) {
    rgbData = Buffer.alloc(totalPixels * 3);
    for (let i = 0; i < totalPixels; i++) {
      rgbData[i * 3] = img.data[i * 4];
      rgbData[i * 3 + 1] = img.data[i * 4 + 1];
      rgbData[i * 3 + 2] = img.data[i * 4 + 2];
    }
  } else {
    // 1-channel grayscale
    rgbData = Buffer.alloc(totalPixels * 3);
    for (let i = 0; i < totalPixels; i++) {
      const g = img.data[i];
      rgbData[i * 3] = g;
      rgbData[i * 3 + 1] = g;
      rgbData[i * 3 + 2] = g;
    }
  }

  const ppmHeader = `P6\n${img.width} ${img.height}\n255\n`;
  const ppmBuffer = Buffer.concat([Buffer.from(ppmHeader), rgbData]);
  const tmpPpmPath = '/Users/happy/Documents/law-tools/tests/page1.ppm';
  fs.writeFileSync(tmpPpmPath, ppmBuffer);
  console.log('Saved page1.ppm:', fs.statSync(tmpPpmPath).size, 'bytes');

  // Run Tesseract OCR on the image
  console.log('Running Tesseract OCR on page1.ppm...');
  const worker = await createWorker('chi_sim+eng');
  const ret = await worker.recognize(tmpPpmPath);
  console.log('OCR Result text length:', ret.data.text.length);
  console.log('--- OCR Result Text Preview ---');
  console.log(ret.data.text.slice(0, 800));
  console.log('--- End Preview ---');
  await worker.terminate();
});
