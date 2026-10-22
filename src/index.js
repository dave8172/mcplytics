// mcplytics: usage, health and security signals for a remote MCP server,
// from its own front door.
//
// Wrap the function that answers HTTP requests. Each MCP call that passes
// through is written down as one small event: which method and tool, which
// app called, how it ended, how long it took, and any security signal it
// raised. The wrapper reads copies of the request and the answer and hands
// the server's own answer back unchanged. It needs no SDK and no backend, and
// nothing it does can break the server: every step is guarded, and writing
// happens after the answer has left.
import { clean, oauthApp } from './parse.js';
import { recorder, guarded, appOf } from './core.js';

export { oauthApp };

/** Every field an event has. Nothing else is ever kept. */
export const FIELDS = [
  'time', 'method', 'name', 'client', 'clientVersion', 'clientSource',
  'protocol', 'outcome', 'code', 'status', 'ms', 'stream', 'caller', 'app',
  'flags', 'toolsHash',
];

/**
 * The security signals an event can carry, comma-separated in `flags`:
 *   oversize            the request body was over 256 KB, so it wasn't read
 *   unparseable         the request body wasn't JSON
 *   foreign_origin      a browser on another site sent it (Origin header)
 *   unknown_tool        a tools/call for a name this server hasn't listed
 *   insufficient_scope  refused: the token lacks a permission the call needs
 *   token_in_url        a credential was sent in the URL's query string
 *   hidden_text         a tools/list answer hides invisible characters
 *   tools_changed       a tools/list answer differs from the last one seen
 */
export const FLAGS = [
  'oversize', 'unparseable', 'foreign_origin', 'unknown_tool',
  'insufficient_scope', 'token_in_url', 'hidden_text', 'tools_changed',
];

const isRequest = r => !!r && typeof r.url === 'string' && typeof r.method === 'string' && !!r.headers && typeof r.headers.get === 'function';

/**
 * handler: (request, env?, ctx?) => Response       Workers, Deno, Bun, Node
 *       or (context) => Response                    Cloudflare Pages Functions
 * options.sink:    { write(events, env) } or (env) => that
 * options.caller:  (request, env) => string         your own label, e.g. a plan tier
 * options.oauth:   { clientId(request, env, ctx), registered }
 *                                                   the OAuth client your auth step verified
 * options.origins: [string]                         browser origins you expect, e.g. your own web app
 * options.onError: (error) => void                  mcplytics' own failures; default silent
 */
export function mcplytics(handler, options = {}) {
  if (typeof handler !== 'function') throw new TypeError('mcplytics: handler must be a function');
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const guard = guarded(onError);
  const record = recorder(options);

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
    // Asked after the handler, which is where the server's own auth step
    // has checked the token and knows its client ID.
    const app = () => guard(() => appOf(options, request, env, ctx)) || '';

    let response;
    try {
      response = await handler(...args);
    } catch (error) {
      const label = { caller, app: app() };
      guard(() => waitUntil(record(copy, request, null, start, label, env).catch(onError)));
      throw error;
    }
    const label = { caller, app: app() };

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
    guard(() => waitUntil(record(copy, request, { response, answer, stream }, start, label, env).catch(onError)));
    return passed;
  };
}

/**
 * A handler that forwards every request to another MCP server, unchanged,
 * and returns its answer. Wrap it to watch a server written in any language:
 * `mcplytics(proxy('http://127.0.0.1:8000/mcp'), options)`.
 */
export function proxy(target) {
  const to = new URL(target);
  return (request) => {
    const url = new URL(to);
    url.search = new URL(request.url).search;
    const headers = new Headers(request.headers);
    headers.delete('host');
    // Ask for plain bytes, so the answer passes on exactly as it came.
    headers.set('accept-encoding', 'identity');
    const init = { method: request.method, headers, redirect: 'manual' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
      init.duplex = 'half';
    }
    return fetch(url, init);
  };
}

/**
 * Cloudflare Workers Analytics Engine. Bind a dataset to your Worker or Pages
 * project (name it MCPLYTICS, or pass the name you chose). Free plan: 100,000
 * events a day. Without the binding, events are dropped quietly.
 *
 * Layout, which `mcplytics report --cloudflare` reads back:
 *   index1  tool name, or the method when there is none
 *   blob1-12 method, name, client, clientVersion, clientSource, protocol, outcome, caller, stream ("sse"|"json"), app, flags, toolsHash
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
          blobs: [e.method, e.name, e.client, e.clientVersion, e.clientSource, e.protocol, e.outcome, e.caller, e.stream ? 'sse' : 'json', e.app || '', e.flags || '', e.toolsHash || ''],
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
