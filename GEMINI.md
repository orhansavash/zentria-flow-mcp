# Zentria Flow (US tariff tools)

Three tools from the remote server https://zentriaflow.com/mcp, no API key needed:

- `us_tariff_check`: total US duty for one HTS code and country of origin, with every layer (MFN, Section 301, Section 232, Section 338, forced-labor tariff) and scheduled changes.
- `compare_origins`: the same code priced from several origins side by side.
- `hts_search`: find HTSUS lines from a product description.

Results are estimates for planning, not customs rulings. Quote the total and the layers the tool returns; do not add or recompute rates. Shared keyless use is rate limited.
