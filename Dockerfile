# Playwright's official image ships Chromium + system fonts + system deps,
# which saves ~5 minutes of apt install pain. Pinned by major version.
FROM mcr.microsoft.com/playwright:v1.49.1-noble AS builder

ENV NODE_ENV=production \
    CRAWLEE_STORAGE_DIR=/tmp/crawlee

WORKDIR /app

# Install deps separately for layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# Build TS -> dist
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev


FROM mcr.microsoft.com/playwright:v1.49.1-noble

ENV NODE_ENV=production \
    CRAWLEE_STORAGE_DIR=/tmp/crawlee \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Drop root for runtime. The Playwright image ships a `pwuser` account
# preconfigured with the browser sandbox bits.
RUN mkdir -p /tmp/crawlee && chown -R pwuser:pwuser /tmp/crawlee /app
USER pwuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/health || exit 1

CMD ["node", "dist/server.js"]
