// The shared part of the wrappers: turning a request and its answer into
// events. Internal; index.js and node.js are the public faces.
import {
  MAX_BODY, userAgentClient, readCapped, messages, describeRequest,
  responsesById, anonymousError, key, outcome, readStream, oauthApp,
  listedTools, hidesText, fingerprint, foreignOrigin, tokenInUrl,
} from './parse.js';

// Small memories, per isolate or process, best effort.
function remembered(limit) {
  const map = new Map();
  return {
    has: k => map.has(k),
    get: k => map.get(k),
    set(k, v) {
      if (!k) return;
      map.delete(k);
      map.set(k, v);
      if (map.size > limit) map.delete(map.keys().next().value);
    },
  };
}

// Spec versions before 2026-07-28 send the client's name once, in
// `initialize`, and a session ID after. Remember a few so later calls in the
// same session can be named.
const SESSIONS = remembered(1000);
// Tool names from tools/list answers, and the last whole list's fingerprint,
// so a call to a tool nobody listed and a changed list can be noticed.
const TOOLS = remembered(2000);
let lastTools = '';

/** Runs `fn`, sending any error to `onError`. */
export function guarded(onError) {
  return fn => {
    try { return fn(); } catch (e) { try { onError(e); } catch {} return undefined; }
  };
}

/** The OAuth app for this request, from options.oauth. */
export function appOf(options, request, env, ctx) {
  const o = options.oauth;
  return o && typeof o.clientId === 'function' ? oauthApp(o.clientId(request, env, ctx), o.registered) : '';
}

/**
 * Turns one request and its answer into events and writes them. Shared by
 * the web wrapper below and the Node one in node.js.
 *
 * reply: null if the handler threw, else { response, answer | stream, doneAt? }
 */
export function recorder(options = {}) {
  const origins = Array.isArray(options.origins) ? options.origins : [];

  return async function record(copy, request, reply, start, label, env) {
    const length = Number(request.headers.get('content-length') || 0);
    const readable = copy && length <= MAX_BODY;
    // An unread copy holds the whole body in memory; let it go.
    if (copy && !readable && copy.body) copy.body.cancel().catch(() => {});
    const text = readable ? await readCapped(copy.body) : null;
    const msgs = text === null ? null : messages(text);
    const asked = describeRequest(msgs, request.headers);
    const status = reply ? reply.response.status : 500;

    const common = [];
    if (copy && text === null) common.push('oversize');
    else if (text && msgs === null) common.push('unparseable');
    if (foreignOrigin(request.headers.get('origin'), request.url, origins)) common.push('foreign_origin');
    if (tokenInUrl(request.url)) common.push('token_in_url');
    if (status === 403 && /insufficient_scope/.test(reply.response.headers.get('www-authenticate') || '')) common.push('insufficient_scope');

    let found = new Map();
    let doneAt = Date.now();
    let fallback = null;
    let cut = false;
    if (reply && reply.stream) {
      const waiting = new Set(asked.filter(a => a.id !== undefined).map(a => key(a.id)));
      ({ found, doneAt, cut } = await readStream(reply.stream, waiting));
    } else if (reply && reply.answer) {
      const body = await readCapped(reply.answer.body);
      const answered = body === null ? [] : messages(body) || [];
      found = responsesById(answered);
      fallback = anonymousError(answered);
      doneAt = Date.now();
    }
    // A Node response is read after it has gone, and knows when that was.
    if (reply && reply.doneAt) doneAt = reply.doneAt;

    const session = request.headers.get('mcp-session-id');
    const newSession = reply ? reply.response.headers.get('mcp-session-id') : null;
    const fromAgent = userAgentClient(request.headers.get('user-agent'));
    const events = [];
    for (const a of asked) {
      // A notification gets no answer and says nothing about health.
      if (a.id === undefined && a.method.startsWith('notifications/')) continue;
      if (a.method === 'initialize' && a.client) SESSIONS.set(newSession, a.client);
      const client = a.client
        || (session && SESSIONS.has(session) ? { ...SESSIONS.get(session), source: 'session' } : null)
        || (fromAgent ? { ...fromAgent, source: 'user-agent' } : { name: '', version: '', source: '' });
      const answer = found.get(key(a.id)) || null;
      const end = reply ? outcome(answer || (asked.length === 1 ? fallback : null), status, cut)
        : { outcome: 'crash', code: 0 };

      const flags = [...common];
      let toolsHash = '';
      const tools = a.method === 'tools/list' ? listedTools(answer) : null;
      if (tools) {
        for (const t of tools) if (typeof t.name === 'string') TOOLS.set(t.name, true);
        if (hidesText(tools)) flags.push('hidden_text');
        toolsHash = await fingerprint(tools).catch(() => '');
        // Only a whole list compares: one page of a longer list would read as a change.
        if (toolsHash && !a.paged && !answer.result.nextCursor) {
          if (lastTools && lastTools !== toolsHash) flags.push('tools_changed');
          lastTools = toolsHash;
        }
      }
      if (a.method === 'tools/call' && a.name && lastTools && !TOOLS.has(a.name)) flags.push('unknown_tool');

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
        caller: label.caller,
        app: label.app,
        flags: flags.join(','),
        toolsHash,
      });
    }
    if (!events.length) return;
    const sink = typeof options.sink === 'function' ? options.sink(env) : options.sink;
    if (sink && typeof sink.write === 'function') await sink.write(events, env);
  };
}

