import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, format, percentile } from '../src/report.js';
import { toRows } from '../src/read.js';
import { jsonl } from '../src/node.js';

const ev = (name, outcome, ms, extra = {}) => ({
  time: '2026-10-20T10:00:00.000Z', method: 'tools/call', name, client: 'claude-code', clientVersion: '2', clientSource: 'meta',
  protocol: '2026-07-28', outcome, code: 0, status: 200, ms, stream: false, caller: '', ...extra,
});

test('weighted percentiles', () => {
  const rows = [{ ms: 10, weight: 9 }, { ms: 1000, weight: 1 }];
  assert.equal(percentile(rows, 0.5), 10);
  assert.equal(percentile(rows, 0.95), 1000);
  assert.equal(percentile([], 0.5), null);
});

test('summary: tools ranked, failures counted, input_required kept apart', () => {
  const rows = [
    ev('search', 'ok', 20), ev('search', 'ok', 30), ev('search', 'tool_error', 900),
    ev('get', 'ok', 5), ev('book', 'input_required', 50), ev('book', 'ok', 60),
    ev('', 'ok', 2, { method: 'tools/list', client: 'cursor' }),
  ];
  const s = summarize(rows);
  assert.equal(s.total.calls, 6);
  assert.equal(s.inputRequired, 1);
  assert.equal(s.tools[0].label, 'search');
  assert.equal(s.tools[0].calls, 3);
  assert.equal(s.tools[0].failed, 1);
  assert.deepEqual(s.clients.map(c => c.label), ['claude-code', 'cursor']);
  assert.equal(s.days[0].calls, 6);
  assert.match(format(s), /search\s+3\s+33%/);
});

test('unread is not counted as failed', () => {
  const s = summarize([ev('chatty', 'unread', 4000), ev('chatty', 'no_response', 100)]);
  assert.equal(s.tools[0].calls, 2);
  assert.equal(s.tools[0].failed, 1);
  assert.equal(s.outcomes.unread, 1);
});

test('method not found is counted apart, not as a failed call', () => {
  const s = summarize([
    ev('search', 'ok', 10),
    ev('', 'protocol_error', 50, { method: 'server/discover', code: -32601, client: 'some-probe' }),
    ev('', 'protocol_error', 50, { method: 'server/discover', code: '-32601', client: 'other-probe' }),
    ev('nope', 'protocol_error', 3, { code: -32602 }),
  ]);
  assert.equal(s.total.calls, 2);
  assert.equal(s.total.failed, 1);
  assert.deepEqual(s.notOffered, [{ method: 'server/discover', calls: 2 }]);
  assert.equal(s.outcomes.not_offered, 2);
  assert.equal(s.outcomes.protocol_error, 1);
  assert.ok(!s.methods.some(m => m.label === 'server/discover'));
  assert.match(format(s), /doesn't have[^\n]*\nserver\/discover\s+2/);
});

test('sampled Analytics Engine rows count by weight', () => {
  const s = summarize([ev('search', 'ok', 10, { weight: 100 }), ev('get', 'ok', 10, { weight: 1 })]);
  assert.equal(s.total.calls, 101);
  assert.equal(s.tools[0].label, 'search');
});

test('SQL API answers, both shapes', () => {
  const row = { timestamp: '2026-10-20 10:00:00', method: 'tools/call', name: 'search', outcome: 'ok', ms: '12', status: '200', code: '0', weight: '1', stream: 'sse' };
  for (const text of [JSON.stringify({ meta: [], data: [row], rows: 1 }), JSON.stringify(row) + '\n']) {
    const [r] = toRows(text);
    assert.equal(r.time, '2026-10-20T10:00:00Z');
    assert.equal(r.ms, 12);
    assert.equal(r.stream, true);
  }
});

test('jsonl sink writes lines a report can read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcplytics-'));
  const path = join(dir, 'calls.jsonl');
  const sink = jsonl(path);
  await Promise.all([sink.write([ev('a', 'ok', 1)]), sink.write([ev('b', 'ok', 2), ev('c', 'ok', 3)])]);
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map(l => JSON.parse(l).name);
  assert.deepEqual(lines, ['a', 'b', 'c']);
});

test('empty report says so', () => {
  assert.equal(format(summarize([])), 'No MCP calls recorded yet.');
});

test('apps by verified OAuth client: shown only when some call has one', () => {
  const plain = format(summarize([ev('search', 'ok', 5)]));
  assert.ok(!plain.includes('OAuth'));
  const s = summarize([ev('search', 'ok', 5, { app: 'app.example.com' }), ev('search', 'ok', 7, { app: 'app.example.com' }), ev('get', 'ok', 3)]);
  assert.deepEqual(s.apps.map(a => [a.label, a.calls]), [['app.example.com', 2]]);
  assert.ok(format(s).includes('Apps by verified OAuth client'));
});
