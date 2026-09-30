// Read ephemeral runtime events; emit only enumerated outcomes and numeric metrics.
// Request headers, provider messages, exception text and session URLs never leave memory.
const outcomes = new Set(['ok', 'exception', 'exceededCpu', 'exceededMemory', 'canceled', 'unknown',
  'exceededResources', 'internalError', 'responseStreamDisconnected']);
const finiteNumber = v => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
async function main() {
  const seconds = Number(process.env.TAIL_SECONDS), account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600 || !account || !token) throw new Error();
  const root = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/lawflow`;
  async function api(path, method = 'GET') {
    const response = await fetch(root + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ filters: [] }) } : {}), signal: AbortSignal.timeout(30000) });
    const value = await response.json();
    console.log(JSON.stringify({ apiStatus: response.status, errorCodes: value.errors?.map(e => finiteNumber(e.code)).filter(v => v !== undefined) }));
    if (!response.ok || !value.success) throw new Error();
    return value.result;
  }
  const project = await api('');
  const path = `/deployments/${project.canonical_deployment.id}/tails`;
  const session = await api(path, 'POST');
  try {
    if (new URL(session.url).protocol !== 'wss:') throw new Error();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(session.url, 'trace-v1');
      const timer = setTimeout(() => { ws.close(); resolve(); }, seconds * 1000);
      ws.addEventListener('open', () => { ws.send(JSON.stringify({ debug: false })); console.log('Sanitized runtime reader connected'); });
      ws.addEventListener('message', async event => {
        try {
          const text = typeof event.data === 'string' ? event.data : await event.data.text();
          if (text.length > 2000000) return;
          const r = JSON.parse(text);
          if (r.outcome) console.log(JSON.stringify({ outcome: outcomes.has(r.outcome) ? r.outcome : 'other',
            cpuTime: finiteNumber(r.cpuTime), wallTime: finiteNumber(r.wallTime), eventTimestamp: finiteNumber(r.eventTimestamp),
            status: finiteNumber(r.event?.response?.status) }));
        } catch { console.log('Runtime event decoding failed'); }
      });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error()); });
      ws.addEventListener('close', () => { clearTimeout(timer); resolve(); });
    });
  } finally { await api(`${path}/${session.id}`, 'DELETE'); }
}
main().catch(() => { console.log('Runtime reader unavailable; no raw diagnostic data was exported'); process.exitCode = 1; });
