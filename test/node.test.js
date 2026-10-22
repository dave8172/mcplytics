// node --test: the Node side. Express-style middleware on real node:http
// servers, the serve() adapter, and proxy() in front of another server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mcplytics, memory, proxy } from '../src/index.js';
import { mcplyticsNode, serve } from '../src/node.js';

function listen(listener) {
  return new Promise(resolve => {
    const server = http.createServer(listener);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` }));
  });
}

const toolCall = (id, name, args = { q: 'planted-node-value' }) => ({
  jsonrpc: '2.0', id, method: 'tools/call',
  params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.3' } } },
});

const post = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body: JSON.stringify(body),
});

/** Waits until the sink has `n` events. Node records after the answer has gone. */
async function settle(sink, n) {
  for (let i = 0; i < 100 && sink.events.length < n; i++) await new Promise(r => setTimeout(r, 10));
  return sink.events;
}

// What express.json() does: read the body, parse it, leave it on req.body.
const bodyParser = (req, done) => {
  let text = '';
  req.on('data', c => { text += c; });
  req.on('end', () => { try { req.body = JSON.parse(text); } catch { req.body = {}; } done(); });
};

test('Node middleware: a JSON answer from a (req, res) handler, with the OAuth client from req.auth', async () => {
  const sink = memory();
  const middleware = mcplyticsNode({ sink, oauth: { clientId: (_r, _e, req) => req.auth && req.auth.clientId } });
  const { server, url } = await listen((req, res) => bodyParser(req, () => {
    req.auth = { clientId: 'https://app.example.com/oauth/client.json' };
    middleware(req, res, () => {
      const m = req.body;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo planted-node-value' }] } }));
    });
  }));
  try {
    const r = await post(url, toolCall(1, 'search'));
    assert.equal((await r.json()).result.content[0].text, 'echo planted-node-value');
    const [e] = await settle(sink, 1);
    assert.equal(e.method, 'tools/call');
    assert.equal(e.name, 'search');
    assert.equal(e.client, 'claude-code');
    assert.equal(e.outcome, 'ok');
    assert.equal(e.app, 'app.example.com');
    assert.ok(!JSON.stringify(sink.events).includes('planted-node-value'));
  } finally {
    server.close();
  }
});

test('Node middleware: an event-stream answer written in pieces; a tool error inside it', async () => {
  const sink = memory();
  const middleware = mcplyticsNode({ sink });
  const { server, url } = await listen((req, res) => bodyParser(req, () => middleware(req, res, async () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n');
    await new Promise(r => setTimeout(r, 30));
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: req.body.id, result: { isError: true, content: [{ type: 'text', text: 'down' }] } })}\n\n`);
  })));
  try {
    const r = await post(url, toolCall(2, 'get_item'));
    assert.ok((await r.text()).includes('"isError":true'));
    const [e] = await settle(sink, 1);
    assert.equal(e.outcome, 'tool_error');
    assert.equal(e.stream, true);
    assert.ok(e.ms >= 25, `ms ${e.ms}`);
  } finally {
    server.close();
  }
});

test('Node middleware: GET passes straight through and records nothing', async () => {
  const sink = memory();
  const middleware = mcplyticsNode({ sink });
  const { server, url } = await listen((req, res) => middleware(req, res, () => { res.writeHead(405); res.end(); }));
  try {
    const r = await fetch(url);
    assert.equal(r.status, 405);
    await new Promise(r => setTimeout(r, 30));
    assert.equal(sink.events.length, 0);
  } finally {
    server.close();
  }
});

test('Node middleware: a throwing hook never touches the answer', async () => {
  const sink = memory();
  const middleware = mcplyticsNode({ sink, caller: () => { throw new Error('no'); } });
  const { server, url } = await listen((req, res) => bodyParser(req, () => middleware(req, res, () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: req.body.id, result: {} }));
  })));
  try {
    const r = await post(url, toolCall(3, 'search'));
    assert.equal(r.status, 200);
    const [e] = await settle(sink, 1);
    assert.equal(e.caller, '');
  } finally {
    server.close();
  }
});

test('serve(): a web-standard handler on plain node:http, streaming both ways', async () => {
  const sink = memory();
  const handler = mcplytics(async req => {
    const m = await req.json();
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [] } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'abc' } });
  }, { sink });
  const { server, url } = await listen(serve(handler));
  try {
    const r = await post(url, toolCall(4, 'search'));
    assert.equal(r.headers.get('mcp-session-id'), 'abc');
    assert.equal((await r.json()).id, 4);
    const [e] = await settle(sink, 1);
    assert.equal(e.outcome, 'ok');
    assert.equal(e.name, 'search');
  } finally {
    server.close();
  }
});

test('proxy(): watch a server in another language by standing in front of it', async () => {
  const seen = [];
  const upstream = await listen((req, res) => {
    let text = '';
    req.on('data', c => { text += c; });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, search: new URL(req.url, 'http://x').search });
      const m = JSON.parse(text);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool' } }));
    });
  });
  const sink = memory();
  const front = await listen(serve(mcplytics(proxy(upstream.url), { sink })));
  try {
    const r = await post(`${front.url}?v=1`, toolCall(5, 'nope'), { authorization: 'Bearer t0k' });
    assert.equal((await r.json()).error.code, -32602);
    assert.deepEqual(seen, [{ auth: 'Bearer t0k', search: '?v=1' }]);
    const [e] = await settle(sink, 1);
    assert.equal(e.outcome, 'protocol_error');
    assert.equal(e.code, -32602);
  } finally {
    front.server.close();
    upstream.server.close();
  }
});
