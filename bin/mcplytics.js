#!/usr/bin/env node
// mcplytics report: read the events back and print what they say.
//
//   mcplytics report calls.jsonl [--days 7] [--json]
//   mcplytics report --cloudflare --account <id> [--dataset mcplytics] [--days 7] [--json]
//
// --cloudflare reads Workers Analytics Engine through its SQL API. It needs
// an API token with Account Analytics: Read in CLOUDFLARE_API_TOKEN.
import { summarize, format } from '../src/report.js';
import { fromFile, fromCloudflare, LIMIT } from '../src/read.js';

const HELP = `mcplytics: usage and health for a remote MCP server

  mcplytics report <file.jsonl> [--days N] [--json]
  mcplytics report --cloudflare --account <account id> [--dataset mcplytics] [--days N] [--json]

--cloudflare reads Workers Analytics Engine. Set CLOUDFLARE_API_TOKEN to a
token with "Account Analytics: Read". --days defaults to 7.`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--cloudflare' || a === '--help' || a === '-h') out[a.replace(/^-+/, '')] = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, file] = args._;
  if (args.help || command !== 'report' || (!file && !args.cloudflare)) {
    console.log(HELP);
    process.exit(command && command !== 'report' && !args.help ? 1 : 0);
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
