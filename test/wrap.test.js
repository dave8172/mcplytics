// node --test: the wrapper against small fake servers, one per way a call can end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcplytics, memory, analyticsEngine, oauthApp } from '../src/index.js';

const URL_ = 'https://example.test/mcp';
const NEW = '2026-07-28';

function call(body, headers = {}) {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const toolCall = (id, name, args = {}, client = { name: 'claude-code', version: '2.1.3' }) => ({
  jsonrpc: '2.0', id, method: 'tools/call',
  params: { name, arguments: args, _meta: client ? { 'io.modelcontextprotocol/clientInfo': client, 'io.modelcontextprotocol/protocolVersion': NEW } : {} },
});

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Runs one request through a wrapped handler and waits for the event write. */
async function run(handler, request, options = {}) {
  const sink = memory();
  const pending = [];
  const ctx = { waitUntil: p => pending.push(p) };
  const wrapped = mcplytics(handler, { sink, ...options });
  const response = await wrapped(request, {}, ctx);
  const text = await response.text();
  await Promise.all(pending);
  return { events: sink.events, text, response };
}

const echoResult = async req => {
  const msg = await req.json();
  return json({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'five results' }] } });
};

test('a new-spec tools/call: tool, client, protocol, ok', async () => {
  const { events, text } = await run(echoResult, call(toolCall(1, 'search_docs', { query: 'hosting' }), { 'mcp-method': 'tools/call', 'mcp-name': 'search_docs', 'mcp-protocol-version': NEW }));
  assert.equal(JSON.parse(text).result.content[0].text, 'five results');
  assert.equal(events.length, 1);
  const e = events[0];
  assert.deepEqual(
    { method: e.method, name: e.name, client: e.client, clientVersion: e.clientVersion, clientSource: e.clientSource, protocol: e.protocol, outcome: e.outcome, status: e.status, stream: e.stream },
    { method: 'tools/call', name: 'search_docs', client: 'claude-code', clientVersion: '2.1.3', clientSource: 'meta', protocol: NEW, outcome: 'ok', status: 200, stream: false });
  assert.ok(e.ms >= 0 && typeof e.time === 'string');
});

test('the tool ran and failed: isError is a tool_error, not ok', async () => {
  const handler = async req => { const m = await req.json(); return json({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'upstream down' }] } }); };
  const { events } = await run(handler, call(toolCall(2, 'get_item')));
  assert.equal(events[0].outcome, 'tool_error');
});

test('unknown tool: a JSON-RPC error is a protocol_error with its code', async () => {
  const handler = async req => { const m = await req.json(); return json({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool' } }); };
  const { events } = await run(handler, call(toolCall(3, 'nope')));
  assert.equal(events[0].outcome, 'protocol_error');
  assert.equal(events[0].code, -32602);
});

test('header mismatch: HTTP 400 carrying a JSON-RPC error with id null', async () => {
  const handler = async () => json({ jsonrpc: '2.0', id: null, error: { code: -32020, message: 'Header mismatch' } }, 400);
  const { events } = await run(handler, call(toolCall(4, 'search_docs'), { 'mcp-name': 'other' }));
  assert.equal(events[0].outcome, 'protocol_error');
  assert.equal(events[0].code, -32020);
  assert.equal(events[0].status, 400);
});

test('refused at the door: a 401 with no JSON-RPC body is an http_error', async () => {
  const handler = async () => new Response('sign in first', { status: 401 });
  const { events } = await run(handler, call(toolCall(5, 'search_docs')));
  assert.equal(events[0].outcome, 'http_error');
  assert.equal(events[0].code, 401);
});

test('MRTR: input_required is its own outcome', async () => {
  const handler = async req => { const m = await req.json(); return json({ jsonrpc: '2.0', id: m.id, result: { resultType: 'input_required', inputRequests: {} } }); };
  const { events } = await run(handler, call(toolCall(6, 'book')));
  assert.equal(events[0].outcome, 'input_required');
});

test('streamed answer: client gets every byte; time runs to the final message', async () => {
  const chunks = [
    ': keep-alive\n\n',
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
    'data: {"jsonrpc":"2.0","id":7,\ndata: "result":{"content":[]}}\n\n',
  ];
  const handler = async () => {
    const body = new ReadableStream({
      async start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(chunks[0]));
        await new Promise(r => setTimeout(r, 40));
        c.enqueue(enc.encode(chunks[1]));
        await new Promise(r => setTimeout(r, 40));
        c.enqueue(enc.encode(chunks[2]));
        c.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const { events, text, response } = await run(handler, call(toolCall(7, 'slow_tool')));
  assert.equal(text, chunks.join(''));
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(events[0].outcome, 'ok');
  assert.equal(events[0].stream, true);
  assert.ok(events[0].ms >= 70, `ms ${events[0].ms}`);
});

test('stream closed before the answer: no_response', async () => {
  const handler = async () => new Response('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const { events } = await run(handler, call(toolCall(8, 'slow_tool')));
  assert.equal(events[0].outcome, 'no_response');
});

test('stream past 8 MB before the answer: unread, not no_response; client still gets the answer', async () => {
  const filler = `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"note":"${'x'.repeat(64 * 1024)}"}}\n\n`;
  const answer = 'data: {"jsonrpc":"2.0","id":10,"result":{"content":[]}}\n\n';
  const handler = async () => {
    const enc = new TextEncoder();
    let sent = 0;
    const body = new ReadableStream({
      pull(c) {
        if (sent++ < 130) return c.enqueue(enc.encode(filler));
        c.enqueue(enc.encode(answer));
        c.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const { events, text } = await run(handler, call(toolCall(10, 'chatty_tool')));
  assert.ok(text.length > 8 * 1024 * 1024 && text.endsWith(answer));
  assert.equal(events[0].outcome, 'unread');
});

test('older spec: initialize names the client, the session ID carries it to later calls', async () => {
  const handler = async req => {
    const m = await req.json();
    if (m.method === 'initialize') return json({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } }, 200, { 'mcp-session-id': 'sess-1' });
    return json({ jsonrpc: '2.0', id: m.id, result: { content: [] } });
  };
  const init = await run(handler, call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'cursor', version: '1.9' } } }));
  assert.equal(init.events[0].client, 'cursor');
  assert.equal(init.events[0].clientSource, 'initialize');
  assert.equal(init.events[0].protocol, '2025-06-18');
  const later = await run(handler, call(toolCall(2, 'search_docs', {}, null), { 'mcp-session-id': 'sess-1' }));
  assert.equal(later.events[0].client, 'cursor');
  assert.equal(later.events[0].clientSource, 'session');
});

test('no client info anywhere: the User-Agent names it', async () => {
  const { events } = await run(echoResult, call(toolCall(9, 'list_categories', {}, null), { 'user-agent': 'python-httpx/0.28.1' }));
  assert.equal(events[0].client, 'python-httpx');
  assert.equal(events[0].clientVersion, '0.28.1');
  assert.equal(events[0].clientSource, 'user-agent');
});

test('a batch (spec before 2025-06-18) gives one event per call; notifications give none', async () => {
  const handler = async req => {
    const list = await req.json();
    return json(list.filter(m => m.id !== undefined).map(m => ({ jsonrpc: '2.0', id: m.id, result: { content: [] } })));
  };
  const { events } = await run(handler, call([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    toolCall('a', 'get_item'),
    toolCall('b', 'list_categories'),
  ]));
  assert.deepEqual(events.map(e => e.name), ['get_item', 'list_categories']);
});

test('Base64 Mcp-Name is decoded', async () => {
  const name = 'suche_programme';
  const b64 = `=?base64?${Buffer.from(name).toString('base64')}?=`;
  const { events } = await run(echoResult, call(toolCall(10, name), { 'mcp-name': b64 }));
  assert.equal(events[0].name, name);
});

test('never keeps arguments, results, or Mcp-Param headers', async () => {
  const planted = 'planted-4242-value';
  const handler = async req => {
    const m = await req.json();
    return json({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echo ${m.params.arguments.q}` }] } });
  };
  const { events } = await run(handler, call(toolCall(11, 'search', { q: planted }), { 'mcp-param-q': planted, authorization: `Bearer ${planted}` }));
  assert.ok(!JSON.stringify(events).includes(planted));
  assert.ok(!JSON.stringify(events).includes('echo'));
});

test('never keeps error text: a protocol error message, error.data, or a failed tool\'s result', async () => {
  const planted = 'planted-7731-record';
  const asProtocol = async req => { const m = await req.json(); return json({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `bad q: ${planted}`, data: { excerpt: planted } } }); };
  const asTool = async req => { const m = await req.json(); return json({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: `no match in "${planted}"` }] } }); };
  const asStream = async req => {
    const m = await req.json();
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: planted }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const asAnonymous = async () => json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `cannot parse ${planted}` } }, 400);
  for (const [handler, outcome] of [[asProtocol, 'protocol_error'], [asTool, 'tool_error'], [asStream, 'tool_error'], [asAnonymous, 'protocol_error']]) {
    const { events } = await run(handler, call(toolCall(30, 'search', { q: 'x' })));
    assert.equal(events[0].outcome, outcome);
    assert.ok(!JSON.stringify(events).includes(planted));
  }
});

test('oauthApp: a metadata-document URL gives its host; an ID you issued, your name; any other, (unlisted)', () => {
  assert.equal(oauthApp('https://app.example.com/oauth/client.json'), 'app.example.com');
  assert.equal(oauthApp('k3x9-prod', { 'k3x9-prod': 'acme-desktop' }), 'acme-desktop');
  assert.equal(oauthApp('9f2c41d0-6b1e-4a51-8f3e-2d7a0c5e1b77'), '(unlisted)');
  assert.equal(oauthApp('http://app.example.com/client.json'), '(unlisted)');
  assert.equal(oauthApp('toString'), '(unlisted)');
  assert.equal(oauthApp(undefined), '');
  assert.equal(oauthApp(''), '');
});

test('oauth: the client ID the handler verified is read after it runs, and never kept raw', async () => {
  const verified = new WeakMap();
  const handler = async req => { verified.set(req, req.headers.get('x-test-client')); return echoResult(req); };
  const oauth = { clientId: req => verified.get(req), registered: { 'k3x9-prod': 'acme-desktop' } };
  const cases = [
    ['https://app.example.com/oauth/client.json', 'app.example.com'],
    ['k3x9-prod', 'acme-desktop'],
    ['dcr-5d1f9a7e', '(unlisted)'],
  ];
  for (const [id, app] of cases) {
    const { events } = await run(handler, call(toolCall(31, 'search'), { 'x-test-client': id }), { oauth });
    assert.equal(events[0].app, app);
    if (app === '(unlisted)') assert.ok(!JSON.stringify(events).includes(id));
  }
  const { events } = await run(echoResult, call(toolCall(32, 'search')));
  assert.equal(events[0].app, '');
});

test('oauth: a throwing clientId hook leaves the answer and the event alone', async () => {
  const { events, text } = await run(echoResult, call(toolCall(33, 'search')), { oauth: { clientId: () => { throw new Error('no'); } } });
  assert.equal(JSON.parse(text).result.content[0].text, 'five results');
  assert.equal(events[0].app, '');
  assert.equal(events[0].outcome, 'ok');
});

test('resources/read keeps no URI', async () => {
  const { events } = await run(echoResult, call({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'file:///home/me/notes.txt' } }, { 'mcp-name': 'file:///home/me/notes.txt' }));
  assert.equal(events[0].name, '');
  assert.ok(!JSON.stringify(events).includes('notes'));
});

test('names from strangers are cut and cleaned', async () => {
  const { events } = await run(echoResult, call(toolCall(13, 'x'.repeat(500) + '\u0000‮', {}, { name: 'evil\nname'.repeat(20), version: '1' })));
  assert.ok(events[0].name.length <= 128);
  assert.ok(events[0].client.length <= 64 && !/\n/.test(events[0].client));
});

test('the handler still reads the body; GET and OPTIONS pass untouched', async () => {
  let seen = null;
  const handler = async req => {
    if (req.method !== 'POST') return new Response('hi', { status: 405 });
    seen = await req.json();
    return json({ jsonrpc: '2.0', id: seen.id, result: {} });
  };
  await run(handler, call(toolCall(14, 'search', { q: 'x' })));
  assert.equal(seen.params.arguments.q, 'x');
  const sink = memory();
  const wrapped = mcplytics(handler, { sink });
  for (const method of ['GET', 'OPTIONS']) {
    const r = await wrapped(new Request(URL_, { method }));
    assert.equal(r.status, 405);
  }
  assert.equal(sink.events.length, 0);
});

test('unreadable body: still recorded, server answer untouched', async () => {
  const handler = async () => json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  const { events, text } = await run(handler, call('{not json', { 'mcp-method': 'tools/call' }));
  assert.equal(JSON.parse(text).error.code, -32700);
  assert.equal(events[0].method, 'tools/call');
  assert.equal(events[0].outcome, 'protocol_error');
});

test('a broken sink never breaks the server', async () => {
  const errors = [];
  const sink = { write() { throw new Error('disk full'); } };
  const pending = [];
  const wrapped = mcplytics(echoResult, { sink, onError: e => errors.push(e.message) });
  const r = await wrapped(call(toolCall(15, 'search')), {}, { waitUntil: p => pending.push(p) });
  assert.equal(r.status, 200);
  await Promise.all(pending);
  assert.deepEqual(errors, ['disk full']);
});

test('a broken caller hook is ignored', async () => {
  const { events } = await run(echoResult, call(toolCall(16, 'search')), { caller: () => { throw new Error('boom'); } });
  assert.equal(events[0].caller, '');
});

test('the handler throws: the error reaches the runtime, the call is recorded as a crash', async () => {
  const sink = memory();
  const pending = [];
  const wrapped = mcplytics(async () => { throw new Error('bug'); }, { sink });
  await assert.rejects(wrapped(call(toolCall(17, 'search')), {}, { waitUntil: p => pending.push(p) }), /bug/);
  await Promise.all(pending);
  assert.equal(sink.events[0].outcome, 'crash');
  assert.equal(sink.events[0].name, 'search');
});

test('Cloudflare Pages Functions: context in, waitUntil used, caller label kept', async () => {
  const points = [];
  const pending = [];
  const env = { MCPLYTICS: { writeDataPoint: p => points.push(p) } };
  const onRequestPost = mcplytics(async ({ request }) => echoResult(request), {
    sink: analyticsEngine(),
    caller: req => (req.headers.get('authorization') ? 'key' : 'free'),
  });
  const r = await onRequestPost({ request: call(toolCall(18, 'search_docs')), env, waitUntil: p => pending.push(p) });
  assert.equal(r.status, 200);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.deepEqual(points[0].indexes, ['search_docs']);
  assert.deepEqual(points[0].blobs.slice(0, 3), ['tools/call', 'search_docs', 'claude-code']);
  assert.equal(points[0].blobs[6], 'ok');
  assert.equal(points[0].blobs[7], 'free');
  assert.equal(points[0].blobs[9], '');
  assert.equal(points[0].doubles[1], 200);
});

test('no binding: Analytics Engine sink drops quietly', async () => {
  const { events } = await run(echoResult, call(toolCall(19, 'search')), { sink: analyticsEngine() });
  assert.equal(events.length, 0);
});
