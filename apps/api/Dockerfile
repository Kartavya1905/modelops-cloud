# ModelOps management API + deploy worker (M10: one image, two commands). Build context: repo root.
#   docker build -f apps/api/Dockerfile -t modelops/api:dev .   (pnpm kind:up does this)
# API:    node dist/main.js     Worker: node dist/worker.js
# Migrations are not run from this image: `pnpm kind:up` applies them from the host first.
FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
RUN npm install -g pnpm@12.16.1 --no-fund --no-audit
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/

# ---- build: Prisma client + TypeScript --------------------------------------------------------
FROM base AS build
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/
RUN pnpm install --frozen-lockfile --filter @modelops/api
COPY tsconfig.base.json ./
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
# The generated client (src/generated/prisma) is compiled into dist/ with the rest.
RUN pnpm --filter @modelops/api exec prisma generate && pnpm --filter @modelops/api build

# ---- prod dependencies only (no install scripts: prisma generate already ran in `build`) ------
FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @modelops/api

# ---- runtime ----------------------------------------------------------------------------------
FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/
WORKDIR /repo/apps/api
USER node
LABEL org.opencontainers.image.vendor=modelops \
      org.opencontainers.image.title=modelops-api
EXPOSE 4000
CMD ["node", "--enable-source-maps", "dist/main.js"]
