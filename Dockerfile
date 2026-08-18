# syntax=docker/dockerfile:1

# --- Stage 1: build the web SPA ---------------------------------------------
FROM node:22-alpine AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Stage 2: build the server ----------------------------------------------
FROM node:22-alpine AS server-build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build

# --- Stage 3: runtime --------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=server-build /app/dist ./dist
COPY --from=web-build /app/web/dist ./web-dist
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV STATIC_DIR=/app/web-dist
ENV PORT=8080
EXPOSE 8080

# The /data volume (and root-owned WORKDIR) aren't chowned to the `node` user
# by Fly/Docker, so we start as root, let entrypoint.sh chown the data dir,
# then drop to `node` via su-exec before exec'ing the real process -- see #19.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
