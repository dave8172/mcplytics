// For servers with a disk and Node's own HTTP objects: Node, Bun, Deno (with
// --allow-write). Kept apart from index.js so a Workers bundle never meets a
// `node:` import.
import { appendFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { recorder, guarded, appOf } from './core.js';
import { clean } from './parse.js';

/** Appends one JSON line per event. `mcplytics report <file>` reads it back. */
export function jsonl(path = 'mcplytics.jsonl') {
  let queue = Promise.resolve();
  return {
    write(events) {
      const lines = events.map(e => JSON.stringify(e) + '\n').join('');
      // One write at a time, so lines from concurrent calls never interleave.
      // A failed write rejects this call (onError sees it) but not the next.
      const job = queue.then(() => appendFile(path, lines));
      queue = job.catch(() => {});
      return job;
    },
  };
}

const MAX_KEPT = 8 * 1024 * 1024;

/** A web Headers from Node's headers object. */
function webHeaders(raw) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw || {})) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, String(x)));
    else if (v !== undefined) headers.set(k, String(v));
  }
  return headers;
}

function urlOf(req) {
  const proto = req.socket && req.socket.encrypted ? 'https' : 'http';
  return `${proto}://${req.headers.host || 'localhost'}${req.originalUrl || req.url || '/'}`;
}

/** The request body as text, if a body parser already read it (express.json()). */
function parsedBody(req) {
  const b = req.body;
  if (b === undefined || b === null) return null;
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (typeof b === 'object' && Object.keys(b).length === 0 && !req.headers['content-length']) return null;
  return JSON.stringify(b);
}

/**
 * Express or Connect middleware, for servers whose MCP handler takes Node's
 * `(req, res)`, such as the official SDK's StreamableHTTPServerTransport.
 * Put it after `express.json()`, before your MCP route:
 *
 *   app.use(express.json());
 *   app.use('/mcp', mcplyticsNode({ sink: jsonl('mcplytics.jsonl') }));
 *
 * It copies what the answer writes as it goes out, and records the call
 * once the answer has finished. Hooks get the web Request mcplytics built,
 * the env (undefined here), and Node's `req` as the third argument, where
 * the SDK's bearer-auth middleware leaves `req.auth.clientId`.
 */
export function mcplyticsNode(options = {}) {
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const guard = guarded(onError);
  const record = recorder(options);

  return function middleware(req, res, next) {
    if (req.method !== 'POST') return next();
    const start = Date.now();
    const chunks = [];
    let size = 0;
    let over = false;
    // Headers given to writeHead() don't show in getHeaders(); keep them too.
    let headed = {};
    guard(() => {
      const keep = (chunk, encoding) => {
        if (chunk === undefined || chunk === null || typeof chunk === 'function' || over) return;
        const b = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
        size += b.length;
        if (size > MAX_KEPT) { over = true; chunks.length = 0; return; }
        chunks.push(b);
      };
      const write = res.write;
      const end = res.end;
      const writeHead = res.writeHead;
      res.writeHead = function (status, reason, headers) {
        guard(() => {
          const h = typeof reason === 'object' ? reason : headers;
          if (Array.isArray(h)) for (let i = 0; i + 1 < h.length; i += 2) headed[String(h[i]).toLowerCase()] = h[i + 1];
          else if (h) for (const [k, v] of Object.entries(h)) headed[k.toLowerCase()] = v;
        });
        return writeHead.apply(this, arguments);
      };
      res.write = function (chunk, encoding, cb) { guard(() => keep(chunk, encoding)); return write.apply(this, arguments); };
      res.end = function (chunk, encoding, cb) { guard(() => keep(chunk, encoding)); return end.apply(this, arguments); };
    });

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      guard(() => {
        const doneAt = Date.now();
        const text = parsedBody(req);
        const headers = webHeaders(req.headers);
        // The body was read by a parser before us; describe it by its text.
        if (text !== null) headers.set('content-length', String(Buffer.byteLength(text)));
        const request = new Request(urlOf(req), { method: 'POST', headers, body: text });
        const copy = text === null ? null : request.clone();
        const caller = guard(() => clean(options.caller ? options.caller(request, undefined, req) : '')) || '';
        const app = guard(() => appOf(options, request, undefined, req)) || '';
        const answerHeaders = webHeaders({ ...res.getHeaders(), ...headed });
        const type = answerHeaders.get('content-type') || '';
        const response = new Response(over ? null : Buffer.concat(chunks), { status: res.statusCode, headers: answerHeaders });
        const reply = type.includes('text/event-stream')
          ? { response, stream: response.body, doneAt }
          : { response, answer: response, doneAt };
        record(copy, request, reply, start, { caller, app }, undefined).catch(onError);
      });
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  };
}

/**
 * A `node:http` request listener that runs a web-standard handler
 * (Request → Response). Lets a mcplytics-wrapped handler, or the SDK's
 * WebStandardStreamableHTTPServerTransport, run on plain Node:
 *
 *   http.createServer(serve(mcplytics(handler, options))).listen(3000);
 */
export function serve(handler) {
  return async (req, res) => {
    try {
      const method = req.method || 'GET';
      const init = { method, headers: webHeaders(req.headers) };
      if (method !== 'GET' && method !== 'HEAD') {
        init.body = Readable.toWeb(req);
        init.duplex = 'half';
      }
      const response = await handler(new Request(urlOf(req), init));
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = k in headers ? `${headers[k]}, ${v}` : v; });
      res.writeHead(response.status, headers);
      if (!response.body) return res.end();
      const body = Readable.fromWeb(response.body);
      res.on('close', () => body.destroy());
      body.pipe(res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
}
