# ModelOps web console (Next.js). Build context: the repository root (pnpm workspace).
#   docker build -f apps/web/Dockerfile -t modelops/web:dev .   (pnpm kind:up does this)
# The browser calls /api/* on the web origin and Next.js forwards it to the API (docs/02 §7).
# That forward target is fixed at build time (Next writes rewrites into its routes manifest),
# hence the build argument; the default is the API's Service name inside the cluster.
#
# M11: Next.js "standalone" output. The runtime image holds only the server and the files it was
# traced to need (no full node_modules, no pnpm): see the M11 doc for the size before and after.
FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
RUN npm install -g pnpm@12.16.1 --no-fund --no-audit
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/api-contract/package.json packages/api-contract/
ARG MO_API_URL=http://api:4000
ENV MO_API_URL=${MO_API_URL} NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
RUN pnpm install --frozen-lockfile --filter "@modelops/web..."
COPY tsconfig.base.json ./
COPY packages/api-contract packages/api-contract
COPY apps/web apps/web
RUN pnpm --filter @modelops/web build

# ---- runtime ----------------------------------------------------------------------------------
FROM node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3300 HOSTNAME=0.0.0.0
WORKDIR /app
# server.js + traced dependencies, laid out like the monorepo (apps/web/server.js)
COPY --from=build /repo/apps/web/.next/standalone ./
# static assets are not part of the trace; the server serves them from here
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
LABEL org.opencontainers.image.vendor=modelops \
      org.opencontainers.image.title=modelops-web
EXPOSE 3300
# .next/cache must be writable (an emptyDir on Kubernetes, a task volume on ECS)
CMD ["node", "apps/web/server.js"]
