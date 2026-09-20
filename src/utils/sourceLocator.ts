import { SourceRegion, StandardTransaction } from '../types/transaction';

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/**
 * Models return a compact [top, left, bottom, right] box on a 0..1000 grid.
 * Invalid or implausibly small boxes are discarded rather than shown as evidence.
 */
export function sourceRegionFromBox(value: unknown): SourceRegion | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const [top, left, bottom, right] = value.map(Number);
  if (![top, left, bottom, right].every(Number.isFinite)) return undefined;
  const divisor = Math.max(top, left, bottom, right) > 1 ? 1000 : 1;
  const x = clamp(left / divisor);
  const y = clamp(top / divisor);
  const width = clamp(right / divisor) - x;
  const height = clamp(bottom / divisor) - y;
  if (width < 0.03 || height < 0.005) return undefined;
  return {
    x,
    y,
    width: clamp(width, 0.03, 1 - x),
    height: clamp(height, 0.008, 1 - y),
    origin: 'MODEL',
    confidence: 0.8
  };
}

/**
 * Legacy rows have no geometry. This produces a deliberately coarse full-width
 * band from the physical row order so the UI can scroll near the row without
 * presenting the estimate as an exact evidence coordinate.
 */
export function estimatedSourceRegion(
  transaction: StandardTransaction | undefined,
  pageTransactions: StandardTransaction[]
): SourceRegion | undefined {
  if (!transaction || transaction.sourceRegion) return transaction?.sourceRegion;
  const samePage = pageTransactions
    .filter(item => item.rawPageNumber === transaction.rawPageNumber)
    .sort((left, right) => (left.rawRowIndex || 0) - (right.rawRowIndex || 0));
  if (!samePage.length) return undefined;
  const index = samePage.findIndex(item => item.id === transaction.id);
  const effectiveIndex = index >= 0 ? index : Math.max(0, (transaction.rawRowIndex || 1) - 1);
  const header = 0.16;
  const footer = 0.07;
  const usable = 1 - header - footer;
  const rowHeight = usable / Math.max(samePage.length, effectiveIndex + 1);
  return {
    x: 0.025,
    y: clamp(header + effectiveIndex * rowHeight, 0, 0.96),
    width: 0.95,
    height: clamp(rowHeight, 0.018, 0.09),
    origin: 'ESTIMATED',
    confidence: 0.25
  };
}

export function rotateSourceRegion(region: SourceRegion, rotation: number): SourceRegion {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized === 90) return { ...region, x: 1 - region.y - region.height, y: region.x, width: region.height, height: region.width };
  if (normalized === 180) return { ...region, x: 1 - region.x - region.width, y: 1 - region.y - region.height };
  if (normalized === 270) return { ...region, x: region.y, y: 1 - region.x - region.width, width: region.height, height: region.width };
  return region;
}
