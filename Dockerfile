# zentria-flow-mcp: MCP server for US tariff layers (stdio).
# Zero dependencies, so the image is just Node and the source.
FROM node:20-alpine
WORKDIR /app
COPY package.json README.md LICENSE server.json ./
COPY src ./src
ENV NODE_ENV=production
# Optional: ZENTRIA_API_KEY (only the landed_cost tool needs it), ZENTRIA_API_BASE.
USER node
ENTRYPOINT ["node", "src/index.js"]
