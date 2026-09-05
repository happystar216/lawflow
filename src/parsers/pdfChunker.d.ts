export interface PdfChunk {
  id: string;
  file: File;
  pageStart: number;
  pageEnd: number;
  totalPages: number;
}

export function splitPdfIntoChunks(file: File, pagesPerChunk?: number): Promise<PdfChunk[]>;
export function splitChunkIntoSinglePages(chunk: PdfChunk): Promise<PdfChunk[]>;
export function rotatePdfChunk(chunk: PdfChunk, clockwiseDegrees: number): Promise<PdfChunk>;
