# ---- Stage 1: compile the TypeScript ---------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: the docs server -------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only, installed first so they're cached between builds
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY public ./public
COPY starter ./starter

# The spec lives in /data so it survives container rebuilds
RUN mkdir -p /data && chown node:node /data
USER node

ENV PORT=8080 \
    SPEC_PATH=/data/openapi.yaml

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "dist/server.js"]
