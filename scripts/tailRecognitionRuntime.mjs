import { spawn } from 'node:child_process';
const seconds = Number(process.env.TAIL_SECONDS);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('Invalid tail duration');
const child = spawn('node_modules/.bin/wrangler', ['pages', 'deployment', 'tail', '--project-name', 'lawflow', '--environment', 'production', '--format', 'json'], {
  stdio: ['ignore', 'pipe', 'pipe'], env: process.env
});
// Tail records contain request headers. Filter in memory; never store raw logs.
let record = '', depth = 0, quoted = false, escaped = false;
const outcomes = new Set(['ok', 'exception', 'exceededCpu', 'exceededMemory', 'canceled', 'unknown',
  'exceededResources', 'internalError', 'responseStreamDisconnected']);
const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
function consume(chunk) {
  for (const ch of chunk.toString()) {
    if (!depth) { if (ch !== '{') continue; record = ''; depth = 1; quoted = false; record += ch; continue; }
    record += ch;
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (!depth) {
      try {
        const r = JSON.parse(record);
        if (r.outcome) console.log(JSON.stringify({ outcome: outcomes.has(r.outcome) ? r.outcome : 'other',
          cpuTime: finiteNumber(r.cpuTime), wallTime: finiteNumber(r.wallTime),
          eventTimestamp: finiteNumber(r.eventTimestamp), status: finiteNumber(r.event?.response?.status) }));
      } catch { console.log('A runtime diagnostic record could not be decoded'); }
    }
  }
}
child.stdout.on('data', consume);
// Print only a known error category; provider diagnostics may contain headers.
child.stderr.on('data', data => {
  if (/Authentication error|not authorized|permission denied/i.test(data.toString())) console.log('Runtime log access is unavailable with the deployment token');
});
console.log('Sanitized runtime log reader started');
const timer = setTimeout(() => child.kill('SIGTERM'), seconds * 1000);
child.on('exit', (code, signal) => { clearTimeout(timer); console.log(JSON.stringify({ readerExitCode: code, readerExitSignal: signal })); });
