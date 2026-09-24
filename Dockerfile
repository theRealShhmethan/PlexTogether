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
# server.ts runs through tsx and imports src/lib (with "@/..." paths from tsconfig.json).
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY server.ts next.config.ts tsconfig.json ./
COPY src ./src
# Saved (encrypted) sessions and rooms live here — mount a volume.
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/robots.txt >/dev/null || exit 1
CMD ["npx", "--no-install", "tsx", "server.ts", "--production"]
