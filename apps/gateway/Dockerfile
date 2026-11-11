# ModelOps inference gateway. Build context: the repository root (it needs the pnpm workspace).
#   docker build -f apps/gateway/Dockerfile -t modelops/gateway:dev .   (pnpm dev:up does this)
FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
RUN npm install -g pnpm@12.16.1 --no-fund --no-audit
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/

# ---- build: compile TypeScript --------------------------------------------------------------
FROM base AS build
RUN pnpm install --frozen-lockfile --filter @modelops/gateway
COPY tsconfig.base.json ./
COPY apps/gateway apps/gateway
RUN pnpm --filter @modelops/gateway build

# ---- prod dependencies only ----------------------------------------------------------------
FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter @modelops/gateway

# ---- runtime --------------------------------------------------------------------------------
FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/gateway/node_modules ./apps/gateway/node_modules
COPY --from=build /repo/apps/gateway/dist ./apps/gateway/dist
COPY apps/gateway/package.json ./apps/gateway/
WORKDIR /repo/apps/gateway
USER node
LABEL org.opencontainers.image.vendor=modelops \
      org.opencontainers.image.title=modelops-gateway
EXPOSE 8080 8081
CMD ["node", "--enable-source-maps", "dist/main.js"]
