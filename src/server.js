// Model Context Protocol server over JSON-RPC 2.0, written without
// dependencies. It implements what a tools-only server needs: initialize,
// ping, tools/list and tools/call. Messages are one JSON object per line on
// stdin and stdout (the MCP stdio transport); logs go to stderr only.

import { callTool, listTools } from './tools.js';

export const SERVER_INFO = { name: 'zentria-flow-mcp', title: 'Zentria Flow', version: '0.3.1' };
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const INSTRUCTIONS =
  'US tariff and landed-cost data from the Zentria Flow engine (zentriaflow.com). Use hts_search to find a ' +
  'tariff line, us_tariff_check for the duty layers of one origin, compare_origins for several origins. ' +
  'Quote rates only from tool results, give the date they were checked, and say they are planning estimates, ' +
  'not customs rulings.';

const error = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * @param {{fetchImpl: typeof fetch, baseUrl: string, apiKey?: string, now?: () => Date, sleep?: (ms: number) => Promise<void>}} deps
 */
export function createServer(deps) {
  const ctx = {
    fetchImpl: deps.fetchImpl,
    baseUrl: deps.baseUrl,
    apiKey: deps.apiKey || '',
    now: deps.now || (() => new Date()),
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };

  /** One JSON-RPC message in, its response out (null for a notification). */
  async function handleOne(msg) {
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
      return error(msg && typeof msg === 'object' ? msg.id : null, -32600, 'Invalid Request');
    }
    const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
    if (typeof msg.method !== 'string') {
      // a response to something we never sent, or garbage: nothing to answer
      return isRequest && !('result' in msg) && !('error' in msg) ? error(msg.id, -32600, 'Invalid Request') : null;
    }
    if (!isRequest) return null; // notifications (notifications/initialized, notifications/cancelled, ...)
    if (typeof msg.id !== 'string' && typeof msg.id !== 'number') return error(null, -32600, 'Invalid Request');

    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
    switch (msg.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return ok(msg.id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(msg.id, {});
      case 'tools/list':
        return ok(msg.id, { tools: listTools() });
      case 'tools/call': {
        if (typeof params.name !== 'string') return error(msg.id, -32602, 'tools/call needs a tool name.');
        const args = params.arguments;
        if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
          return error(msg.id, -32602, 'arguments must be an object.');
        }
        const result = await callTool(params.name, args, ctx);
        if (result === null) return error(msg.id, -32602, `Unknown tool: ${params.name.slice(0, 80)}`);
        return ok(msg.id, result);
      }
      default:
        return error(msg.id, -32601, `Method not found: ${msg.method.slice(0, 80)}`);
    }
  }

  /** A parsed message or batch in; a response, a batch of responses, or null out. */
  async function handle(message) {
    if (Array.isArray(message)) {
      if (message.length === 0) return error(null, -32600, 'Invalid Request');
      const answers = (await Promise.all(message.map(handleOne))).filter((a) => a !== null);
      return answers.length ? answers : null;
    }
    return handleOne(message);
  }

  /** One line of stdin in; the line to write to stdout, or null. */
  async function handleLine(line) {
    const text = line.trim();
    if (!text) return null;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return JSON.stringify(error(null, -32700, 'Parse error'));
    }
    let answer;
    try {
      answer = await handle(message);
    } catch {
      answer = error(message && typeof message === 'object' && !Array.isArray(message) ? message.id : null, -32603, 'Internal error');
    }
    return answer === null ? null : JSON.stringify(answer);
  }

  return { handle, handleLine };
}
