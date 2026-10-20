# mcplytics

**Usage and health for a remote MCP server: which tools get called, by which apps (as each app names itself), how each call ended and how long it took. One wrapper, no SDK, no backend, and it never stores what people asked.**

You built an MCP server and put it online. AI apps now call it: Claude, Cursor, ChatGPT, scripts. mcplytics answers the plain questions about that traffic:

- Which tools are used, and which never are?
- Which apps call, and how often?
- How many calls fail, and do they fail because a tool broke or because the request was wrong?
- How fast is it? Median and slowest 5%.

It wraps the one function that answers your server's HTTP requests, so it works on any Streamable HTTP server written in JavaScript: built with the official MCP SDK, with another framework, or by hand. It runs on Cloudflare Workers and Pages, Deno, Bun and Node, and has zero dependencies.

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

### Deno, Bun, Node

```js
import { mcplytics } from 'mcplytics';
import { jsonl } from 'mcplytics/node';

Bun.serve({ fetch: mcplytics(handler, { sink: jsonl('mcplytics.jsonl') }) });
// Deno.serve(mcplytics(handler, { sink: jsonl('mcplytics.jsonl') }));
```

On Node, wrap whatever turns a web `Request` into a `Response` (Hono, the SDK's web-standard handler, your own).

### Read the report

```
npx mcplytics report mcplytics.jsonl --days 7
npx mcplytics report --cloudflare --account <account id> --days 7
```

`--cloudflare` reads Analytics Engine through Cloudflare's SQL API. Set `CLOUDFLARE_API_TOKEN` to a token with **Account Analytics: Read**. `--json` prints the numbers instead of tables.

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

**Never recorded:** tool arguments, tool results, resource URIs, `Mcp-Param-*` headers, `Authorization`, cookies, IP addresses. Names that come from callers are cut to a fixed length and stripped to printable ASCII.

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
| `crash` | your handler threw |

The report counts every outcome except `ok` and `input_required` as failed.

## Options

```js
mcplytics(handler, {
  sink,                       // analyticsEngine(), jsonl(path), memory(), callback(fn), or (env) => sink
  caller: (request, env) => request.headers.get('authorization') ? 'paid' : 'free',
  onError: e => console.warn('mcplytics', e),   // its own failures; ignored by default
});
```

Keep `caller` coarse, such as a plan tier. It's yours to decide, and whatever it returns is stored.

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
- **No intent.** It doesn't ask the model why it called a tool. Doing that means adding a field to every tool, and that's the line this tool doesn't cross.
- **Client names are what clients send.** `clientInfo` is a SHOULD in the spec, not a MUST, and any name can be claimed. The User-Agent fallback names the HTTP library more often than the app.
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
