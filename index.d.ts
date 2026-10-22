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
  outcome: 'ok' | 'tool_error' | 'input_required' | 'protocol_error' | 'http_error' | 'no_response' | 'unread' | 'crash';
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
  /**
   * The app behind the verified OAuth client (options.oauth): the host of a
   * Client ID Metadata Document URL, your name for an ID you issued,
   * "(unlisted)" for any other ID, "" with no OAuth client.
   */
  app: string;
  /** Security signals this call raised, comma-separated (see FLAGS); "" if none. */
  flags: string;
  /** For tools/list: a 16-hex-digit fingerprint of the tool definitions shown; else "". */
  toolsHash: string;
}

export type Flag = 'oversize' | 'unparseable' | 'foreign_origin' | 'unknown_tool'
  | 'insufficient_scope' | 'token_in_url' | 'hidden_text' | 'tools_changed';

/** Every security signal an event can carry in `flags`. */
export const FLAGS: Flag[];

export interface Sink {
  write(events: McpEvent[], env?: unknown): void | Promise<void>;
}

export interface Options<Env = any> {
  /** Where events go. A sink, or a function from the runtime's env to one. */
  sink?: Sink | ((env: Env) => Sink | undefined);
  /** A label of your own for the caller. Read headers only; keep it coarse. */
  caller?: (request: Request, env: Env) => string;
  /** The OAuth client your auth step verified. Asked after your handler runs. */
  oauth?: {
    /** The client_id of the token your server accepted for this request; undefined if none. */
    clientId: (request: Request, env: Env, ctx?: any) => string | undefined | null;
    /** IDs you issued yourself, mapped to the name to record. */
    registered?: Record<string, string>;
  };
  /** Browser origins you expect (e.g. your own web app); any other Origin is flagged foreign_origin. */
  origins?: string[];
  /** mcplytics' own failures. The server's answer is never affected. Default: ignored. */
  onError?: (error: unknown) => void;
}

/**
 * Wraps the function that answers your MCP endpoint's HTTP requests.
 * Works with `(request, env?, ctx?) => Response` (Workers, Deno, Bun, Node)
 * and `(context) => Response` (Cloudflare Pages Functions).
 */
export function mcplytics<H extends (...args: any[]) => Response | Promise<Response>>(handler: H, options?: Options): H;

/** The name mcplytics records for a verified OAuth client ID (see McpEvent.app). */
export function oauthApp(clientId: string | undefined | null, registered?: Record<string, string>): string;

/** Workers Analytics Engine, through a dataset binding (default name MCPLYTICS). */
export function analyticsEngine(binding?: string): Sink;

/** Keeps events in memory. */
export function memory(): Sink & { events: McpEvent[] };

/** Calls `fn` once per event. */
export function callback(fn: (event: McpEvent) => void): Sink;

/** A handler that forwards every request to another MCP server, e.g. one written in Python. */
export function proxy(target: string | URL): (request: Request) => Promise<Response>;

/** Appends JSON lines to a file (from "mcplytics/node"; Node, Bun, Deno). */
export function jsonl(path?: string): Sink;

/**
 * Express/Connect middleware for handlers that take Node's (req, res), such as the
 * SDK's StreamableHTTPServerTransport (from "mcplytics/node"). Put it after express.json().
 * Hooks receive (request, undefined, req): Node's req is the third argument.
 */
export function mcplyticsNode(options?: Options): (req: any, res: any, next: () => void) => void;

/** A node:http request listener that runs a web-standard (Request → Response) handler (from "mcplytics/node"). */
export function serve(handler: (request: Request) => Response | Promise<Response>): (req: any, res: any) => Promise<void>;

export interface Finding {
  level: 'fail' | 'warn' | 'pass' | 'info';
  id: string;
  title: string;
  detail: string;
  fix: string;
}

export interface CheckResult {
  url: string;
  protocol: string;
  tools: number | null;
  toolsHash: string;
  requests: number;
  findings: Finding[];
}

/** Checks your own remote MCP server from outside (from "mcplytics/check"). Never calls one of your tools. */
export function check(url: string, options?: { headers?: Record<string, string> }): Promise<CheckResult>;

/** A CheckResult as plain text (from "mcplytics/check"). */
export function formatCheck(result: CheckResult): string;

export const FIELDS: (keyof McpEvent)[];
