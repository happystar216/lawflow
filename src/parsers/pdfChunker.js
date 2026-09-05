import { PDFDocument, degrees } from 'pdf-lib/dist/pdf-lib.esm.min.js';

export async function splitPdfIntoChunks(file, pagesPerChunk = 5) {
  if (pagesPerChunk < 1) throw new Error('PDF 分片页数必须大于 0');
  const source = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: false });
  const totalPages = source.getPageCount();
  if (!totalPages) throw new Error('PDF 中没有可读取的页面');

  const chunks = [];
  for (let pageStart = 1; pageStart <= totalPages; pageStart += pagesPerChunk) {
    const pageEnd = Math.min(totalPages, pageStart + pagesPerChunk - 1);
    chunks.push(await createChunk(source, file.name, pageStart, pageEnd, totalPages));
  }
  return chunks;
}

export async function splitChunkIntoSinglePages(chunk) {
  if (chunk.pageStart === chunk.pageEnd) return [chunk];
  const source = await PDFDocument.load(await chunk.file.arrayBuffer(), { ignoreEncryption: false });
  const pages = [];
  for (let localPage = 1; localPage <= source.getPageCount(); localPage += 1) {
    const globalPage = chunk.pageStart + localPage - 1;
    pages.push(await createChunk(source, chunk.file.name, localPage, localPage, chunk.totalPages, globalPage));
  }
  return pages;
}

export async function rotatePdfChunk(chunk, clockwiseDegrees) {
  const normalized = ((clockwiseDegrees % 360) + 360) % 360;
  const source = await PDFDocument.load(await chunk.file.arrayBuffer(), { ignoreEncryption: false });
  const output = await PDFDocument.create();
  const copied = await output.copyPages(source, Array.from({ length: source.getPageCount() }, (_, index) => index));
  copied.forEach(page => {
    const current = page.getRotation().angle || 0;
    page.setRotation(degrees((current + normalized) % 360));
    output.addPage(page);
  });
  const bytes = await output.save({ useObjectStreams: true });
  return {
    ...chunk,
    id: `${chunk.id}-R${normalized}`,
    file: new File([bytes], chunk.file.name.replace(/\.pdf$/i, `_rotated_${normalized}.pdf`), { type: 'application/pdf' })
  };
}

async function createChunk(source, originalName, sourcePageStart, sourcePageEnd, totalPages, globalPageStart = sourcePageStart) {
  const output = await PDFDocument.create();
  const indices = Array.from({ length: sourcePageEnd - sourcePageStart + 1 }, (_, index) => sourcePageStart - 1 + index);
  const copied = await output.copyPages(source, indices);
  copied.forEach(page => output.addPage(page));
  const bytes = await output.save({ useObjectStreams: true });
  const globalPageEnd = globalPageStart + copied.length - 1;
  const baseName = originalName.replace(/\.pdf$/i, '');
  return {
    id: `P${globalPageStart}-${globalPageEnd}`,
    file: new File([bytes], `${baseName}_pages_${globalPageStart}-${globalPageEnd}.pdf`, { type: 'application/pdf' }),
    pageStart: globalPageStart,
    pageEnd: globalPageEnd,
    totalPages
  };
}
