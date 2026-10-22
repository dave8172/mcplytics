// mcplytics check: look at your own remote MCP server from outside, the way
// a stranger would, and say what to fix.
//
// About a dozen small requests. It never calls one of your tools: the only
// tools/call it sends names a tool that doesn't exist. Credentials you pass
// with --header are sent to that server only and never printed.
import { INVISIBLE, strings, fingerprint } from './parse.js';

const NEW = '2026-07-28';
const OLD = '2025-06-18';
const FOREIGN = 'https://mcplytics-check.invalid';
const AGENT = 'mcplytics-check';
const TIMEOUT = 10000;

const TRACE = [
  /\n\s+at\s+\S.*\(?\S+:\d+:\d+\)?/,         // JavaScript stack frame
  /node_modules\//,
  /Traceback \(most recent call last\)/,      // Python
  /File "[^"]+", line \d+/,
  /goroutine \d+ \[/,                          // Go
  /\bat [\w$.]+\([\w]+\.java:\d+\)/,           // Java
];

const INSTRUCTION = [
  /<\s*\/?\s*(important|system|instructions?|secret)\s*>/i,
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|messages|rules)/i,
  /do not (tell|mention|inform|show) (this to )?the user/i,
  /(read|send|upload|include)\b.{0,60}(\.ssh|id_rsa|\.env\b|credentials|private key|api[_ ]?keys?)/i,
];

// Names that promise a change. Destroying words must not be marked
// non-destructive; writing words must not be marked read-only.
const DESTROYS = /(^|[_.-])(delete|remove|drop|destroy|wipe|purge|truncate|kill|exec|execute|shell|run_command|transfer|pay|refund|deploy|cancel|overwrite)([_.-]|$)/i;
const WRITES = /(^|[_.-])(create|submit|upload|insert|update|write|send|set|post|add|edit|save|move|rename)([_.-]|$)/i;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

const isLocal = host => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(host);

/** One JSON-RPC answer from a JSON body or an event stream; null if none. */
function answerIn(text, type, id) {
  if (!text) return null;
  const pick = list => list.find(m => m && (id === undefined || m.id === id || m.id === null) && ('result' in m || 'error' in m)) || null;
  try {
    if (type.includes('text/event-stream')) {
      const found = text.split(/\r?\n\r?\n/).map(block => block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'))
        .filter(Boolean).map(d => { try { return JSON.parse(d); } catch { return null; } });
      return pick(found);
    }
    const body = JSON.parse(text);
    return pick(Array.isArray(body) ? body : [body]);
  } catch {
    return null;
  }
}

/** Reads at most `max` bytes of a body, then lets it go. */
async function readSome(response, max = 512 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > max) break;
      // An event stream that has answered is done for our purposes.
      if (/\n\n/.test(text) && /"(result|error)"/.test(text) && (response.headers.get('content-type') || '').includes('event-stream')) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

export async function check(target, { headers: given = {}, fetchImpl = fetch } = {}) {
  const url = new URL(target);
  const findings = [];
  const add = (level, id, title, detail = '', fix = '') => findings.push({ level, id, title, detail, fix });
  let requests = 0;
  let tools = null;
  let hash = '';

  async function send(method, params = {}, { auth = true, version, origin, session, body, raw, id = ++requests, verb = 'POST', accept } = {}) {
    const headers = { 'user-agent': `${AGENT}`, accept: accept || 'application/json, text/event-stream' };
    if (verb === 'POST') headers['content-type'] = 'application/json';
    if (auth) Object.assign(headers, given);
    if (version) headers['mcp-protocol-version'] = version;
    if (version === NEW && method) {
      headers['mcp-method'] = method;
      if (method === 'tools/call') headers['mcp-name'] = params.name;
    }
    if (origin) headers.origin = origin;
    if (session) headers['mcp-session-id'] = session;
    const meta = version === NEW ? { _meta: { 'io.modelcontextprotocol/protocolVersion': NEW, 'io.modelcontextprotocol/clientInfo': { name: AGENT, version: '1' } } } : {};
    const init = { method: verb, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) };
    if (verb === 'POST') init.body = raw !== undefined ? raw : JSON.stringify(body || { jsonrpc: '2.0', id, method, params: { ...params, ...meta } });
    const response = await fetchImpl(url, init);
    const type = response.headers.get('content-type') || '';
    const text = await readSome(response);
    return { status: response.status, headers: response.headers, type, text, message: answerIn(text, type, raw !== undefined ? undefined : id) };
  }

  // 1. HTTPS.
  if (url.protocol === 'https:') add('pass', 'https', 'Served over HTTPS');
  else if (isLocal(url.hostname)) add('info', 'https', 'Plain HTTP on this machine', 'Fine while developing. A public address must use HTTPS.');
  else add('fail', 'https', 'Served over plain HTTP', 'Tokens and tool data cross the internet readable by anyone on the path.', 'Serve the endpoint over HTTPS only.');

  // 2. Which protocol it speaks, with your credentials if you gave any.
  let version = null;
  let session = null;
  let first = await send('server/discover', {}, { version: NEW });
  if (first.message && first.message.result) version = NEW;
  else if (first.status !== 401 && first.status !== 403) {
    const init = await send('initialize', { protocolVersion: OLD, capabilities: {}, clientInfo: { name: AGENT, version: '1' } }, { version: OLD });
    first = init;
    if (init.message && init.message.result) {
      version = OLD;
      session = init.headers.get('mcp-session-id');
      await send(null, {}, { version: OLD, session, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }).catch(() => {});
    }
  }
  const opts = { version: version || OLD, session };
  const signedIn = Object.keys(given).length > 0;

  // 3. Sign-in.
  const bare = await send(version === NEW ? 'server/discover' : 'initialize',
    version === NEW ? {} : { protocolVersion: OLD, capabilities: {}, clientInfo: { name: AGENT, version: '1' } },
    { auth: false, version: version || OLD });
  const needsAuth = bare.status === 401;
  if (needsAuth) {
    add('pass', 'auth', 'Asks callers to sign in', 'A request without a token got 401.');
    const challenge = bare.headers.get('www-authenticate') || '';
    const pointer = /resource_metadata="?([^",\s]+)"?/i.exec(challenge);
    if (pointer) add('pass', 'auth-pointer', 'The 401 points to the sign-in details (resource_metadata)');
    else add('fail', 'auth-pointer', 'The 401 doesn\'t say where to sign in', `WWW-Authenticate: ${challenge.slice(0, 120) || '(missing)'}`,
      'Answer 401 with `WWW-Authenticate: Bearer resource_metadata="https://<your host>/.well-known/oauth-protected-resource"`. MCP clients find your sign-in server through it.');
    const metaUrls = [pointer && pointer[1], new URL(`/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, '')}`, url).href, new URL('/.well-known/oauth-protected-resource', url).href].filter(Boolean);
    let metadata = null;
    for (const m of metaUrls) {
      try {
        const r = await fetchImpl(m, { headers: { accept: 'application/json', 'user-agent': AGENT }, signal: AbortSignal.timeout(TIMEOUT) });
        requests++;
        if (r.ok) { metadata = await r.json(); break; }
      } catch {}
    }
    if (metadata && Array.isArray(metadata.authorization_servers) && metadata.authorization_servers.length) {
      add('pass', 'auth-metadata', 'Publishes protected-resource metadata', `Sign-in server: ${String(metadata.authorization_servers[0]).slice(0, 100)}`);
    } else {
      add('fail', 'auth-metadata', 'No protected-resource metadata found', 'Checked: ' + metaUrls.join(', '),
        'Serve /.well-known/oauth-protected-resource as JSON with `resource` and `authorization_servers` (RFC 9728). The MCP authorization spec requires it.');
    }
    const forged = await (async () => {
      const r = await fetchImpl(url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer mcplytics-check-not-a-real-token', 'user-agent': AGENT, 'mcp-protocol-version': version || OLD, ...(version === NEW ? { 'mcp-method': 'tools/list' } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 900, method: 'tools/list', params: {} }),
      });
      requests++;
      await readSome(r, 4096);
      return r.status;
    })();
    if (forged === 401) add('pass', 'auth-forged', 'Refuses a made-up token (401)');
    else if (forged >= 200 && forged < 300) add('fail', 'auth-forged', 'Accepted a made-up token', `\`Bearer mcplytics-check-not-a-real-token\` got ${forged}.`,
      'Validate every token: signature or introspection, expiry, and that it was issued for this server (audience). Invalid tokens must get 401.');
    else add('warn', 'auth-forged', `A made-up token got ${forged}, not 401`, '', 'The spec says invalid or expired tokens must receive 401, so clients know to sign in again.');
  } else if (bare.message && bare.message.result) {
    add('info', 'auth', 'Open: anyone can connect without signing in', 'Fine for public, read-only tools. See the tool findings below for what an anonymous caller can reach.');
  }

  if (!version) {
    if (needsAuth && !signedIn) add('info', 'scope', 'Only the sign-in checks could run', '', 'Run again with --header "Authorization: Bearer <token>" to check the rest.');
    else add('fail', 'speaks', 'Didn\'t get an MCP answer', `server/discover and initialize got ${first.status} ${first.text.slice(0, 120).replace(/\s+/g, ' ')}`, 'Check the URL points at the MCP endpoint itself (often /mcp).');
    return finish();
  }

  // 4. Origin: DNS rebinding.
  const fromSite = await send(version === NEW ? 'server/discover' : 'tools/list', {}, { ...opts, origin: FOREIGN });
  if (fromSite.status === 403) add('pass', 'origin', 'Refuses requests from other websites (Origin → 403)');
  else if (fromSite.status >= 200 && fromSite.status < 300) add(isLocal(url.hostname) ? 'fail' : 'warn', 'origin', 'Answers requests from any website', `A request with \`Origin: ${FOREIGN}\` got ${fromSite.status}.`,
    'The spec says servers MUST validate Origin and answer 403 when it\'s present and not one you expect. Allow your own web origins only. This is what stops DNS rebinding.');
  else add('info', 'origin', `A foreign Origin got ${fromSite.status}`);

  // 5. Protocol version.
  const odd = await send('tools/list', {}, { ...opts, version: '1999-01-01' });
  if (odd.status === 400) add('pass', 'version', 'Refuses an unknown protocol version (400)');
  else add('warn', 'version', `An unknown protocol version got ${odd.status}, not 400`, '', 'Answer 400 to an MCP-Protocol-Version you don\'t support, so clients can fall back instead of misreading answers.');

  // 6. Errors that say too much.
  const leaks = [];
  const broken = await send(null, {}, { ...opts, raw: '{"jsonrpc": "2.0", "id": 7, "method": ' });
  const nothing = await send('mcplytics/no-such-method', {}, opts);
  const noTool = await send('tools/call', { name: 'mcplytics_check_no_such_tool', arguments: {} }, opts);
  for (const [what, r] of [['malformed JSON', broken], ['an unknown method', nothing], ['an unknown tool', noTool]]) {
    if (TRACE.some(t => t.test(r.text))) leaks.push(what);
  }
  if (leaks.length) add('fail', 'errors', 'Error answers show internals', `Stack traces or file paths in the answer to ${leaks.join(', ')}.`,
    'Return a short message and a JSON-RPC code; keep the trace in your own logs. Traces map your code and dependencies for an attacker. Express shows them unless NODE_ENV=production or you add your own error handler.');
  else add('pass', 'errors', 'Error answers don\'t show stack traces');
  if (broken.status >= 500) add('warn', 'errors-500', `Malformed JSON crashed the handler (${broken.status})`, '', 'Answer 400 with JSON-RPC error -32700 (parse error).');

  // 7. Sessions (protocol versions before 2026-07-28).
  if (session) {
    const weak = session.length < 16 || /^\d+$/.test(session);
    if (weak) add('fail', 'session', 'Session IDs look guessable', `Got a ${session.length}-character ID${/^\d+$/.test(session) ? ' made of digits only' : ''}.`, 'Use a random UUID or 128 bits from a secure random generator, and never treat a session ID as proof of who is calling.');
    else add('pass', 'session', 'Session IDs look random');
    const ghost = await send('tools/list', {}, { ...opts, session: 'mcplytics-check-unknown-session' });
    if (ghost.status === 404) add('pass', 'session-unknown', 'Refuses an unknown session ID (404)');
    else if (ghost.status >= 200 && ghost.status < 300) add('warn', 'session-unknown', 'Accepts a made-up session ID', `Got ${ghost.status}.`, 'Answer 404 to a session ID you didn\'t issue, so a guessed or expired one can\'t be used.');
  }

  // 8. The old HTTP+SSE transport.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const get = await fetchImpl(url, { headers: { accept: 'text/event-stream', 'user-agent': AGENT, ...given }, signal: controller.signal });
    requests++;
    let head = '';
    if ((get.headers.get('content-type') || '').includes('event-stream') && get.body) {
      const reader = get.body.getReader();
      const read = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null }), 2500))]);
      if (read && read.value) head = new TextDecoder().decode(read.value);
      reader.cancel().catch(() => {});
    } else await get.body?.cancel().catch(() => {});
    clearTimeout(timer);
    if (/event:\s*endpoint/.test(head)) add('warn', 'legacy-sse', 'The old HTTP+SSE transport still answers', 'A GET returned an `endpoint` event.', 'Retire the 2024-11-05 HTTP+SSE endpoint once your clients use Streamable HTTP; it is one more door to secure.');
  } catch {}

  // 9. CORS.
  try {
    const pre = await fetchImpl(url, { method: 'OPTIONS', headers: { origin: FOREIGN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type', 'user-agent': AGENT }, signal: AbortSignal.timeout(TIMEOUT) });
    requests++;
    await pre.body?.cancel().catch(() => {});
    const allow = pre.headers.get('access-control-allow-origin');
    const creds = (pre.headers.get('access-control-allow-credentials') || '').toLowerCase() === 'true';
    if (allow === FOREIGN && creds) add('fail', 'cors', 'Any website may call it with the visitor\'s cookies', 'CORS echoes any Origin and allows credentials.', 'Allow only your own origins, or drop Access-Control-Allow-Credentials.');
    else if (allow === FOREIGN) add('warn', 'cors', 'CORS allows any website by echoing its Origin', '', 'List the origins you expect instead of echoing the request\'s.');
    else if (allow === '*') add('info', 'cors', 'CORS allows any website (*)', 'Without cookies that is usually fine when every call needs a token.');
  } catch {}

  // 10. The tools a model is shown.
  const listed = await send('tools/list', {}, opts);
  tools = listed.message && listed.message.result && Array.isArray(listed.message.result.tools) ? listed.message.result.tools : null;
  if (tools) {
    hash = await fingerprint(tools).catch(() => '');
    const names = tools.map(t => t && t.name);
    const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    if (dupes.length) add('fail', 'tools-duplicate', 'Two tools share a name', dupes.join(', '), 'Give every tool a unique name; a client can\'t tell which one it is calling.');
    const badNames = names.filter(n => typeof n !== 'string' || !TOOL_NAME.test(n));
    if (badNames.length) add('warn', 'tools-names', 'Tool names outside the spec\'s rule', badNames.slice(0, 5).map(String).join(', '), 'Use 1–128 characters from A–Z, a–z, 0–9, _ - and . only.');
    const hidden = tools.filter(t => strings(t).some(s => INVISIBLE.test(s))).map(t => t.name);
    if (hidden.length) add('fail', 'tools-hidden', 'Invisible characters in tool definitions', `In: ${hidden.slice(0, 5).join(', ')}.`,
      'Remove zero-width, bidirectional, tag and escape characters. A model reads them; a person reviewing the tool can\'t. This is how tool poisoning hides instructions.');
    else add('pass', 'tools-hidden', 'No invisible characters in tool definitions');
    const bossy = tools.filter(t => strings([t.description, t.title, t.inputSchema]).some(s => INSTRUCTION.some(r => r.test(s)))).map(t => t.name);
    if (bossy.length) add('warn', 'tools-instructions', 'Tool text reads like orders to the model', `In: ${bossy.slice(0, 5).join(', ')}.`,
      'Describe what the tool does. Text like "ignore previous instructions" or "don\'t tell the user" is what poisoned tools look like, even when yours is innocent.');
    const bare = tools.filter(t => !t.annotations || typeof t.annotations !== 'object').map(t => t.name);
    if (bare.length) add('warn', 'tools-annotations', `${bare.length} of ${tools.length} tools ${bare.length === 1 ? 'has' : 'have'} no annotations`, `${bare.slice(0, 6).join(', ')}${bare.length > 6 ? ', …' : ''}.`,
      'Without annotations, clients must assume a tool is destructive and reaches the outside world. Mark read-only tools `readOnlyHint: true`, and set `destructiveHint` honestly on the rest.');
    const claimsSafe = tools.filter(t => t.annotations && (
      (DESTROYS.test(String(t.name)) && (t.annotations.readOnlyHint === true || t.annotations.destructiveHint === false))
      || (WRITES.test(String(t.name)) && t.annotations.readOnlyHint === true))).map(t => t.name);
    if (claimsSafe.length) add('warn', 'tools-claims', 'Tools named for changes are marked as not changing anything', claimsSafe.slice(0, 5).join(', '), 'Check readOnlyHint and destructiveHint on these. Clients use them to decide when to ask the user first.');
    const writers = tools.filter(t => !t.annotations || t.annotations.readOnlyHint !== true).map(t => t.name);
    if (!needsAuth && writers.length) add('warn', 'open-writes', 'Anyone can call tools that aren\'t marked read-only', `No sign-in needed for: ${writers.slice(0, 6).join(', ')}${writers.length > 6 ? ', …' : ''}.`, 'If these change anything, require sign-in or limit what an anonymous caller can do. If they only read, mark them readOnlyHint: true.');
  } else if (listed.message && listed.message.error) {
    add('info', 'tools', 'tools/list returned an error', String(listed.message.error.code));
  }

  return finish();

  function finish() {
    const order = { fail: 0, warn: 1, pass: 2, info: 3 };
    findings.sort((a, b) => order[a.level] - order[b.level]);
    return { url: url.href, protocol: version || '', tools: tools ? tools.length : null, toolsHash: hash, requests, findings };
  }
}

/** The result as plain text for a terminal. */
export function formatCheck(r) {
  const mark = { fail: 'FAIL', warn: 'WARN', pass: ' ok ', info: 'info' };
  const head = [`mcplytics check ${r.url}`];
  const facts = [r.protocol && `protocol ${r.protocol}`, r.tools !== null && `${r.tools} tools`, r.toolsHash && `tools fingerprint ${r.toolsHash}`, `${r.requests} requests`].filter(Boolean);
  head.push(facts.join(' · '), '');
  const body = r.findings.flatMap(f => [
    `${mark[f.level]}  ${f.title}`,
    ...(f.detail ? [`      ${f.detail}`] : []),
    ...(f.fix ? [`      Fix: ${f.fix}`] : []),
  ]);
  const count = l => r.findings.filter(f => f.level === l).length;
  return [...head, ...body, '', `${count('fail')} to fix, ${count('warn')} to review, ${count('pass')} passed.`].join('\n');
}
