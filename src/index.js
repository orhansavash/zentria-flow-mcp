#!/usr/bin/env node
// zentria-flow-mcp: MCP server (stdio) for the Zentria Flow tariff engine.
//
// Environment:
//   ZENTRIA_API_KEY   optional; only the landed_cost tool needs it. Never logged.
//   ZENTRIA_API_BASE  optional; default https://zentriaflow.com

import { createInterface } from 'node:readline';
import { resolveBaseUrl } from './api.js';
import { createServer, SERVER_INFO } from './server.js';

const HELP = `zentria-flow-mcp ${SERVER_INFO.version}
Model Context Protocol server for Zentria Flow (https://zentriaflow.com).
It speaks MCP over stdio: start it from an MCP client, not by hand.

Tools: us_tariff_check, compare_origins, hts_search, landed_cost

Environment:
  ZENTRIA_API_KEY   API key for the landed_cost tool (optional)
  ZENTRIA_API_BASE  API base URL (optional, default https://zentriaflow.com)

Results are planning estimates, not customs rulings.
`;

function main() {
  const arg = process.argv[2];
  if (arg === '--version' || arg === '-v') {
    process.stdout.write(`${SERVER_INFO.version}\n`);
    return;
  }
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (typeof fetch !== 'function') {
    process.stderr.write('zentria-flow-mcp needs Node.js 18 or newer.\n');
    process.exit(1);
  }

  let baseUrl;
  try {
    baseUrl = resolveBaseUrl(process.env.ZENTRIA_API_BASE);
  } catch (err) {
    process.stderr.write(`zentria-flow-mcp: ${err.message}\n`);
    process.exit(1);
  }
  const server = createServer({
    fetchImpl: (url, init) => fetch(url, init),
    baseUrl,
    apiKey: (process.env.ZENTRIA_API_KEY || '').trim(),
  });

  // One message per line. Calls run concurrently; when stdin closes, the
  // process ends by itself once the answers in flight are written.
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    server
      .handleLine(line)
      .then((out) => {
        if (out !== null) process.stdout.write(`${out}\n`);
      })
      .catch(() => {});
  });
  process.stderr.write(`zentria-flow-mcp ${SERVER_INFO.version} ready (stdio), API ${baseUrl}\n`);
}

main();
