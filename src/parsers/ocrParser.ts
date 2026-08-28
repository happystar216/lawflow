import { BankAccount, StandardTransaction } from '../types/transaction';
import { PaddleOcrEngine } from './paddleOcrEngine';

export interface OcrProgressCallback {
  (status: string, progress: number): void;
}

/**
 * Parses scanned bank statement images (.png, .jpg, .jpeg, .webp, .bmp)
 * or rendered canvas from image-based PDFs using PaddleOCR (PP-OCRv4) engine.
 */
export async function parseImageBankStatementWithOcr(
  fileOrCanvas: File | HTMLCanvasElement,
  onProgress?: OcrProgressCallback
): Promise<{
  account: BankAccount;
  transactions: StandardTransaction[];
}> {
  let fileName = '扫描件流水.png';
  let targetCanvas: HTMLCanvasElement;

  if (fileOrCanvas instanceof File) {
    fileName = fileOrCanvas.name;
    targetCanvas = await fileToCanvas(fileOrCanvas);
  } else {
    targetCanvas = fileOrCanvas;
  }

  const paddleEngine = PaddleOcrEngine.getInstance();
  return paddleEngine.recognizeStatementCanvas(targetCanvas, fileName, onProgress);
}

function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0);
          resolve(canvas);
        } else {
          reject(new Error('Failed to create canvas 2d context'));
        }
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
