# NEXA api — Hono on node:22-alpine (same shape as toolbox-api).
# Build context: monorepo root.
# Boot: runs node dist/migrate.js (idempotent, no-op when DATABASE_URL unset)
# then exec node dist/index.js.

FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared-zod/package.json packages/shared-zod/
RUN pnpm install --frozen-lockfile --filter @nexa/api... --filter @nexa/shared-zod...
COPY packages/shared-zod packages/shared-zod
COPY apps/api apps/api
# Sprint 15 — shared-zod now ships a JS dist; build it before the api so the
# api's compiled output can resolve @nexa/shared-zod at runtime.
RUN pnpm --filter @nexa/shared-zod build
RUN pnpm --filter @nexa/api build
# Keep the production dependency pass in the same stage as the build. A
# separate deps stage lets BuildKit run two large pnpm installs in parallel on
# the shared VPS runner, which has repeatedly ended in buildkit EOF failures.
RUN pnpm install --frozen-lockfile --prod --filter @nexa/api... --filter @nexa/shared-zod...

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Sprint 17 F069 — non-root runtime user. Node's official image does not set
# one; container escape risk is mitigated by dropping privileges before CMD.
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/src/db/migrations ./apps/api/dist/db/migrations
# Sprint 15 — copy shared-zod's JS dist + package.json + its own node_modules
# so the workspace symlink (apps/api/node_modules/@nexa/shared-zod) resolves to
# a real package with its zod dependency at runtime.
COPY --from=build /repo/packages/shared-zod/node_modules ./packages/shared-zod/node_modules
COPY --from=build /repo/packages/shared-zod/dist ./packages/shared-zod/dist
COPY --from=build /repo/packages/shared-zod/package.json ./packages/shared-zod/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/api/entrypoint.sh ./apps/api/entrypoint.sh
RUN chmod 755 ./apps/api/entrypoint.sh
USER nodejs
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=3s --retries=6 \
  CMD wget -qO- http://127.0.0.1:8090/healthz | grep -q '"ok":true' || exit 1
WORKDIR /app/apps/api
CMD ["sh", "./entrypoint.sh"]
