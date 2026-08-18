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
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=server-build /app/dist ./dist
COPY --from=web-build /app/web/dist ./web-dist

ENV STATIC_DIR=/app/web-dist
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "dist/server/index.js"]
