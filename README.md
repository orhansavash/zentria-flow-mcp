# zentria-flow-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Zentria Flow](https://zentriaflow.com), a landed-cost and US tariff engine for importers. It lets an AI assistant look up US import tariffs instead of answering from memory.

- Three tools work with no account and no API key.
- No dependencies: one small Node.js program that talks MCP over stdio.
- Every answer carries the date it was checked and the HTSUS revision it was read from.

Results are planning estimates, not customs rulings. Zentria Flow is software, not a customs broker.

## Tools

| Tool | What it does | Needs a key |
|---|---|---|
| `us_tariff_check` | Every US tariff layer for one HTS code from one origin: MFN duty, China Section 301, the forced-labor Section 301 tariff, Section 232 and Section 338 on Canada, the total, exemptions, USMCA and CAFTA-DR cases, and dated changes ahead. Optional `as_of` entry date (today to 12 months ahead). Optional `quantity` + `value` to price a specific or compound duty exactly. | No |
| `compare_origins` | The same check for 2 to 6 origins, lowest total first. One call per origin, 2 seconds apart. | No |
| `hts_search` | Finds 8-digit HTSUS lines by product words or the start of a code. | No |
| `landed_cost` | Full landed cost of a shipment: product value, freight, insurance, duty layers, VAT/GST and fees, for 70+ countries. | Yes: `ZENTRIA_API_KEY` |

Example (`us_tariff_check`, HTS 6109.10.00 from China, engine answer of 14 Nov 2026; rates change, so run it again for today's):

```
US tariff check: HTS 6109.10.00 from CN
Product line: T-shirts, singlets, tank tops and similar garments, knitted or crocheted — Of cotton
Entry date: 2026-11-14
Total duty rate: 36.5% of the customs value
Layers:
- MFN duty: 16.5%
- Section 301: 7.5% (List 4A, 9903.88.15)
- Forced-labor Section 301 tariff: 12.5% (applies, 12.5% flat)
- Section 232: 0%
- Section 338 (Canada): 0%
Source: HTSUS 2026 Revision 23 (USITC, in force 10 Nov 2026, checked 10 Nov 2026): ...
Checked on 2026-11-14 (UTC) with the Zentria Flow engine, zentriaflow.com.
Planning estimate, not a customs ruling. ...
```

Each result also has `structuredContent` with the same values as JSON (`total_rate_pct`, `layers`, `scheduled_changes`, `checked_on`, `source`).

## Requirements

Node.js 18 or newer. Nothing else to install.

## Install

All clients below start the server with the same command:

```
npx -y github:orhansavash/zentria-flow-mcp
```

npx fetches the server straight from this GitHub repository (no npm account or install step). To run it from a local copy instead, use `node /absolute/path/to/src/index.js` wherever a config below says `npx`, with no `-y github:…` arguments.

### Claude Desktop

Settings → Developer → Edit Config opens `claude_desktop_config.json`. Add:

```json
{
  "mcpServers": {
    "zentria-flow": {
      "command": "npx",
      "args": ["-y", "github:orhansavash/zentria-flow-mcp"]
    }
  }
}
```

Restart Claude Desktop. To use `landed_cost`, add `"env": { "ZENTRIA_API_KEY": "your key" }` next to `"args"`.

### Claude Code

```
claude mcp add zentria-flow -- npx -y github:orhansavash/zentria-flow-mcp
```

With a key: `claude mcp add zentria-flow --env ZENTRIA_API_KEY=your_key -- npx -y github:orhansavash/zentria-flow-mcp`

### Cursor

Create `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for every project, with the same `mcpServers` block as Claude Desktop.

### VS Code

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "zentria-flow": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:orhansavash/zentria-flow-mcp"]
    }
  }
}
```

### Docker

```
docker build -t zentria-flow-mcp .
docker run -i --rm zentria-flow-mcp
```

Add `-e ZENTRIA_API_KEY=your_key` to use `landed_cost`. MCP clients that start servers with Docker use `"command": "docker", "args": ["run", "-i", "--rm", "zentria-flow-mcp"]`.

### Local-model clients and other MCP clients

Any client that can start a stdio MCP server from a command works, including the ones that run local models (for example LM Studio, Jan, Continue, Cline and Open WebUI through an MCP-to-OpenAPI proxy). Use the `mcpServers` block above in the client's MCP configuration file. The model runs on your machine; the tool calls still go to zentriaflow.com over HTTPS, because the tariff data lives there.

Smaller local models follow tool results less reliably. Ask them to quote the tool's numbers and its "Checked on" line as they are.

## Configuration

| Variable | Meaning |
|---|---|
| `ZENTRIA_API_KEY` | Optional. An API key from https://zentriaflow.com/settings/api-keys, used only by `landed_cost`. It is sent only in the `X-API-Key` header of that request, and is never logged or written to a result. |
| `ZENTRIA_API_BASE` | Optional. Default `https://zentriaflow.com`. Must be https (or a local development host). |

The Sandbox API plan is free and allows 100 calls a month; plans and quotas are at https://zentriaflow.com/api-integration.

## Limits

- The three keyless tools use Zentria Flow's free public endpoints: 120 requests per 10 minutes per IP address. When the limit is reached the tool says so and returns no rate; it does not retry by itself.
- `landed_cost` counts against the quota of the API plan behind the key.
- Requests time out after 20 seconds.

## What the numbers are, and are not

- US rates are read from the HTSUS revision named in each result (`Source:`). An exact 8- or 10-digit line is priced from that line; a shorter code is an estimate and is labelled as one.
- Totals are percent of the customs value. Anti-dumping and countervailing duties are company-specific and are never in a total. Use-dependent duties are shown as notices.
- Scheduled changes can be extended, changed or withdrawn before their date.
- The server prints only values the API returned. A value that was not returned is shown as "not returned".
- A licensed customs broker should confirm classification and rates before entry.

## Privacy

The server sends the arguments of a tool call (HTS code, origin, optional date, quantity and value, or the search words) to zentriaflow.com. It sends nothing else from the conversation, keeps no files and has no telemetry. Zentria Flow's privacy policy: https://zentriaflow.com/privacy

## API

The same endpoints are documented as OpenAPI 3.1 at https://zentriaflow.com/openapi.json and on https://zentriaflow.com/developers.

## Development

```
npm test
```

The tests run with `node --test` and a stand-in for `fetch`; they make no network calls. `test/fixtures/engine-samples.json` holds real answers of the engine.

The MCP protocol (JSON-RPC over stdio: `initialize`, `ping`, `tools/list`, `tools/call`) is implemented in `src/server.js` without the MCP SDK, so the package has no dependencies.

## License

MIT for this software, see [LICENSE](LICENSE). Data returned by the API is provided under the Zentria Flow Terms of Service: https://zentriaflow.com/terms

Zentria Flow, Inc. · support@zentriaflow.com
