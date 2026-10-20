/** One MCP call. These are all the fields mcplytics ever keeps. */
export interface McpEvent {
  /** When the request arrived, ISO 8601. */
  time: string;
  /** JSON-RPC method, e.g. "tools/call". */
  method: string;
  /** Tool or prompt name; "" for other methods. Resource URIs are never kept. */
  name: string;
  /** The calling app's name, e.g. "claude-code"; "" if it gave none. */
  client: string;
  clientVersion: string;
  /** Where the name came from: request _meta, initialize, an earlier session, or the User-Agent. */
  clientSource: 'meta' | 'initialize' | 'session' | 'user-agent' | '';
  /** MCP protocol version, e.g. "2026-07-28". */
  protocol: string;
  outcome: 'ok' | 'tool_error' | 'input_required' | 'protocol_error' | 'http_error' | 'no_response' | 'crash';
  /** JSON-RPC error code for protocol_error, HTTP status for http_error, else 0. */
  code: number;
  /** HTTP status of the answer. */
  status: number;
  /** Milliseconds from the request arriving to the answer (for a stream: its final message). */
  ms: number;
  /** True when the answer was a Server-Sent Events stream. */
  stream: boolean;
  /** Your own label from options.caller, e.g. a plan tier; "" if none. */
  caller: string;
}

export interface Sink {
  write(events: McpEvent[], env?: unknown): void | Promise<void>;
}

export interface Options<Env = any> {
  /** Where events go. A sink, or a function from the runtime's env to one. */
  sink?: Sink | ((env: Env) => Sink | undefined);
  /** A label of your own for the caller. Read headers only; keep it coarse. */
  caller?: (request: Request, env: Env) => string;
  /** mcplytics' own failures. The server's answer is never affected. Default: ignored. */
  onError?: (error: unknown) => void;
}

/**
 * Wraps the function that answers your MCP endpoint's HTTP requests.
 * Works with `(request, env?, ctx?) => Response` (Workers, Deno, Bun, Node)
 * and `(context) => Response` (Cloudflare Pages Functions).
 */
export function mcplytics<H extends (...args: any[]) => Response | Promise<Response>>(handler: H, options?: Options): H;

/** Workers Analytics Engine, through a dataset binding (default name MCPLYTICS). */
export function analyticsEngine(binding?: string): Sink;

/** Keeps events in memory. */
export function memory(): Sink & { events: McpEvent[] };

/** Calls `fn` once per event. */
export function callback(fn: (event: McpEvent) => void): Sink;

/** Appends JSON lines to a file (from "mcplytics/node"; Node, Bun, Deno). */
export function jsonl(path?: string): Sink;

export const FIELDS: (keyof McpEvent)[];
