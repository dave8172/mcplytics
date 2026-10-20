// Turns events into the report: calls per day, top tools, top apps, how
// calls ended, and response times. Works on the same rows whether they came
// from a JSONL file or from Analytics Engine.

// Analytics Engine keeps a sample at high volume; each row then stands for
// `weight` calls. A file has every call, weight 1.
const w = r => (Number(r.weight) > 0 ? Number(r.weight) : 1);

const FAILED = new Set(['tool_error', 'protocol_error', 'http_error', 'no_response', 'crash']);

/** Weighted percentile of `ms`; q in 0..1. */
export function percentile(rows, q) {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.ms - b.ms);
  const total = sorted.reduce((s, r) => s + w(r), 0);
  let seen = 0;
  for (const r of sorted) {
    seen += w(r);
    if (seen >= q * total) return r.ms;
  }
  return sorted[sorted.length - 1].ms;
}

function group(rows, keyOf) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

function line(label, rows) {
  const calls = rows.reduce((s, r) => s + w(r), 0);
  const failed = rows.filter(r => FAILED.has(r.outcome)).reduce((s, r) => s + w(r), 0);
  return { label, calls, failed, failRate: calls ? failed / calls : 0, p50: percentile(rows, 0.5), p95: percentile(rows, 0.95) };
}

const byCalls = (a, b) => b.calls - a.calls || String(a.label).localeCompare(String(b.label));

/**
 * rows: events (FIELDS in index.js), optionally with `weight`.
 * A call that asked the client for more input (input_required) is retried as
 * a new call, so it is counted on its own line, not as a call.
 */
export function summarize(rows, { top = 10 } = {}) {
  const asked = rows.filter(r => r.outcome === 'input_required');
  const calls = rows.filter(r => r.outcome !== 'input_required');
  const times = calls.map(r => r.time).filter(Boolean).sort();
  const tools = calls.filter(r => r.method === 'tools/call');
  const outcomes = {};
  for (const r of rows) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + w(r);
  return {
    from: times[0] || null,
    to: times[times.length - 1] || null,
    total: line('all calls', calls),
    inputRequired: asked.reduce((s, r) => s + w(r), 0),
    days: [...group(calls, r => (r.time || '').slice(0, 10))].map(([day, rs]) => ({ day, calls: rs.reduce((s, r) => s + w(r), 0) })).sort((a, b) => a.day.localeCompare(b.day)),
    tools: [...group(tools, r => r.name || '(no name)')].map(([k, rs]) => line(k, rs)).sort(byCalls).slice(0, top),
    methods: [...group(calls, r => r.method || '(none)')].map(([k, rs]) => line(k, rs)).sort(byCalls).slice(0, top),
    clients: [...group(calls, r => r.client || '(unnamed)')].map(([k, rs]) => ({ ...line(k, rs), source: rs[0].clientSource || '' })).sort(byCalls).slice(0, top),
    callers: [...group(calls.filter(r => r.caller), r => r.caller)].map(([k, rs]) => line(k, rs)).sort(byCalls).slice(0, top),
    outcomes,
  };
}

const pct = x => (x * 100).toFixed(x && x < 0.1 ? 1 : 0) + '%';
const ms = x => (x === null ? '-' : `${Math.round(x)} ms`);
const num = x => (Number.isInteger(x) ? String(x) : x.toFixed(1));

function table(title, lines) {
  if (!lines.length) return '';
  const width = Math.min(40, Math.max(...lines.map(l => String(l.label).length), 4));
  const head = `${'name'.padEnd(width)}  ${'calls'.padStart(7)}  ${'failed'.padStart(6)}  ${'p50'.padStart(8)}  ${'p95'.padStart(8)}`;
  const body = lines.map(l =>
    `${String(l.label).slice(0, width).padEnd(width)}  ${num(l.calls).padStart(7)}  ${pct(l.failRate).padStart(6)}  ${ms(l.p50).padStart(8)}  ${ms(l.p95).padStart(8)}`);
  return [`\n${title}`, head, ...body].join('\n');
}

/** The report as plain text for a terminal. */
export function format(s) {
  if (!s.total.calls && !s.inputRequired) return 'No MCP calls recorded yet.';
  const out = [
    `mcplytics: ${num(s.total.calls)} calls, ${s.from?.slice(0, 16).replace('T', ' ')} to ${s.to?.slice(0, 16).replace('T', ' ')} UTC`,
    `failed ${pct(s.total.failRate)} · p50 ${ms(s.total.p50)} · p95 ${ms(s.total.p95)}` + (s.inputRequired ? ` · ${num(s.inputRequired)} asked the client for more input` : ''),
    table('Tools', s.tools),
    table('Apps calling (client name)', s.clients),
    s.callers.length ? table('Your labels (caller)', s.callers) : '',
    table('Methods', s.methods),
    '\nHow calls ended',
    ...Object.entries(s.outcomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.padEnd(16)} ${num(v)}`),
    '\nCalls per day',
    ...s.days.map(d => `${d.day}  ${num(d.calls)}`),
  ];
  return out.filter(Boolean).join('\n');
}
