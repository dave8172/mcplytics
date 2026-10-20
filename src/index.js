// mcplytics: usage and health for a remote MCP server, from its own front door.
//
// Wrap the function that answers HTTP requests. Each MCP call that passes
// through is written down as one small event: which method and tool, which
// app called, how it ended and how long it took. The wrapper reads copies of
// the request and the answer and hands the server's own answer back
// unchanged. It needs no SDK and no backend, and nothing it does can break
// the server: every step is guarded, and writing happens after the answer has
// left.
import {
  MAX_BODY, clean, userAgentClient, readCapped, messages, describeRequest,
  responsesById, anonymousError, key, outcome, readStream,
} from './parse.js';

/** Every field an event has. Nothing else is ever kept. */
export const FIELDS = [
  'time', 'method', 'name', 'client', 'clientVersion', 'clientSource',
  'protocol', 'outcome', 'code', 'status', 'ms', 'stream', 'caller',
];

const isRequest = r => !!r && typeof r.url === 'string' && typeof r.method === 'string' && !!r.headers && typeof r.headers.get === 'function';

// Spec versions before 2026-07-28 send the client's name once, in
// `initialize`, and a session ID after. Remember a few so later calls in the
// same session can be named. Per isolate or process, best effort.
const SESSIONS = new Map();
const SESSION_LIMIT = 1000;
function rememberSession(id, client) {
  if (!id || !client) return;
  SESSIONS.delete(id);
  SESSIONS.set(id, client);
  if (SESSIONS.size > SESSION_LIMIT) SESSIONS.delete(SESSIONS.keys().next().value);
}

/**
 * handler: (request, env?, ctx?) => Response       Workers, Deno, Bun, Node
 *       or (context) => Response                    Cloudflare Pages Functions
 * options.sink:   { write(events, env) } or (env) => that
 * options.caller: (request, env) => string          your own label, e.g. a plan tier
 * options.onError: (error) => void                  mcplytics' own failures; default silent
 */
export function mcplytics(handler, options = {}) {
  if (typeof handler !== 'function') throw new TypeError('mcplytics: handler must be a function');
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const guard = fn => {
    try { return fn(); } catch (e) { try { onError(e); } catch {} return undefined; }
  };

  return async function wrapped(...args) {
    const first = args[0];
    const pages = !isRequest(first) && first && isRequest(first.request);
    const request = pages ? first.request : first;
    // Only POST carries MCP messages. GET (a browser, an old event stream),
    // OPTIONS (CORS) and DELETE pass straight through.
    if (!isRequest(request) || request.method !== 'POST') return handler(...args);

    const env = pages ? first.env : args[1];
    const ctx = pages ? first : args[2];
    const waitUntil = ctx && typeof ctx.waitUntil === 'function' ? p => ctx.waitUntil(p) : p => p;
    const start = Date.now();
    const copy = guard(() => request.clone());
    const caller = guard(() => clean(options.caller ? options.caller(request, env) : '')) || '';

    let response;
    try {
      response = await handler(...args);
    } catch (error) {
      guard(() => waitUntil(record(copy, request, null, start, caller, env).catch(onError)));
      throw error;
    }

    let passed = response;
    let stream = null;
    guard(() => {
      const type = response.headers.get('content-type') || '';
      if (type.includes('text/event-stream') && response.body) {
        // The client gets one branch at full speed; we read the other.
        const [toClient, toUs] = response.body.tee();
        passed = new Response(toClient, { status: response.status, statusText: response.statusText, headers: response.headers });
        stream = toUs;
      }
    });
    const answer = stream ? null : guard(() => response.clone());
    guard(() => waitUntil(record(copy, request, { response, answer, stream }, start, caller, env).catch(onError)));
    return passed;
  };

  async function record(copy, request, reply, start, caller, env) {
    const length = Number(request.headers.get('content-length') || 0);
    const readable = copy && length <= MAX_BODY;
    // An unread copy holds the whole body in memory; let it go.
    if (copy && !readable && copy.body) copy.body.cancel().catch(() => {});
    const text = readable ? await readCapped(copy.body) : null;
    const asked = describeRequest(text === null ? null : messages(text), request.headers);
    const status = reply ? reply.response.status : 500;

    let found = new Map();
    let doneAt = Date.now();
    let fallback = null;
    if (reply && reply.stream) {
      const waiting = new Set(asked.filter(a => a.id !== undefined).map(a => key(a.id)));
      ({ found, doneAt } = await readStream(reply.stream, waiting));
    } else if (reply && reply.answer) {
      const body = await readCapped(reply.answer.body);
      const msgs = body === null ? [] : messages(body) || [];
      found = responsesById(msgs);
      fallback = anonymousError(msgs);
      doneAt = Date.now();
    }

    const session = request.headers.get('mcp-session-id');
    const newSession = reply ? reply.response.headers.get('mcp-session-id') : null;
    const fromAgent = userAgentClient(request.headers.get('user-agent'));
    const events = [];
    for (const a of asked) {
      // A notification gets no answer and says nothing about health.
      if (a.id === undefined && a.method.startsWith('notifications/')) continue;
      if (a.method === 'initialize' && a.client) rememberSession(newSession, a.client);
      const client = a.client
        || (session && SESSIONS.has(session) ? { ...SESSIONS.get(session), source: 'session' } : null)
        || (fromAgent ? { ...fromAgent, source: 'user-agent' } : { name: '', version: '', source: '' });
      const end = reply ? outcome(found.get(key(a.id)) || (asked.length === 1 ? fallback : null), status)
        : { outcome: 'crash', code: 0 };
      events.push({
        time: new Date(start).toISOString(),
        method: a.method,
        name: a.name,
        client: client.name,
        clientVersion: client.version,
        clientSource: client.source,
        protocol: a.protocol,
        outcome: end.outcome,
        code: end.code,
        status,
        ms: Math.max(0, doneAt - start),
        stream: !!(reply && reply.stream),
        caller,
      });
    }
    if (!events.length) return;
    const sink = typeof options.sink === 'function' ? options.sink(env) : options.sink;
    if (sink && typeof sink.write === 'function') await sink.write(events, env);
  }
}

/**
 * Cloudflare Workers Analytics Engine. Bind a dataset to your Worker or Pages
 * project (name it MCPLYTICS, or pass the name you chose). Free plan: 100,000
 * events a day. Without the binding, events are dropped quietly.
 *
 * Layout, which `mcplytics report --cloudflare` reads back:
 *   index1  tool name, or the method when there is none
 *   blob1-9 method, name, client, clientVersion, clientSource, protocol, outcome, caller, stream ("sse"|"json")
 *   double1-3 ms, status, code
 */
export function analyticsEngine(binding = 'MCPLYTICS') {
  return {
    write(events, env) {
      const dataset = env && env[binding];
      if (!dataset || typeof dataset.writeDataPoint !== 'function') return;
      for (const e of events) {
        dataset.writeDataPoint({
          indexes: [(e.name || e.method).slice(0, 96)],
          blobs: [e.method, e.name, e.client, e.clientVersion, e.clientSource, e.protocol, e.outcome, e.caller, e.stream ? 'sse' : 'json'],
          doubles: [e.ms, e.status, e.code],
        });
      }
    },
  };
}

/** Keeps events in an array. For tests, or to print them yourself. */
export function memory() {
  const events = [];
  return { events, write(batch) { events.push(...batch); } };
}

/** Sends each event to a function of yours, e.g. `console.log`. */
export function callback(fn) {
  return { write(batch) { for (const e of batch) fn(e); } };
}
