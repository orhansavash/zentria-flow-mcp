# zentria-flow-mcp: MCP server for US tariff layers (stdio).
# Zero dependencies, so the image is just Node and the source.
FROM node:20-alpine
# The MCP Registry checks this label to prove the image belongs to the server
# named in server.json. It must stay equal to "name" there.
LABEL io.modelcontextprotocol.server.name="io.github.orhansavash/zentria-flow-mcp"
# Links the image on ghcr.io to this repository.
LABEL org.opencontainers.image.source="https://github.com/orhansavash/zentria-flow-mcp" \
      org.opencontainers.image.title="zentria-flow-mcp" \
      org.opencontainers.image.description="MCP server for Zentria Flow: US tariff layers by HTS code and origin, origin comparison, HTSUS search and landed cost." \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY package.json README.md LICENSE server.json ./
COPY src ./src
ENV NODE_ENV=production
# Optional: ZENTRIA_API_KEY (only the landed_cost tool needs it), ZENTRIA_API_BASE.
USER node
ENTRYPOINT ["node", "src/index.js"]
