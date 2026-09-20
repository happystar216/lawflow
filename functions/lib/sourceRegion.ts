export interface ExtractedSourceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  origin: 'MODEL';
  confidence: number;
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** Convert a compact [top,left,bottom,right] 0..1000 model box to normalized page coordinates. */
export function normalizeSourceBox(value: unknown): ExtractedSourceRegion | undefined {
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
