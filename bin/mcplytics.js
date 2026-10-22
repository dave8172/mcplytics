#!/usr/bin/env node
// mcplytics report: read the events back and print what they say.
// mcplytics check: look at your own server from outside and say what to fix.
//
//   mcplytics report calls.jsonl [--days 7] [--json]
//   mcplytics check https://your.server/mcp [--header "Authorization: Bearer …"] [--json]
//   mcplytics report --cloudflare --account <id> [--dataset mcplytics] [--days 7] [--json]
//
// --cloudflare reads Workers Analytics Engine through its SQL API. It needs
// an API token with Account Analytics: Read in CLOUDFLARE_API_TOKEN.
import { summarize, format } from '../src/report.js';
import { fromFile, fromCloudflare, LIMIT } from '../src/read.js';
import { check, formatCheck } from '../src/check.js';

const HELP = `mcplytics: usage, health and security for a remote MCP server

  mcplytics report <file.jsonl> [--days N] [--json]
  mcplytics report --cloudflare --account <account id> [--dataset mcplytics] [--days N] [--json]
  mcplytics check <https://your.server/mcp> [--header "Name: value"]... [--json]

--cloudflare reads Workers Analytics Engine. Set CLOUDFLARE_API_TOKEN to a
token with "Account Analytics: Read". --days defaults to 7.

check sends about a dozen small requests to a server you run and prints
what to fix. It never calls one of your tools. Pass --header to sign in;
headers go to that server only and are never printed. Exits 1 if anything
needs fixing, so it can run in CI.`;

function parseArgs(argv) {
  const out = { _: [], header: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--cloudflare' || a === '--help' || a === '-h') out[a.replace(/^-+/, '')] = true;
    else if (a === '--header') out.header.push(argv[++i] || '');
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, file] = args._;
  if (command === 'check' && file && !args.help) {
    const headers = {};
    for (const h of args.header) {
      const i = h.indexOf(':');
      if (i < 1) throw new Error(`--header "${h.slice(0, 20)}": use "Name: value"`);
      headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
    }
    const result = await check(file, { headers });
    console.log(args.json ? JSON.stringify(result, null, 2) : formatCheck(result));
    process.exit(result.findings.some(f => f.level === 'fail') ? 1 : 0);
  }
  if (args.help || command !== 'report' || (!file && !args.cloudflare)) {
    console.log(HELP);
    process.exit(command && !['report', 'check'].includes(command) && !args.help ? 1 : 0);
  }
  const days = Math.min(90, Math.max(1, parseInt(args.days || '7', 10) || 7));
  const rows = args.cloudflare ? await fromCloudflare(args, days) : await fromFile(file, days);
  const summary = summarize(rows);
  console.log(args.json ? JSON.stringify(summary, null, 2) : format(summary));
  if (args.cloudflare && rows.length >= LIMIT) console.log(`\n(only the latest ${LIMIT} rows were read)`);
}

main().catch(e => {
  console.error(`mcplytics: ${e.message}`);
  process.exit(1);
});
