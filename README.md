# mcplytics

**Usage, health and security for a remote MCP server: which tools get called, by which apps (as each app names itself, or as its verified OAuth client), how each call ended, how long it took, and the signs of an attack. One wrapper, no SDK, no backend, and it never stores what people asked. Plus a check that tells you what to fix.**

You built an MCP server and put it online. AI apps now call it: Claude, Cursor, ChatGPT, scripts. So do scanners, and sometimes people looking for a way in. mcplytics answers the plain questions about that traffic:

- Which tools are used, and which never are?
- Which apps call, and how often?
- How many calls fail, and do they fail because a tool broke or because the request was wrong?
- How fast is it? Median and slowest 5%.
- Is anyone probing it? Calls to tools you never listed, requests from other websites, credentials in URLs, and tool definitions that changed when you didn't deploy.

And `npx mcplytics check <url>` looks at your server from outside, the way a stranger would, and says what to fix ([below](#check-your-server)).

It wraps the one function that answers your server's HTTP requests, so it works on any Streamable HTTP server written in JavaScript: built with the official MCP SDK (web-standard or Express transport), with another framework, or by hand. It runs on Cloudflare Workers and Pages, Deno, Bun and Node, and has zero dependencies. A server in Python, Go or any other language can be watched through a [small proxy](#a-server-in-another-language).

```
mcplytics: 21 calls, 2026-10-20 19:05 to 2026-10-20 19:05 UTC
failed 4.8% · p50 1 ms · p95 4 ms

Tools
name                 calls  failed       p50       p95
search                  12      0%      2 ms     11 ms
get_item                 6      0%      1 ms      2 ms
delete_everything        1    100%      0 ms      0 ms
list_categories          1      0%      2 ms      2 ms

Apps calling (client name)
name            calls  failed       p50       p95
claude-code         9     11%      1 ms     11 ms
cursor              7      0%      1 ms      4 ms
openai-mcp          4      0%      1 ms      4 ms
python-httpx        1      0%      2 ms      2 ms
```

*(A test run. `delete_everything` doesn't exist; someone tried anyway.)*

## Use it

### Cloudflare Workers

```js
import { mcplytics, analyticsEngine } from 'mcplytics';

const handler = async (request, env, ctx) => { /* your MCP endpoint */ };

export default { fetch: mcplytics(handler, { sink: analyticsEngine() }) };
```

Bind an Analytics Engine dataset named `MCPLYTICS` in `wrangler.jsonc`:

```jsonc
"analytics_engine_datasets": [{ "binding": "MCPLYTICS", "dataset": "mcplytics" }]
```

### Cloudflare Pages Functions

```js
// functions/mcp.js
import { mcplytics, analyticsEngine } from 'mcplytics';

export const onRequestPost = mcplytics(yourPostHandler, { sink: analyticsEngine() });
```

Add the binding under **Settings → Bindings → Analytics engine** (variable `MCPLYTICS`, dataset `mcplytics`), then redeploy. Pages can't use the binding in local dev; there the wrapper writes nothing and your server works as before.

### Deno, Bun

```js
import { mcplytics } from 'mcplytics';
import { jsonl } from 'mcplytics/node';

Bun.serve({ fetch: mcplytics(handler, { sink: jsonl('mcplytics.jsonl') }) });
// Deno.serve(mcplytics(handler, { sink: jsonl('mcplytics.jsonl') }));
```

### Node with Express (the official SDK's `StreamableHTTPServerTransport`)

That transport takes Node's `(req, res)`, so mcplytics comes in as middleware. Put it after `express.json()`:

```js
import express from 'express';
import { mcplyticsNode, jsonl } from 'mcplytics/node';

const app = express();
app.use(express.json());
app.use('/mcp', mcplyticsNode({ sink: jsonl('mcplytics.jsonl') }));
app.post('/mcp', (req, res) => transport.handleRequest(req, res, req.body));   // as before
```

It copies what your answer writes as it goes out, and records the call once the answer has finished. Tested with SDK 1.32.1, JSON and event-stream answers. Hooks get Node's `req` as their third argument, so with the SDK's `requireBearerAuth` the verified client is `oauth: { clientId: (_, __, req) => req.auth?.clientId }`.

### Node with a web-standard handler

For Hono, the SDK's `WebStandardStreamableHTTPServerTransport` (tested with 1.32.1), or your own `Request → Response` function, `serve()` runs it on plain `node:http`:

```js
import http from 'node:http';
import { mcplytics } from 'mcplytics';
import { serve, jsonl } from 'mcplytics/node';

http.createServer(serve(mcplytics(handler, { sink: jsonl('mcplytics.jsonl') }))).listen(3000);
```

### A server in another language

Run a small front door that forwards every request to your server unchanged, and wrap that:

```js
import { mcplytics, proxy, analyticsEngine } from 'mcplytics';

export default { fetch: mcplytics(proxy('https://python-backend.example.com/mcp'), { sink: analyticsEngine() }) };
```

On Node, `http.createServer(serve(mcplytics(proxy('http://127.0.0.1:8000/mcp'), { sink: jsonl() })))`. Requests and answers pass through unchanged, except that `Host` is set for the backend and compression is turned off between the two, so the answer can be read and passed on as it came.

### Read the report

```
npx mcplytics report mcplytics.jsonl --days 7
npx mcplytics report --cloudflare --account <account id> --days 7
```

`--cloudflare` reads Analytics Engine through Cloudflare's SQL API. Set `CLOUDFLARE_API_TOKEN` to a token with **Account Analytics: Read**. `--json` prints the numbers instead of tables.

## Check your server

```
npx mcplytics check https://your.server/mcp
npx mcplytics check https://your.server/mcp --header "Authorization: Bearer <token>"
```

It sends about a dozen small requests, the kind a stranger or a scanner would send, and prints what to fix. It never calls one of your tools: the only `tools/call` it sends names a tool that doesn't exist. Headers you pass go to that server only and are never printed. It exits 1 when something needs fixing, so it can run in CI.

What it looks at:

| Check | Passes when |
|---|---|
| HTTPS | the address is `https://` (plain HTTP is fine on your own machine) |
| Sign-in | without a token: 401 with `WWW-Authenticate: Bearer resource_metadata=…`, protected-resource metadata at `/.well-known/oauth-protected-resource`, and a made-up token refused with 401 |
| Origin | a request with another website's `Origin` gets 403, as the spec requires. This is what stops DNS rebinding |
| Protocol version | an unknown `MCP-Protocol-Version` gets 400 |
| Errors | malformed JSON, an unknown method and an unknown tool get answers without stack traces or file paths |
| Sessions (before 2026-07-28) | session IDs look random, and a made-up one gets 404 |
| Old transport | the 2024-11-05 HTTP+SSE endpoint no longer answers |
| CORS | another website can't call it with the visitor's cookies |
| Tool definitions | no invisible characters (zero-width, bidirectional, Unicode tags, terminal escapes), no text that reads like orders to the model, unique names, annotations present and not claiming "read-only" on a tool named `delete_…` or `submit_…` |
| Open servers | tools an anonymous caller can reach are marked read-only, or need sign-in |

It also prints the fingerprint of your tool list, the same value mcplytics records on every `tools/list`, so you can tell which version of your tools is live.

A server built with the official SDK on Express (1.32.1) with no extra settings got two findings: it answers requests from any website (no Origin check), and Express shows stack traces in error answers unless `NODE_ENV=production`.

## What it records

One event per call, with these fields and no others:

| Field | Example | From |
|---|---|---|
| `method` | `tools/call` | the request |
| `name` | `search` | tool or prompt name (`Mcp-Name` header, or the body) |
| `client`, `clientVersion` | `claude-code`, `2.1.3` | `_meta` clientInfo, else `initialize`, else the User-Agent |
| `clientSource` | `meta` | which of those it was |
| `protocol` | `2026-07-28` | `MCP-Protocol-Version` |
| `outcome`, `code` | `protocol_error`, `-32602` | the answer |
| `status`, `ms`, `stream` | `200`, `41`, `false` | the answer |
| `caller` | `free` | your own label, if you set `options.caller` |
| `app` | `app.example.com` | the OAuth client your server verified, if you set `options.oauth` ([below](#oauth-clients)) |
| `flags` | `unknown_tool` | security signals the call raised ([below](#security-signals)) |
| `toolsHash` | `9c650467604dfdbf` | on `tools/list`: a fingerprint of the tool definitions shown |

**Never recorded:** tool arguments, tool results, resource URIs, error messages and `error.data`, the text of a failed tool's result, tool descriptions, `Mcp-Param-*` headers, `Authorization`, the URL's query string, the `Origin` value, raw OAuth client IDs, cookies, IP addresses. A failed call keeps only its outcome and numeric code, because error text can quote an argument or part of a document. Names that come from callers are cut to a fixed length and stripped to printable ASCII.

**Your tools are never changed.** mcplytics adds no fields to tool schemas and no text to results. It reads copies of the request and the answer and hands your server's own answer back.

## How a call can end

| Outcome | Meaning |
|---|---|
| `ok` | a result |
| `tool_error` | a result with `isError: true`: the tool ran and failed. The HTTP status is still 200, so only code that reads the body can see it |
| `input_required` | the server asked the client for more input (multi round-trip requests, 2026-07-28); the client retries as a new call, so the report counts these on their own line |
| `protocol_error` | a JSON-RPC error: unknown tool, bad arguments, header mismatch |
| `http_error` | refused before any JSON-RPC answer, e.g. 401 sign-in required |
| `no_response` | a 2xx stream that closed before answering |
| `unread` | a stream longer than 8 MB: mcplytics stopped reading before the answer, so it doesn't know how the call ended. Your client still gets every byte |
| `crash` | your handler threw |

The report counts every outcome except `ok`, `input_required` and `unread` as failed. A `protocol_error` with code `-32601` (method not found) is counted apart, by method: the caller asked for something your server doesn't have, often a scanner checking which protocol version it speaks. It says nothing about your server's health.

## Security signals

Each event carries the signals it raised, as short codes. Never what was in the request: what kind of thing happened.

| Flag | Raised when | Why it matters |
|---|---|---|
| `unknown_tool` | a `tools/call` names a tool your server has never listed | scanners and people guessing at tools you might have (`delete_everything`, `exec`) |
| `foreign_origin` | a browser on another website sent the request | DNS rebinding and cross-site calls look like this. List your own web apps in `options.origins` |
| `token_in_url` | a credential sits in the query string (`?access_token=…`) | the spec forbids it: URLs end up in logs, history and analytics |
| `insufficient_scope` | a 403 says the token lacks a permission | a client reaching for more than it was granted |
| `oversize` | the request body is over 256 KB | a cheap way to tie up a server |
| `unparseable` | the request body isn't JSON | probing, or a broken client |
| `hidden_text` | your `tools/list` answer contains invisible characters | how tool poisoning hides instructions a person reviewing the tool can't see |
| `tools_changed` | a whole `tools/list` answer differs from the last one seen | a deploy you know about, or tool definitions changed by someone else (a "rug pull") |

`mcplytics report` adds a **Security signals** section with each flag, the apps that raised it, sign-ins refused (401/403) by app, and every version of your tool list with when it was first and last seen. Sign-in refusals come from `status`, so they need no flag.

`unknown_tool` and `tools_changed` compare against the tools this process or isolate has seen listed, so they start working after the first `tools/list` and are best effort across many isolates.

## Options

```js
mcplytics(handler, {
  sink,                       // analyticsEngine(), jsonl(path), memory(), callback(fn), or (env) => sink
  caller: (request, env) => request.headers.get('authorization') ? 'paid' : 'free',
  origins: ['https://app.example.com'],   // browser origins you expect; others are flagged foreign_origin
  onError: e => console.warn('mcplytics', e),   // its own failures; ignored by default
});
```

Keep `caller` coarse, such as a plan tier. It's yours to decide, and whatever it returns is stored.

### OAuth clients

Any app can call itself anything in `clientInfo`. If your server uses OAuth, the client ID on the token it accepted is a better tell. Hand mcplytics that ID, and it records which app is behind it:

```js
const verified = new WeakMap();   // request → the client_id your auth step accepted

async function handler(request, env) {
  const token = await checkToken(request);   // your own auth
  if (!token) return new Response('Sign in', { status: 401 });
  verified.set(request, token.client_id);
  // ... answer the MCP request
}

mcplytics(handler, {
  sink,
  oauth: {
    clientId: request => verified.get(request),   // asked after your handler runs
    registered: { 'k3x9-prod': 'acme-desktop' },  // IDs you issued yourself, and their names
  },
});
```

The spec gives a client three ways to get an ID, and they tell you different amounts:

| The client ID is | `app` records | Why |
|---|---|---|
| an HTTPS URL (Client ID Metadata Document) | its host, e.g. `app.example.com` | the authorization server fetched that document and checked the app's redirect addresses against it, so the host is the app's own domain |
| an ID you issued, listed in `registered` | your name for it | you know who you gave it to |
| anything else, usually from dynamic registration | `(unlisted)` | the client registered itself and chose its own name, so the ID names one installation, not an app |

The ID itself is never stored. Only what it is checked against is.

## How it works

- Only `POST` requests carry MCP messages. `GET`, `OPTIONS` and `DELETE` pass straight through.
- Before your handler runs, mcplytics clones the request, so your handler reads the body as usual.
- **JSON answers:** your response goes back as is, and a clone is read afterwards.
- **Event-stream answers:** the stream is split in two. The client gets one branch at full speed; mcplytics reads the other until the final answer, so `ms` covers the whole call, not just the first byte.
- Events are written after the answer has left, through `waitUntil` where the runtime has it.
- Every step is guarded. If parsing fails or the sink throws, your server answers exactly as it would without mcplytics.
- **Older protocol versions (before 2026-07-28):** batches give one event per call, and the client name sent in `initialize` is remembered for that session's later calls (up to 1,000 sessions per isolate, best effort).

## Limits

- **Remote servers only.** A local server talks to its app over stdio, with no HTTP request to wrap.
- **It watches; it doesn't block.** mcplytics never changes or delays an answer, so a signal tells you something happened, not that it was stopped. Blocking belongs in your server or a gateway. `check` tells you which of those protections are missing.
- **`check` sees what a stranger sees.** It can't read your code, so it can't tell whether a tool validates its inputs or whether a token's audience is checked inside your auth library. Passing it is a baseline, not a guarantee.
- **No intent.** It doesn't ask the model why it called a tool. Doing that means adding a field to every tool, and that's the line this tool doesn't cross.
- **Client names are what clients send.** `clientInfo` is a SHOULD in the spec, not a MUST, and any name can be claimed. The User-Agent fallback names the HTTP library more often than the app. With OAuth, [`options.oauth`](#oauth-clients) gives a name the authorization server has checked.
- **Cloudflare's clock.** In Workers, `Date.now()` moves only when your code waits on I/O, so `ms` counts time spent waiting (storage, fetches, the stream) and not pure computation.
- **Sampling.** At high volume Analytics Engine keeps a sample. The report weights each row by `_sample_interval`. The Cloudflare reader reads the latest 10,000 rows for the period.

## When to use something else

- **Session replay, intent clustering or a hosted dashboard**, and you're fine with tool-schema changes and a vendor backend: look at the analytics SDKs that hook the official MCP SDK (PostHog, AgentCat and others).
- **An OpenTelemetry collector already running**: instrument with the OpenTelemetry MCP semantic conventions.
- **Many servers behind one gateway**: some MCP gateways count calls per tool from the `Mcp-Method`/`Mcp-Name` headers. That gives counts but not tool errors or client names, which are in the body.

## Develop

```
npm test
```

Zero dependencies. Node 20+ for the tests and the report.

## License

MIT
