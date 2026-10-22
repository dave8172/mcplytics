// Reading MCP traffic without taking part in it.
//
// Everything here works on copies: a request's body text, a response's body
// text or event stream. Nothing is sent, nothing is changed. The only fields
// kept are the ones listed in FIELDS (index.js); a tool's arguments and
// results are read past, never copied out.

export const MAX_BODY = 256 * 1024;
const MAX_STREAM = 8 * 1024 * 1024;

const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const PROTOCOL = 'io.modelcontextprotocol/protocolVersion';

/** Printable ASCII only, cut to `max`. Names come from strangers. */
export function clean(value, max = 64) {
  if (typeof value !== 'string') return '';
  return value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);
}

/**
 * `Mcp-Name` may arrive Base64-encoded as `=?base64?…?=` (2026-07-28) so a
 * name outside ASCII survives the header. Returns '' if it can't be decoded.
 */
export function headerName(raw) {
  if (!raw) return '';
  const m = /^=\?base64\?(.*)\?=$/i.exec(raw.trim());
  if (!m) return clean(raw, 128);
  try {
    const bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
    return clean(new TextDecoder().decode(bytes), 128);
  } catch {
    return '';
  }
}

/**
 * The app behind an OAuth client ID your server has verified. A Client ID
 * Metadata Document ID is an HTTPS URL that the authorization server fetched
 * and checked, so its host names the app. An ID you issued yourself is named
 * by `registered`. Any other ID, usually one a client registered for itself,
 * names one installation rather than an app, so it is not kept.
 */
export function oauthApp(clientId, registered = {}) {
  if (typeof clientId !== 'string' || !clientId) return '';
  if (clientId.startsWith('https://')) {
    try { return clean(new URL(clientId).hostname, 128); } catch { return ''; }
  }
  if (registered && Object.hasOwn(registered, clientId)) return clean(registered[clientId]);
  return '(unlisted)';
}

/** First product token of a User-Agent: `claude-code/2.1.3 (cli)` → name and version. */
export function userAgentClient(ua) {
  const m = /^([A-Za-z0-9._@+-]+)(?:\/([A-Za-z0-9._+-]+))?/.exec((ua || '').trim());
  return m ? { name: clean(m[1]), version: clean(m[2] || '', 32) } : null;
}

/** The body as text, or null if it is longer than `max`. Stops reading at the cap. */
export async function readCapped(body, max = MAX_BODY) {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** JSON-RPC messages in a body: one object, or a batch (spec before 2025-06-18). */
export function messages(text) {
  if (!text) return [];
  try {
    const body = JSON.parse(text);
    const list = Array.isArray(body) ? body : [body];
    return list.filter(m => m && typeof m === 'object');
  } catch {
    return null;
  }
}

/**
 * What a request asks for. One entry per JSON-RPC message, so a batch gives
 * several. Headers win where the spec puts the answer in both places.
 */
export function describeRequest(msgs, headers) {
  const hMethod = clean(headers.get('mcp-method') || '', 64);
  const hName = headerName(headers.get('mcp-name'));
  const hProtocol = clean(headers.get('mcp-protocol-version') || '', 32);
  if (msgs === null || msgs.length === 0) {
    return [{ id: undefined, method: hMethod || '(unreadable)', name: hName, protocol: hProtocol, client: null }];
  }
  return msgs.map(msg => {
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
    const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
    const method = clean(typeof msg.method === 'string' ? msg.method : '', 64) || (msgs.length === 1 ? hMethod : '');
    // Only tools and prompts are named. A resource's URI can carry an ID or a
    // path, so it is not kept.
    const named = method === 'tools/call' || method === 'prompts/get';
    const name = named ? (msgs.length === 1 && hName) || clean(params.name, 128) : '';
    let client = null;
    const info = meta[CLIENT_INFO];
    if (info && typeof info === 'object' && clean(info.name)) {
      client = { name: clean(info.name), version: clean(info.version, 32), source: 'meta' };
    } else if (method === 'initialize' && params.clientInfo && clean(params.clientInfo.name)) {
      client = { name: clean(params.clientInfo.name), version: clean(params.clientInfo.version, 32), source: 'initialize' };
    }
    const protocol = hProtocol || clean(meta[PROTOCOL], 32) || (method === 'initialize' ? clean(params.protocolVersion, 32) : '');
    return { id: msg.id, method, name, protocol, client };
  });
}

/** Responses by id. A message with neither result nor error is a notification or a request to the client. */
export function responsesById(msgs, into = new Map()) {
  for (const m of msgs || []) {
    if (m && m.id !== undefined && m.id !== null && ('result' in m || 'error' in m)) into.set(key(m.id), m);
  }
  return into;
}

/** A JSON-RPC error with id null answers a request that couldn't be read at all. */
export function anonymousError(msgs) {
  return (msgs || []).find(m => m && m.id === null && m.error) || null;
}

export const key = id => (typeof id === 'string' ? 's:' : 'n:') + String(id);

/**
 * How one call ended:
 *   ok              a result
 *   tool_error      a result with isError: the tool ran and failed
 *   input_required  the server asked the client for more (2026-07-28 MRTR); the client retries
 *   protocol_error  a JSON-RPC error: unknown tool, bad arguments, header mismatch
 *   http_error      refused before any JSON-RPC answer (status >= 400, no message)
 *   no_response     a 2xx with no answer for this id: the stream closed first
 *   unread          a stream past MAX_STREAM: reading stopped before the answer, so how it ended is unknown
 */
export function outcome(reply, status, cut = false) {
  if (reply && reply.error) return { outcome: 'protocol_error', code: Number(reply.error.code) || 0 };
  if (reply && reply.result) {
    if (reply.result.resultType === 'input_required') return { outcome: 'input_required', code: 0 };
    if (reply.result.isError === true) return { outcome: 'tool_error', code: 0 };
    return { outcome: 'ok', code: 0 };
  }
  if (status >= 400) return { outcome: 'http_error', code: status };
  if (cut) return { outcome: 'unread', code: 0 };
  return { outcome: 'no_response', code: 0 };
}

/**
 * Reads a Server-Sent Events body until every id in `waiting` has an answer,
 * then stops. Keep-alive comments, progress and log notifications are passed
 * over. Returns the answers found and the time the last one arrived.
 */
export async function readStream(body, waiting, now = Date.now) {
  const found = new Map();
  let doneAt = null;
  let cut = false;
  if (!body) return { found, doneAt, cut };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  const take = block => {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    responsesById(messages(data), found);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_STREAM) {
        cut = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      blocks.forEach(take);
      if ([...waiting].every(k => found.has(k))) {
        doneAt = now();
        break;
      }
    }
    if (buffer) take(buffer);
  } finally {
    reader.cancel().catch(() => {});
  }
  return { found, doneAt: doneAt ?? now(), cut };
}
