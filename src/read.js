// Where report rows come from: a JSONL file written by the `jsonl` sink, or
// Workers Analytics Engine through Cloudflare's SQL API.
import { readFile } from 'node:fs/promises';

export const LIMIT = 10000;

export async function fromFile(path, days) {
  const since = Date.now() - days * 864e5;
  const text = await readFile(path, 'utf8');
  return text.split('\n').filter(Boolean).flatMap(l => {
    try { return [JSON.parse(l)]; } catch { return []; }
  }).filter(r => Date.parse(r.time) >= since);
}

export async function fromCloudflare({ account, dataset = 'mcplytics' }, days) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account) throw new Error('--account is required with --cloudflare');
  if (!token) throw new Error('set CLOUDFLARE_API_TOKEN (Account Analytics: Read)');
  if (!/^[A-Za-z0-9_]+$/.test(dataset)) throw new Error('--dataset: letters, digits and _ only');
  if (!/^[0-9a-f]{32}$/i.test(account)) throw new Error('--account: a 32-character account ID');
  const sql = `SELECT timestamp, blob1 AS method, blob2 AS name, blob3 AS client, blob4 AS clientVersion,
    blob5 AS clientSource, blob6 AS protocol, blob7 AS outcome, blob8 AS caller, blob9 AS stream,
    double1 AS ms, double2 AS status, double3 AS code, _sample_interval AS weight
    FROM ${dataset} WHERE timestamp > NOW() - INTERVAL '${days}' DAY
    ORDER BY timestamp DESC LIMIT ${LIMIT} FORMAT JSON`;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cloudflare answered ${res.status}: ${text.slice(0, 300)}`);
  return toRows(text);
}

/** The SQL API's answer as rows. FORMAT JSON gives { data: [...] }; JSONEachRow gives lines. */
export function toRows(text) {
  let data;
  try {
    const body = JSON.parse(text);
    // One JSONEachRow line also parses as JSON: a single row.
    data = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : [body];
  } catch {
    data = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
  return data.map(r => ({
    ...r,
    time: /Z$|[+-]\d\d:?\d\d$/.test(r.timestamp) ? r.timestamp : String(r.timestamp).replace(' ', 'T') + 'Z',
    ms: Number(r.ms), status: Number(r.status), code: Number(r.code), weight: Number(r.weight) || 1,
    stream: r.stream === 'sse',
  }));
}
