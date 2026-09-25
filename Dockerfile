# PlexTogether — production image (Next.js + room WebSockets, one process).
# Build: docker build -t plextogether .
# Run:   see docker-compose.yml and docs/DEPLOY-SYNOLOGY.md

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# The custom server (server.ts + room code) is compiled to one plain JS file at build
# time (npm run build → esbuild), so nothing TypeScript runs here. Next.js still reads
# next.config.ts itself.
# Next.js writes its cache under .next at runtime, so the app user must own it
# (as in Next.js's own Docker example); everything else stays read-only root.
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/dist ./dist
COPY next.config.ts ./
# Files keep the permissions they had on the host (a NAS copy can end up owner-only),
# so make the app's files world-readable; the app user can't read them otherwise.
RUN chmod -R a+rX /app/public /app/dist /app/next.config.ts
# Saved (encrypted) sessions and rooms live here — mount a volume.
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/robots.txt >/dev/null || exit 1
CMD ["node", "dist/server.cjs", "--production"]
