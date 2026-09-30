/** Bound live upstream calls across pages and reading roles, not just pages. */
export function createModelRequestQueue(limit: number, signal: AbortSignal) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid request concurrency');
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function scheduled<T>(work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const start = () => { signal.removeEventListener('abort', cancel); active++; resolve(); };
      const cancel = () => { const i = waiting.indexOf(start); if (i >= 0) waiting.splice(i, 1); reject(signal.reason); };
      if (active < limit) start();
      else { waiting.push(start); signal.addEventListener('abort', cancel, { once: true }); }
    });
    try { signal.throwIfAborted(); return await work(); }
    finally { active--; waiting.shift()?.(); }
  };
}
