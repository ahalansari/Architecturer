# Architecturer remote MCP server (OAuth + personal tokens, live viewer, download links).
# docker run -p 5178:5178 -v ./data:/data -e ARCHITECTURER_PUBLIC_URL=https://arch.example.com aalansari/architecturer
# then open /setup with the setup code from `docker logs`.
# Settings: README, "Remote MCP server". compose.yaml runs it behind a Cloudflare Tunnel.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# skip "prepare" (tsc) until the sources are copied; no production dependency has install scripts
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5178 \
    ARCHITECTURER_WORKDIR=/data/plans \
    ARCHITECTURER_STATE=/data/state \
    ARCHITECTURER_CACHE=/data/cache \
    ARCHITECTURER_WORKERS=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY bin ./bin
COPY viewer ./viewer
COPY examples ./examples
# Unraid's nobody:users (99:100) owns appdata shares
RUN mkdir -p /data/plans /data/state /data/cache && chown -R 99:100 /data
USER 99:100
VOLUME ["/data"]
EXPOSE 5178
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5178)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/mcp/http.js"]
