import JSZip from 'jszip';

export interface MinerUPageText {
  page: number;
  text: string;
}

export interface MinerUStructuredBlock {
  page: number;
  type: string;
  text: string;
  tableHtml?: string;
  bbox?: [number, number, number, number];
}

export interface MinerUStructuredDocument {
  pages: MinerUPageText[];
  blocks: MinerUStructuredBlock[];
}

export async function parseMinerUZip(buffer: ArrayBuffer): Promise<MinerUPageText[]> {
  return (await parseMinerUStructuredZip(buffer)).pages;
}

export async function parseMinerUStructuredZip(buffer: ArrayBuffer): Promise<MinerUStructuredDocument> {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter(entry => !entry.dir);
  const preferred = entries.find(entry => /(?:^|\/)structured_content\.json$/i.test(entry.name))
    || entries.find(entry => /(?:^|\/).*content_list\.json$/i.test(entry.name))
    || entries.find(entry => /(?:^|\/)(?:middle_json|.*_middle|layout)\.json$/i.test(entry.name))
    || entries.find(entry => /\.json$/i.test(entry.name));
  if (!preferred) throw new Error('MinerU 结果包中没有逐页结构化 JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await preferred.async('text'));
  } catch {
    throw new Error('MinerU 逐页 JSON 无法读取');
  }
  const pages = normalizeMinerUPages(parsed);
  if (!pages.length) throw new Error('MinerU 结果中没有可用的逐页文字');
  return { pages, blocks: normalizeMinerUBlocks(parsed) };
}

export function normalizeMinerUPages(value: unknown): MinerUPageText[] {
  const root = value as any;
  const directPages = Array.isArray(root?.pages) ? root.pages : Array.isArray(root?.pdf_info) ? root.pdf_info : null;
  const grouped = new Map<number, string[]>();
  if (directPages) {
    for (const [index, item] of directPages.entries()) {
      const pageIndex = integer(item?.page_idx) ?? integer(item?.page_index) ?? index;
      appendPageText(grouped, pageIndex, collectText(item?.blocks ?? item?.para_blocks ?? item));
    }
  } else if (Array.isArray(root)) {
    for (const item of root) {
      const pageIndex = integer(item?.page_idx) ?? integer(item?.page_index);
      if (pageIndex == null) continue;
      appendPageText(grouped, pageIndex, collectText(item));
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pageIndex, fragments]) => ({
      page: pageIndex + 1,
      text: uniqueFragments(fragments).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 12_000)
    }));
}

export function normalizeMinerUBlocks(value: unknown): MinerUStructuredBlock[] {
  const root = value as any;
  const blocks: MinerUStructuredBlock[] = [];
  const directPages = Array.isArray(root?.pages) ? root.pages : Array.isArray(root?.pdf_info) ? root.pdf_info : null;
  if (directPages) {
    for (const [index, page] of directPages.entries()) {
      const pageIndex = integer(page?.page_idx) ?? integer(page?.page_index) ?? index;
      const pageBlocks = Array.isArray(page?.blocks)
        ? page.blocks
        : Array.isArray(page?.para_blocks) ? page.para_blocks : [page];
      for (const block of pageBlocks) appendStructuredBlock(blocks, block, pageIndex);
    }
  } else if (Array.isArray(root)) {
    for (const item of root) {
      const pageIndex = integer(item?.page_idx) ?? integer(item?.page_index);
      if (pageIndex != null) appendStructuredBlock(blocks, item, pageIndex);
    }
  }
  return blocks.sort((left, right) => left.page - right.page);
}

function appendStructuredBlock(target: MinerUStructuredBlock[], value: any, pageIndex: number): void {
  if (pageIndex < 0 || value == null || typeof value !== 'object') return;
  const tableHtml = typeof value.table_body === 'string' ? value.table_body.trim() : '';
  const text = uniqueFragments(collectText(value)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text && !tableHtml) return;
  const bbox = normalizeBbox(value.bbox);
  target.push({
    page: pageIndex + 1,
    type: String(value.type || (tableHtml ? 'table' : 'text')),
    text,
    ...(tableHtml ? { tableHtml } : {}),
    ...(bbox ? { bbox } : {})
  });
}

function normalizeBbox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 4) return undefined;
  const bbox = value.slice(0, 4).map(Number);
  return bbox.every(Number.isFinite) ? bbox as [number, number, number, number] : undefined;
}

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 10 || value == null) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(item => collectText(item, depth + 1));
  if (typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  const priorityKeys = ['text', 'content', 'body', 'table_body', 'table_caption', 'title'];
  const fragments = priorityKeys.flatMap(key => key in object ? collectText(object[key], depth + 1) : []);
  if (fragments.length) return fragments;
  const structuralKeys = ['blocks', 'para_blocks', 'lines', 'spans', 'children', 'items'];
  return structuralKeys.flatMap(key => key in object ? collectText(object[key], depth + 1) : []);
}

function appendPageText(grouped: Map<number, string[]>, pageIndex: number, fragments: string[]): void {
  if (pageIndex < 0 || !fragments.length) return;
  grouped.set(pageIndex, [...(grouped.get(pageIndex) || []), ...fragments]);
}

function uniqueFragments(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function integer(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
