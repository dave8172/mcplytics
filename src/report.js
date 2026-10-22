// Turns events into the report: calls per day, top tools, top apps, how
// calls ended, and response times. Works on the same rows whether they came
// from a JSONL file or from Analytics Engine.

// Analytics Engine keeps a sample at high volume; each row then stands for
// `weight` calls. A file has every call, weight 1.
const w = r => (Number(r.weight) > 0 ? Number(r.weight) : 1);

const FAILED = new Set(['tool_error', 'protocol_error', 'http_error', 'no_response', 'crash']);

// -32601: the caller asked for a method this server doesn't have. Scanners do
// it to learn what a server speaks (server/discover on an older server, other
// protocols' methods). It says nothing about the server's health.
const notOffered = r => r.outcome === 'protocol_error' && Number(r.code) === -32601;

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
 * a new call, so it is counted on its own line, not as a call. A call for a
 * method the server doesn't have is counted apart too, by method.
 */
export function summarize(rows, { top = 10 } = {}) {
  const asked = rows.filter(r => r.outcome === 'input_required');
  const missing = rows.filter(notOffered);
  const calls = rows.filter(r => r.outcome !== 'input_required' && !notOffered(r));
  const times = calls.map(r => r.time).filter(Boolean).sort();
  const tools = calls.filter(r => r.method === 'tools/call');
  const outcomes = {};
  for (const r of rows) {
    const k = notOffered(r) ? 'not_offered' : r.outcome;
    outcomes[k] = (outcomes[k] || 0) + w(r);
  }
  return {
    from: times[0] || null,
    to: times[times.length - 1] || null,
    total: line('all calls', calls),
    inputRequired: asked.reduce((s, r) => s + w(r), 0),
    notOffered: [...group(missing, r => r.method || '(none)')].map(([method, rs]) => ({ method, calls: rs.reduce((s, r) => s + w(r), 0) })).sort((a, b) => b.calls - a.calls || a.method.localeCompare(b.method)).slice(0, top),
    days: [...group(calls, r => (r.time || '').slice(0, 10))].map(([day, rs]) => ({ day, calls: rs.reduce((s, r) => s + w(r), 0) })).sort((a, b) => a.day.localeCompare(b.day)),
    tools: [...group(tools, r => r.name || '(no name)')].map(([k, rs]) => line(k, rs)).sort(byCalls).slice(0, top),
    methods: [...group(calls, r => r.method || '(none)')].map(([k, rs]) => line(k, rs)).sort(byCalls).slice(0, top),
    clients: [...group(calls, r => r.client || '(unnamed)')].map(([k, rs]) => ({ ...line(k, rs), source: rs[0].clientSource || '' })).sort(byCalls).slice(0, top),
    callers: [...group(calls.filter(r => r.caller), r => r.caller)].map(([k, rs]) => line(k, rs)).sort(byCalls).slice(0, top),
    apps: [...group(calls.filter(r => r.app), r => r.app)].map(([k, rs]) => line(k, rs)).sort(byCalls).slice(0, top),
    outcomes,
    security: security(rows, top),
  };
}

/**
 * What the security signals say: each flag and the apps that raised it,
 * sign-ins refused by app, and every version of the tool list seen.
 */
function security(rows, top) {
  const sum = rs => rs.reduce((s, r) => s + w(r), 0);
  const flagged = rows.flatMap(r => String(r.flags || '').split(',').filter(Boolean).map(flag => ({ ...r, flag })));
  const flags = [...group(flagged, r => r.flag)].map(([flag, rs]) => ({
    flag, calls: sum(rs),
    apps: [...group(rs, r => r.app || r.client || '(unnamed)')].map(([k, g]) => [k, sum(g)]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k),
  })).sort((a, b) => b.calls - a.calls || a.flag.localeCompare(b.flag));
  const refused = [...group(rows.filter(r => Number(r.status) === 401 || Number(r.status) === 403), r => r.app || r.client || '(unnamed)')]
    .map(([label, rs]) => ({ label, calls: sum(rs) })).sort((a, b) => b.calls - a.calls).slice(0, top);
  const toolLists = [...group(rows.filter(r => r.toolsHash), r => r.toolsHash)].map(([hash, rs]) => {
    const times = rs.map(r => r.time).filter(Boolean).sort();
    return { hash, calls: sum(rs), first: times[0] || null, last: times[times.length - 1] || null };
  }).sort((a, b) => String(a.first).localeCompare(String(b.first)));
  return { flags, refused, toolLists };
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

const WHAT = {
  oversize: 'body over 256 KB, not read',
  unparseable: 'body was not JSON',
  foreign_origin: 'sent by a browser on another site',
  unknown_tool: 'called a tool your server never listed',
  insufficient_scope: 'refused: token lacked a permission',
  token_in_url: 'credential in the URL',
  hidden_text: 'tool list hides invisible characters',
  tools_changed: 'tool list changed',
};

function securityLines(sec) {
  if (!sec || (!sec.flags.length && !sec.refused.length && sec.toolLists.length < 2)) return [];
  const out = ['\nSecurity signals'];
  for (const f of sec.flags) out.push(`${f.flag.padEnd(19)} ${num(f.calls).padStart(6)}  ${WHAT[f.flag] || ''}${f.apps.length ? ` (from ${f.apps.join(', ')})` : ''}`);
  if (sec.refused.length) out.push(`sign-in refused     ${num(sec.refused.reduce((s, r) => s + r.calls, 0)).padStart(6)}  401/403, most from ${sec.refused.slice(0, 3).map(r => r.label).join(', ')}`);
  if (sec.toolLists.length > 1) {
    out.push(`\nTool list versions (${sec.toolLists.length}; a change you didn't deploy is worth a look)`);
    for (const t of sec.toolLists) out.push(`${t.hash}  ${String(t.first).slice(0, 16).replace('T', ' ')} to ${String(t.last).slice(0, 16).replace('T', ' ')}  ${num(t.calls)} lists`);
  }
  return out;
}

/** The report as plain text for a terminal. */
export function format(s) {
  if (!s.total.calls && !s.inputRequired && !s.notOffered.length) return 'No MCP calls recorded yet.';
  const out = [
    `mcplytics: ${num(s.total.calls)} calls, ${s.from?.slice(0, 16).replace('T', ' ')} to ${s.to?.slice(0, 16).replace('T', ' ')} UTC`,
    `failed ${pct(s.total.failRate)} · p50 ${ms(s.total.p50)} · p95 ${ms(s.total.p95)}` + (s.inputRequired ? ` · ${num(s.inputRequired)} asked the client for more input` : ''),
    table('Tools', s.tools),
    table('Apps calling (client name)', s.clients),
    s.apps.length ? table('Apps by verified OAuth client', s.apps) : '',
    s.callers.length ? table('Your labels (caller)', s.callers) : '',
    table('Methods', s.methods),
    s.notOffered.length ? '\nAsked for methods this server doesn\'t have (not counted as calls)' : '',
    ...s.notOffered.map(m => `${m.method.padEnd(24)} ${num(m.calls)}`),
    ...securityLines(s.security),
    '\nHow calls ended',
    ...Object.entries(s.outcomes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.padEnd(16)} ${num(v)}`),
    '\nCalls per day',
    ...s.days.map(d => `${d.day}  ${num(d.calls)}`),
  ];
  return out.filter(Boolean).join('\n');
}
