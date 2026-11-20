# Installing zentria-flow-mcp (instructions for AI coding agents such as Cline)

Zentria Flow gives an assistant US import duty for an HTS code and country of origin: every tariff layer (MFN, China Section 301, the forced-labor Section 301 tariff, Section 232, Section 338 on Canada), the total, and changes already scheduled. Results are planning estimates, not customs rulings.

There are two ways to set it up. Pick option A unless the user asks for a local server or for the `landed_cost` tool.

## Option A: remote server (nothing to install)

Add a remote MCP server of type Streamable HTTP. No API key is needed.

```json
{
  "mcpServers": {
    "zentria-flow": {
      "type": "streamableHttp",
      "url": "https://zentriaflow.com/mcp"
    }
  }
}
```

The remote server offers three tools: `us_tariff_check`, `compare_origins` and `hts_search`. All remote users share 300 tariff checks and 1,500 searches an hour.

## Option B: local server (Node.js 18 or newer)

The server has no dependencies. npx runs it straight from GitHub:

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

- The first run downloads the repository, which takes a few seconds.
- The local server has the same three keyless tools plus `landed_cost`.
- `landed_cost` needs an API key from zentriaflow.com. Ask the user for it, then add `"env": { "ZENTRIA_API_KEY": "<their key>" }` to the entry. Never invent a key. Leave it out if the user has none; the other three tools work without it.

## Check that it works

Call `us_tariff_check` with `hts` = `6109.10.00` and `origin` = `CN`. The answer lists each tariff layer, the total and the date checked. If a tool returns a rate-limit message, wait and try again later.

## Notes for the agent

- Do not state US tariff rates from memory once this server is connected; call the tools.
- `hts_search` finds 8-digit HTSUS lines from product words. A search hit is a candidate, not a classification ruling. Confirm the code with the user.
